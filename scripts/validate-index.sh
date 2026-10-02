#!/usr/bin/env bash
# Validate a generated index.json. Fails loudly on anything that previously
# degraded the index silently (C-quoted non-ASCII paths, malformed ids,
# duplicates, an unexpectedly small package count).
#   usage: bash scripts/validate-index.sh [index.json]
set -uo pipefail

INDEX=${1:-index.json}
LINE_RE='^{"id":"[^."][^"]*\.[^"]*","v":"[^"]*"}$'
MIN_PACKAGES=${MIN_PACKAGES:-15000}

fail() { echo "!! $*" >&2; exit 1; }

[ -s "$INDEX" ] || fail "$INDEX missing or empty"
count=$(wc -l < "$INDEX")
echo "validating $INDEX: $count packages"

[ "$count" -ge "$MIN_PACKAGES" ] || fail "only $count packages (expected >= $MIN_PACKAGES)"

bad=$(grep -vn "$LINE_RE" "$INDEX" | head -5)
[ -z "$bad" ] || fail "malformed index lines:"$'\n'"$bad"

[ "$(LC_ALL=C sort -u "$INDEX" | wc -l)" = "$count" ] || fail "duplicate ids"

grep -q '\\[0-7][0-7][0-7]' "$INDEX" && fail "C-quoted paths — core.quotePath=false not applied"

echo "ok"
