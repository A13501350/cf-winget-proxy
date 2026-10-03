// Hit-rate guard for the index that the Worker searches. Runs on the runner
// with plain node, against the freshly built index.json, and asks the one
// question a rebuild can silently get wrong: does the feed still carry the
// fields the search needs? A coverage drop here is what makes real queries come
// back empty (there is no fallback source any more).
//
// indexSearch() mirrors keywordSearch() in src/index.ts: case-insensitive
// exact/startsWith/substring over PackageIdentifier, Moniker, PackageName and
// Tags, plus an exact match on the punctuation-stripped id (the shape winget
// uses for NormalizedPackageNameAndPublisher). Mirroring it deliberately: this
// test must fail when the index loses a field the Worker reads, even though the
// Worker code itself is unchanged.
//   CI: node test_index_search.mjs
import assert from "node:assert";
import { readFileSync } from "node:fs";

const entries = readFileSync(new URL("./index.json", import.meta.url), "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

const normalizeTerm = (s) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

const FIELDS = ["id", "m", "n", "t"];

function quality(value, kw) {
  const v = value.toLowerCase();
  if (v === kw) return 0;
  if (v.startsWith(kw)) return 1;
  if (v.includes(kw)) return 2;
  return null;
}

// Ranked like the Worker: match quality first, field second.
function indexSearch(keyword) {
  const kw = keyword.toLowerCase().trim();
  if (!kw) return [];
  const nkw = normalizeTerm(kw);
  const hits = [];
  for (const e of entries) {
    if (!e.v) continue;
    let rank = -1;
    FIELDS.forEach((field, fi) => {
      const values = field === "t" ? e.t ?? [] : [e[field]].filter(Boolean);
      for (const value of values) {
        const q = quality(value, kw);
        if (q === null) continue;
        const candidate = q * 4 + fi;
        if (rank < 0 || candidate < rank) rank = candidate;
      }
    });
    if (rank < 0 && nkw && normalizeTerm(e.id) === nkw) rank = 0;
    if (rank >= 0) hits.push({ e, rank });
  }
  return hits
    .sort((a, b) => a.rank - b.rank || a.e.id.localeCompare(b.e.id))
    .map((h) => h.e);
}

// 1. shape of every entry: a dotted id, a non-empty version, and field types
// the Worker indexes by.
for (const e of entries) {
  assert.ok(/^[^."].*\.[^"]+$/.test(e.id), `malformed id: ${JSON.stringify(e)}`);
  assert.ok(e.v && e.v.trim().length, `empty version: ${JSON.stringify(e)}`);
  assert.ok(!/\\\d{3}/.test(e.id), `C-quoted id: ${JSON.stringify(e)}`);
  if (e.m !== undefined) assert.ok(typeof e.m === "string" && e.m.trim(), `empty moniker: ${e.id}`);
  if (e.n !== undefined) assert.ok(typeof e.n === "string" && e.n.trim(), `empty name: ${e.id}`);
  if (e.t !== undefined) assert.ok(Array.isArray(e.t) && e.t.length && e.t.every((t) => typeof t === "string" && t.trim()), `bad tags: ${e.id}`);
}
console.log(`✅ ${entries.length} entries, all well-formed`);

// 2. coverage floors. These are what the official feed currently carries; a
// rebuild that loses a column (or the tags join) trips one of them.
const withMoniker = entries.filter((e) => e.m).length;
const withTags = entries.filter((e) => e.t).length;
const withName = entries.filter((e) => e.n).length;
assert.ok(entries.length >= 15000, `only ${entries.length} packages in the index`);
assert.ok(withName >= 14000, `only ${withName} packages carry a PackageName`);
assert.ok(withMoniker >= 5000, `only ${withMoniker} packages carry a Moniker`);
assert.ok(withTags >= 10000, `only ${withTags} packages carry Tags`);
console.log(`✅ coverage: ${withName} named, ${withMoniker} monikered, ${withTags} tagged`);

// 3. every query shape winget sends must be answered from the index. The
// moniker/tag rows are the ones a git-paths index could never answer, which is
// the reason the index now comes from the official feed.
const mustHit = [
  ["git", "Git.Git"],                          // id substring
  ["chrome", "Google.Chrome"],                 // id substring
  ["ffmpeg", "BtbN.FFmpeg.GPL"],               // id substring
  ["miniconda", "Anaconda.Miniconda3"],        // id substring
  ["djiassistant2", "DJI.DJIAssistant2.ForPhantom"],
  ["electron", "OpenJS.Electron.33"],
  ["brötje", "BRÖTJE.ProfiTool"],              // non-ASCII publisher
  ["cartero", "DaniRodríguez.Cartero"],        // non-ASCII publisher
  ["registryviewer", "AccessData.RegistryViewer"],
  ["notepad", "Notepad++.Notepad++"],          // name substring
  ["vlc", "VideoLAN.VLC"],                     // moniker exact
  ["7zip", "7zip.7zip"],                       // moniker exact, lowercased publisher
  ["vscode", "Microsoft.VisualStudioCode"],    // moniker exact, id does NOT contain it
  ["sqlite3", "SQLite.SQLite"],                // tag exact, id/name do not contain it
  ["media player", "VideoLAN.VLC"],            // spaced display name
];
for (const [kw, expectId] of mustHit) {
  const found = indexSearch(kw).map((e) => e.id);
  assert.ok(found.includes(expectId), `"${kw}" did not return ${expectId} (got ${found.length} results)`);
}
console.log(`✅ ${mustHit.length} keyword queries answered from the index`);

// 4. relevance. `vscode` is the query this tier exists for: Microsoft.VisualStudioCode
// matches only through its moniker, while ids that merely contain the string
// ("...CommandPalette-VSCode") match as a substring. Exact must outrank that.
const vscode = indexSearch("vscode").map((e) => e.id);
assert.equal(vscode[0], "Microsoft.VisualStudioCode", `"vscode" ranked ${vscode[0]} first`);
console.log("✅ vscode sorts Microsoft.VisualStudioCode first");

// 5. nothing is guessed at. A keyword that fits an id only as a character
// subsequence used to be answered by an "abbreviation" tier; that is how
// "sqlite3" once handed back SublimeText 3 — a row no field of the package
// explains, which `winget install` would then offer as if it were the answer.
for (const kw of ["sqblt3", "sqlte3", "zzqxvnope"]) {
  assert.equal(indexSearch(kw).length, 0, `"${kw}" was answered by guessing`);
}
console.log("✅ no scatter matches");

// 6. duplicate ids would make winget show the same package twice.
const seen = new Set();
for (const e of entries) {
  const key = e.id.toLowerCase();
  assert.ok(!seen.has(key), `duplicate id: ${e.id}`);
  seen.add(key);
}
console.log("✅ ids are unique");
