#!/usr/bin/env bash
# Unit test for scripts/index-parser.awk — runs the path parser against fixed
# manifest paths, no clone needed.  CI: bash scripts/test-index-parser.sh
set -uo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
fail=0

check() { # check <label> <actual> <expected>
  if [ "$2" = "$3" ]; then
    echo "ok   $1"
  else
    echo "FAIL $1: got [$2] want [$3]"
    fail=1
  fi
}

run() { printf '%s\n' "$@" | awk -f "$SCRIPT_DIR/index-parser.awk" | sort; }

latest_of() { run "$@" | grep -F "\"id\":\"$1\"" | sed 's/.*"v":"\([^"]*\)".*/\1/'; }

# 1. numeric version comparison must beat string comparison (1.10.0 > 1.9.0)
check "numeric version order" \
  "$(latest_of HandBrake.HandBrake \
      manifests/h/HandBrake/HandBrake/1.11.2/HandBrake.HandBrake.installer.yaml \
      manifests/h/HandBrake/HandBrake/1.9.0/HandBrake.HandBrake.installer.yaml)" \
  "1.11.2"

# 2. every manifest type resolves to the same identifier
check "locale manifest id" \
  "$(run manifests/m/Microsoft/Edge/1.2.3/Microsoft.Edge.locale.en-US.yaml | grep -c '"id":"Microsoft.Edge"')" \
  "1"
check "defaultLocale manifest id" \
  "$(run manifests/m/Microsoft/Edge/1.2.3/Microsoft.Edge.defaultLocale.yaml | grep -c '"id":"Microsoft.Edge"')" \
  "1"
check "version manifest id" \
  "$(run manifests/m/Microsoft/Edge/1.2.3/Microsoft.Edge.version.yaml | grep -c '"id":"Microsoft.Edge"')" \
  "1"

# 3. multi-component identifiers keep their dots (dir path uses slashes)
check "multi-component id" \
  "$(run manifests/o/OpenJS/Electron/33/3.3.0/OpenJS.Electron.33.installer.yaml | grep -c '"id":"OpenJS.Electron.33"')" \
  "1"

# 4. non-manifest and non-yaml files are ignored outright
check "ignores resources" \
  "$(run manifests/h/HandBrake/HandBrake/1.11.2/images/logo.png \
          manifests/h/HandBrake/HandBrake/1.11.2/README.md | wc -l | tr -d ' ')" \
  "0"
check "ignores mis-suffixed file" \
  "$(run manifests/h/HandBrake/HandBrake/1.11.2/HandBrake.HandBrake.package.validation.yaml | wc -l | tr -d ' ')" \
  "0"

# 5. the path must be the canonical {publisher}/{package…}/{version}/{file} layout,
#    i.e. it must reconstruct the same identifier as the filename
check "rejects missing version dir" \
  "$(run manifests/p/Pub/Pkg/Pub.Pkg.installer.yaml | wc -l | tr -d ' ')" \
  "0"
check "rejects file under a files/ subdir" \
  "$(run manifests/p/Pub/Pkg/1.0/files/Pub.Pkg.installer.yaml | wc -l | tr -d ' ')" \
  "0"

# 6. identifier without a publisher component is rejected (the old {"id":".package"} bug)
check "rejects publisher-less id" \
  "$(run manifests/a/Aa/Bb/1.0/.package.validation.yaml | wc -l | tr -d ' ')" \
  "0"

# 7. versions with letters/hyphens are still versions
check "suffix version accepted" \
  "$(latest_of zufuliu.notepad4 \
      manifests/z/zufuliu/notepad4/26.08r6282/zufuliu.notepad4.installer.yaml \
      manifests/z/zufuliu/notepad4/1.0.0-beta/zufuliu.notepad4.installer.yaml)" \
  "26.08r6282"

# 8. non-ASCII identifiers survive (requires core.quotePath=false upstream)
check "non-ascii id preserved" \
  "$(run 'manifests/b/BRÖTJE/ProfiTool/1.0.0/BRÖTJE.ProfiTool.installer.yaml' | grep -c 'BRÖTJE.ProfiTool')" \
  "1"

exit $fail
