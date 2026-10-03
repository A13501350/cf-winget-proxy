#!/usr/bin/env python3
"""Turn the official winget source package into this repo's index.json.

The input is source2.msix — the very file the winget client downloads to build
its default `winget` source — whose `Public/index.db` is a SQLite database
holding id / display name / moniker / latest version for every package plus the
tag, command and ARP match tables. Using it means the index is Microsoft's own
answer to "what packages exist and what are they called", instead of something
this repo reconstructs from the winget-pkgs file tree.

Output is NDJSON, one object per package, empty fields omitted:
    {"id":"VideoLAN.VLC","v":"3.0.24","n":"VLC media player","m":"vlc","t":["player"]}

Anything unexpected (missing archive entry, renamed column, duplicate id, no
version) is a hard failure: an index that quietly lost its moniker or tag
coverage looks identical to a good one until users cannot find packages.

    python3 scripts/index-from-msix.py <source2.msix> <out.json>
"""
import json
import os
import sqlite3
import sys
import tempfile
import zipfile

DB_ENTRY = "Public/index.db"
REQUIRED_COLUMNS = {"id", "name", "moniker", "latest_version"}


def open_db(msix_path: str) -> tuple[sqlite3.Connection, str]:
    """Extract the database from the package into a temp file, and open it."""
    try:
        archive = zipfile.ZipFile(msix_path)
    except zipfile.BadZipFile as exc:
        raise SystemExit(f"{msix_path} is not a zip/msix package: {exc}")
    with archive:
        if DB_ENTRY not in archive.namelist():
            raise SystemExit(
                f"{DB_ENTRY} is not in {msix_path}; it contains: "
                + ", ".join(sorted(n for n in archive.namelist() if not n.startswith("Assets/")))
            )
        fd, tmp_db = tempfile.mkstemp(suffix=".db", prefix="winget-index-")
        with os.fdopen(fd, "wb") as out, archive.open(DB_ENTRY) as src:
            while chunk := src.read(1 << 20):
                out.write(chunk)
    return sqlite3.connect(tmp_db), tmp_db


def rows_from(db: sqlite3.Connection) -> list:
    columns = {r[1] for r in db.execute("PRAGMA table_info(packages)")}
    missing = REQUIRED_COLUMNS - columns
    if missing:
        raise SystemExit(f"packages is missing column(s) {sorted(missing)}; got {sorted(columns)}")
    for table in ("tags2", "tags2_map"):
        if not db.execute("SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone()[0]:
            raise SystemExit(f"table {table} is gone; tag search would silently lose coverage")

    # json_quote keeps tags valid no matter what a maintainer put in a tag;
    # group_concat over the joined rowids avoids rebuilding that map in Python.
    query = """
        SELECT p.id, p.latest_version, p.name, p.moniker,
               (SELECT group_concat(json_quote(t.tag), ',')
                    FROM tags2_map m JOIN tags2 t ON t.rowid = m.tag
                   WHERE m.package = p.rowid)
          FROM packages p
         ORDER BY lower(p.id), p.id
    """
    return db.execute(query).fetchall()


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    msix_path, out_path = sys.argv[1], sys.argv[2]

    db, tmp_db = open_db(msix_path)
    try:
        rows = rows_from(db)
    finally:
        db.close()
        os.unlink(tmp_db)

    if not rows:
        raise SystemExit("packages is empty")

    seen, lines, tagged, monikered = set(), [], 0, 0
    for pkg_id, version, name, moniker, tags in rows:
        if not pkg_id or "." not in pkg_id:
            raise SystemExit(f"malformed package id from the source db: {pkg_id!r}")
        key = pkg_id.lower()
        if key in seen:
            raise SystemExit(f"duplicate package id: {pkg_id}")
        seen.add(key)
        if not version:
            # winget refuses a search result with no versions (0x8a150039).
            raise SystemExit(f"{pkg_id} has no latest_version in the source db")

        entry = {"id": pkg_id, "v": version}
        if name:
            entry["n"] = name
        if moniker:
            entry["m"] = moniker
            monikered += 1
        if tags:
            entry["t"] = json.loads(f"[{tags}]")
            tagged += 1
        lines.append(json.dumps(entry, ensure_ascii=False, separators=(",", ":")))

    with open(out_path, "w", encoding="utf-8", newline="\n") as out:
        out.write("\n".join(lines) + "\n")

    print(f"index-from-msix: {len(lines)} packages, {monikered} with moniker, {tagged} with tags -> {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
