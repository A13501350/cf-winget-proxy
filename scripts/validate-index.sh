#!/usr/bin/env bash
# Validate a generated index.json. Everything here is a check on the *content*
# of the official feed, because the failure mode that matters is a build that
# succeeds and quietly loses coverage: a schema change that empties the moniker
# or tag columns looks exactly like a good index until users cannot find packages.
#   usage: bash scripts/validate-index.sh [index.json]
set -uo pipefail

INDEX=${1:-index.json}
MIN_PACKAGES=${MIN_PACKAGES:-15000}
MIN_WITH_NAME=${MIN_WITH_NAME:-14000}
MIN_WITH_MONIKER=${MIN_WITH_MONIKER:-5000}
MIN_WITH_TAGS=${MIN_WITH_TAGS:-10000}

[ -s "$INDEX" ] || { echo "!! $INDEX missing or empty" >&2; exit 1; }

# `python3` on a Windows box is often the Microsoft Store alias stub, which
# prints nothing and fails; probe the interpreters instead of assuming.
PY=""
for c in python3 python py; do
  command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sqlite3, zipfile' >/dev/null 2>&1 && { PY="$c"; break; }
done
[ -n "$PY" ] || { echo "!! a python with sqlite3 and zipfile is required" >&2; exit 1; }

INDEX="$INDEX" MIN_PACKAGES="$MIN_PACKAGES" MIN_WITH_NAME="$MIN_WITH_NAME" \
MIN_WITH_MONIKER="$MIN_WITH_MONIKER" MIN_WITH_TAGS="$MIN_WITH_TAGS" \
"$PY" - <<'PY'
import json, os, re, sys

index, env = os.environ["INDEX"], os.environ
def floor(key): return int(env[key])
fail = lambda msg: sys.exit(f"!! {msg}")

entries, lines = [], open(index, encoding="utf-8").read().splitlines()
for n, line in enumerate(lines, 1):
    try:
        e = json.loads(line)
    except ValueError as exc:
        fail(f"line {n} is not JSON ({exc}): {line[:120]}")
    if not isinstance(e, dict):
        fail(f"line {n} is not an object: {line[:120]}")
    unknown = set(e) - {"id", "v", "n", "m", "t"}
    if unknown:
        fail(f"line {n} has unexpected key(s) {sorted(unknown)}")
    pkg_id, version = e.get("id"), e.get("v")
    if not isinstance(pkg_id, str) or not re.fullmatch(r'[^.][^"]*\.[^"]+', pkg_id or ""):
        fail(f"line {n} has a malformed id: {pkg_id!r}")
    if not isinstance(version, str) or not version:
        fail(f"{pkg_id} has an empty version")
    for key in ("n", "m"):
        if key in e and (not isinstance(e[key], str) or not e[key]):
            fail(f"{pkg_id} has an empty or non-string {key}")
    if "t" in e:
        tags = e["t"]
        if not isinstance(tags, list) or not tags or not all(isinstance(t, str) and t for t in tags):
            fail(f"{pkg_id} has a bad tag list: {json.dumps(tags)[:120]}")
    entries.append(e)

count = len(entries)
print(f"validating {index}: {count} packages")
if count < floor("MIN_PACKAGES"):
    fail(f"only {count} packages (expected >= {floor('MIN_PACKAGES')})")

for key, attr, label in (
    ("MIN_WITH_NAME", "n", "display names"),
    ("MIN_WITH_MONIKER", "m", "monikers"),
    ("MIN_WITH_TAGS", "t", "tag lists"),
):
    have = sum(1 for e in entries if attr in e)
    if have < floor(key):
        fail(f"only {have} {label} (expected >= {floor(key)}) — the source schema moved under us")

lowered = [e["id"].lower() for e in entries]
if len(set(lowered)) != len(lowered):
    dupes = sorted({i for i in lowered if lowered.count(i) > 1})[:5]
    fail(f"duplicate ids (case-insensitive): {dupes}")

print(f"ok ({sum(1 for e in entries if 'm' in e)} moniker, {sum(1 for e in entries if 't' in e)} tagged)")
PY
