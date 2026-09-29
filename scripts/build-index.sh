#!/usr/bin/env bash
#
# Build a lightweight winget package index (id + latest version) and write it
# to index.json (JSONL, one `{"id":...,"v":...}` per line).
#
# Approach: blobless + shallow clone of microsoft/winget-pkgs, then enumerate
# the manifest tree with `git ls-tree` (no file contents downloaded) and parse
# the paths with awk. Fast and dependency-free (git + awk ship on the runner).
set -euo pipefail

REPO_URL="https://github.com/microsoft/winget-pkgs.git"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "==> Cloning $REPO_URL (blobless, shallow, no checkout) ..."
git clone --filter=blob:none --depth 1 --no-checkout "$REPO_URL" "$TMP/repo"

echo "==> Enumerating manifests ..."
git -C "$TMP/repo" ls-tree -r HEAD --name-only -- 'manifests/' \
  | awk '
    # numeric version comparison: 1.10.0 > 1.9.0, unlike string compare
    function vcmp(a, b,   na, nb, n, i, x, y) {
      split(a, na, ".");
      split(b, nb, ".");
      n = (length(na) > length(nb)) ? length(na) : length(nb);
      for (i = 1; i <= n; i++) {
        x = (i in na) ? na[i] + 0 : 0;
        y = (i in nb) ? nb[i] + 0 : 0;
        if (x > y) return 1;
        if (x < y) return -1;
      }
      return 0;
    }
    {
      nf = split($0, f, "/");
      if (f[1] != "manifests") next;
      # versioned manifest: manifests/{l}/{Publisher}/{PackageIdentifier}/{Version}/{file}
      # f[4] is already the full PackageIdentifier (e.g. "HandBrake.HandBrake")
      if (nf >= 6) {
        id = f[4];
        ver = f[5];
        if ((id in latest) == 0 || vcmp(ver, latest[id]) > 0) latest[id] = ver;
      }
    }
    END {
      for (id in latest) {
        gsub(/"/, "\\\"", id);
        printf "{\"id\":\"%s\",\"v\":\"%s\"}\n", id, latest[id];
      }
    }
  ' | sort > index.json

echo "==> Wrote index.json ($(wc -l < index.json) packages)"
