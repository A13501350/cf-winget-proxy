#!/usr/bin/env bash
#
# Build index.json — the package list the Worker searches.
#
# Source: source2.msix, the package the winget client itself downloads for the
# default `winget` source. Its inner SQLite db already carries id, display name,
# moniker, latest version and tags for every published package, so the index is
# Microsoft's own answer to those questions rather than something this repo
# infers from the winget-pkgs directory tree.
#
# That replaced a blobless shallow clone of winget-pkgs plus an awk path parser.
# The clone had two failure modes that both put live traffic back on the GitHub
# API: `git ls-tree` C-quotes paths with non-ASCII bytes (whole publishers went
# missing until `-c core.quotePath=false`), and recovering the id from path
# components rather than the manifest filename invented packages that do not
# exist. Neither is possible when no paths are parsed at all, and version
# selection is no longer ours to get wrong either.
#
# Cost: this feed lags winget-pkgs master in both directions (measured 2026-10-03:
# 26 packages it has that a same-day clone lacked, 2 it lacks that master has),
# and a version it lists can in principle have been removed from master since —
# which the Worker answers with a 404, as everywhere else in this design.
#
# Requires curl and a python with sqlite3+zipfile in its stdlib (both ship on
# the GitHub runner).
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
SOURCE_MSIX=${SOURCE_MSIX:-https://cdn.winget.microsoft.com/cache/source2.msix}
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# `python3` on a Windows box is often the Microsoft Store alias stub, which
# prints nothing and fails; probe instead of assuming.
PY=""
for c in python3 python py; do
  command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sqlite3, zipfile' >/dev/null 2>&1 && { PY="$c"; break; }
done
[ -n "$PY" ] || { echo "!! a python with sqlite3 and zipfile is required" >&2; exit 1; }

echo "==> Downloading $SOURCE_MSIX"
curl -fsSL --retry 3 --retry-delay 5 -o "$TMP/source2.msix" "$SOURCE_MSIX"
echo "    $(wc -c < "$TMP/source2.msix") bytes"

echo "==> Building index.json"
"$PY" "$SCRIPT_DIR/index-from-msix.py" "$TMP/source2.msix" index.json

bash "$SCRIPT_DIR/validate-index.sh" index.json
