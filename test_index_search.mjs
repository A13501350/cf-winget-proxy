// Tests the index-backed search backend against the real index.json, i.e. the
// path that must answer WITHOUT any api.github.com call. A miss here is what
// pushes traffic onto the rate-limited Contents API, so every well-known keyword
// must hit.
//   CI: node test_index_search.mjs
import assert from "node:assert";
import { readFileSync } from "node:fs";

const entries = readFileSync(new URL("./index.json", import.meta.url), "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

const normalizeTerm = (s) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

// Mirrors keywordSearch()'s index branch in src/index.ts.
function indexSearch(keyword) {
  const kw = keyword.toLowerCase();
  const nkw = normalizeTerm(kw);
  const out = [];
  for (const e of entries) {
    if (!e.v) continue;
    if (e.id.toLowerCase().includes(kw) || (nkw.length > 1 && normalizeTerm(e.id).includes(nkw))) {
      out.push(e);
    }
  }
  return out;
}

// 1. shape of every entry: a dotted id and a non-empty version
for (const e of entries) {
  assert.ok(/^[^."].*\.[^"]+$/.test(e.id), `malformed id: ${JSON.stringify(e)}`);
  assert.ok(e.v && e.v.trim().length, `empty version: ${JSON.stringify(e)}`);
  assert.ok(!/\\\d{3}/.test(e.id), `C-quoted id: ${JSON.stringify(e)}`);
}
console.log(`✅ ${entries.length} entries, all well-formed`);

// 2. the queries that used to fall through to directory enumeration
const mustHit = [
  ["git", "Git.Git"],
  ["firefox", "Mozilla.Firefox"],
  ["notepad", "Notepad++.Notepad++"],
  ["chrome", "Google.Chrome"],
  ["ffmpeg", "BtbN.FFmpeg.GPL"],
  ["miniconda", "Anaconda.Miniconda3"],
  ["djiassistant2", "DJI.DJIAssistant2.ForPhantom"],
  ["electron", "OpenJS.Electron.33"],
  ["brötje", "BRÖTJE.ProfiTool"],        // non-ASCII publisher: was missing entirely
  ["cartero", "DaniRodríguez.Cartero"],
  ["registryviewer", "AccessData.RegistryViewer"],
];
for (const [kw, expectId] of mustHit) {
  const found = indexSearch(kw).map((e) => e.id);
  assert.ok(found.includes(expectId), `"${kw}" did not return ${expectId} (got ${found.length} results)`);
}
console.log(`✅ ${mustHit.length} keyword queries answered from the index`);

// 3. junk ids from the old index must never be emitted
for (const junk of [".package", ".validation"]) {
  assert.ok(!entries.some((e) => e.id === junk), `index still contains ${junk}`);
}
console.log("✅ no publisher-less ids");
