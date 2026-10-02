#!/usr/bin/env bash
#
# Build a lightweight winget package index (id + latest version) and write it
# to index.json (JSONL, one `{"id":...,"v":...}` per line).
#
# Approach: blobless + shallow clone of microsoft/winget-pkgs, then enumerate
# the manifest tree with `git ls-tree` (no file contents downloaded) and parse
# the paths with awk. Fast and dependency-free (git + awk ship on the runner).
#
# Two things this script previously got wrong, both of which pushed live traffic
# back onto the GitHub API:
#  - `git ls-tree` C-quotes any path containing a non-ASCII byte, so
#    `-c core.quotePath=false` is required. Without it, publishers like BRÖTJE or
#    DaniRodríguez came out as escape sequences ("BR\303\226TJE") and were
#    effectively missing from the index — 10 publishers in total.
#  - The id must be recovered from the manifest FILENAME only. Trusting path
#    components produced junk entries such as {"id":".package","v":"GDK"}, which
#    winget then received as search results.
#
# The path parser lives in index-parser.awk so it can be unit-tested without
# cloning the repository (see scripts/test-index-parser.sh). The awk is
# deliberately mawk-compatible (GitHub runners ship mawk, not gawk): no
# match-with-array, no gensub, no length(array).
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_URL="https://github.com/microsoft/winget-pkgs.git"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "==> Cloning $REPO_URL (blobless, shallow, no checkout) ..."
git clone --filter=blob:none --depth 1 --no-checkout "$REPO_URL" "$TMP/repo"

echo "==> Enumerating manifests ..."
git -C "$TMP/repo" -c core.quotePath=false ls-tree -r HEAD --name-only -- 'manifests/' \
  | LC_ALL=C.UTF-8 awk -f "$SCRIPT_DIR/index-parser.awk" \
  | LC_ALL=C.UTF-8 sort > index.json

bash "$SCRIPT_DIR/validate-index.sh" index.json
