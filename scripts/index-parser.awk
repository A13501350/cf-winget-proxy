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
    # PackageIdentifier implied by a manifest filename, or "" when the file is not
    # one of the four canonical manifest types. The identifier itself contains
    # dots, so each manifest-type suffix is stripped anchored at the end.
    function idFromName(fn,   p, tag) {
      if (fn !~ /\.yaml$/) return "";
      sub(/.*\//, "", fn)
      sub(/\.yaml$/, "", fn);
      if (sub(/\.installer$/, "", fn)) return fn;
      if (sub(/\.version$/, "", fn)) return fn;
      if (sub(/\.defaultLocale$/, "", fn)) return fn;
      p = index(fn, ".locale.");
      if (p > 0) {
        tag = substr(fn, p + 8);
        if (tag ~ /^[A-Za-z0-9-]+$/) return substr(fn, 1, p - 1);
        return "";
      }
      return "";
    }
    {
      name_id = idFromName($0);
      if (name_id == "") next;         # resources, README, images, ...

      # Canonical layout: manifests/{l}/{Publisher}/{package dots→slashes}/{Version}/{file}
      # so the path itself must reconstruct the same PackageIdentifier. Requiring
      # the two derivations to agree is what keeps junk out of the index; do NOT
      # pattern-match the version component, real ones include
      # "V1.33 - Rev. 87104" and "py310_23.5.2-0". Do NOT pattern-match the
      # identifier charset either: "&", "," and "!" legitimately occur
      # (Allen&Heath.AvantisDirector, IDMComputerSolutions,Inc.UltraEdit).
      nf = split($0, f, "/");
      if (f[1] != "manifests" || nf < 5) next;
      path_id = f[3];
      for (i = 4; i < nf - 1; i++) path_id = path_id "." f[i];
      if (path_id != name_id) next;

      ver = f[nf - 1];
      if (!(name_id in latest) || vcmp(ver, latest[name_id]) > 0) latest[name_id] = ver;
    }
    END {
      for (id in latest) {
        gsub(/"/, "\\\"", id);
        printf "{\"id\":\"%s\",\"v\":\"%s\"}\n", id, latest[id];
      }
    }
