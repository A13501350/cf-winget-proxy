// End-to-end guard for the search hot path: it drives the real Worker handler
// against the committed index.json and asserts two things — indexed queries
// never touch api.github.com (the whole point of the prebuilt index, and the
// only thing standing between a shared 60 req/h rate limit and total outage),
// and every returned row is explained by a real field value, i.e. we never
// answer a term that no field contains.
//   CI: node test_zero_github_calls.mjs
import assert from "node:assert";
import { readFileSync } from "node:fs";
import worker from "./.build-test/worker.mjs";

const INDEX_BODY = readFileSync(new URL("./index.json", import.meta.url));
const INDEX = INDEX_BODY.toString("utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const indexById = new Map(INDEX.map((e) => [e.id, e]));
const norm = (s) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

const seen = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  seen.push(url);
  if (url === "http://index.test/index.json") {
    return Promise.resolve(new Response(INDEX_BODY, { status: 200 }));
  }
  if (url.includes("api.github.com")) {
    // There is no code path that is allowed to reach the GitHub API. Anything
    // arriving here is a regression, so fail loudly instead of counting.
    throw new Error("unexpected GitHub API call: " + url);
  }
  return realFetch(input, init);
};

const env = {
  INDEX_URL: "http://index.test/index.json",
  MIRROR: "https://gh-proxy.org",
  GITHUB_TOKEN: undefined,
};

const search = async (body) => {
  const r = await worker.fetch(
    new Request("http://worker.test/manifestSearch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
    {}
  );
  return ((await r.json()) || {}).Data ?? [];
};

const githubCalls = () => seen.filter((u) => u.includes("api.github.com")).length;
const reset = () => { seen.length = 0; };

// What "explained" means here: the term must literally occur in one of the four
// index fields (id / moniker / name / tag). The client re-derives the 匹配 column
// itself, but only from what a REST search response carries — Id, Name and the
// system reference strings, never Moniker/Tag (see README 已知限制) — so this
// check guards against guessing, not against what that column prints. A row no
// field explains is a package `winget install <term>` would happily offer.
// Only the normalized comparison the client explicitly asks for may skip the
// literal check.
function assertExplainedByField(term, rows) {
  for (const d of rows) {
    const e = indexById.get(d.PackageIdentifier);
    assert.ok(e, `${term}: the Worker returned ${d.PackageIdentifier}, which is not in the index`);
    const fields = [e.id, e.n, e.m, ...(e.t ?? [])].filter(Boolean).map((v) => v.toLowerCase());
    const ok = fields.some((v) => v.includes(term.toLowerCase())) || norm(e.id) === norm(term);
    assert.ok(
      ok,
      `"${term}" returned ${d.PackageIdentifier} (name=${e.n} moniker=${e.m} tags=${(e.t ?? []).join("/")}), ` +
        `none of which contains it — a guessed row`
    );
  }
}

// ── 1. every query shape winget actually sends must be answered from the index ──
const cases = [
  {
    label: "keyword (Query)",
    kw: "firefox",
    body: { Query: { KeyWord: "firefox", MatchType: "Contains" } },
    expect: "Mozilla.Firefox",
  },
  {
    label: "moniker (winget install vscode)",
    kw: "vscode",
    body: { Inclusions: [{ PackageMatchField: "Moniker", RequestMatch: { KeyWord: "vscode", MatchType: "Exact" } }] },
    expect: "Microsoft.VisualStudioCode",
  },
  {
    // The query that used to be answered with a subsequence guess. It is now a
    // Tag field lookup, so the four packages the official source shows are ours.
    label: "tag (winget search sqlite3)",
    kw: "sqlite3",
    body: { Query: { KeyWord: "sqlite3", MatchType: "Contains" } },
    expect: "SQLite.SQLite",
  },
  {
    label: "keyword vlc",
    kw: "vlc",
    body: { Query: { KeyWord: "vlc", MatchType: "Contains" } },
    expect: "VideoLAN.VLC",
  },
  {
    label: "keyword 7zip",
    kw: "7zip",
    body: { Query: { KeyWord: "7zip", MatchType: "Contains" } },
    expect: "7zip.7zip",
  },
  {
    label: "display name",
    kw: "media player",
    body: { Query: { KeyWord: "media player", MatchType: "Contains" } },
    expect: "VideoLAN.VLC",
  },
  {
    label: "exact id (Filters)",
    body: { Filters: [{ PackageMatchField: "PackageIdentifier", RequestMatch: { KeyWord: "Git.Git", MatchType: "Exact" } }] },
    expect: "Git.Git",
  },
  {
    label: "lowercased id",
    body: { Filters: [{ PackageMatchField: "PackageIdentifier", RequestMatch: { KeyWord: "yt-dlp.ffmpeg", MatchType: "Exact" } }] },
    expect: "yt-dlp.FFmpeg",
  },
  {
    label: "ProductCode (dependency)",
    body: { Inclusions: [{ PackageMatchField: "ProductCode", RequestMatch: { KeyWord: "yt-dlp.ffmpeg_microsoft.winget.source_8wekyb3d8bbwe", MatchType: "Exact" } }] },
    expect: "yt-dlp.FFmpeg",
  },
  {
    label: "NormalizedPackageNameAndPublisher",
    kw: "ytdlpffmpeg",
    body: { Inclusions: [{ PackageMatchField: "NormalizedPackageNameAndPublisher", RequestMatch: { KeyWord: "ytdlpffmpeg", MatchType: "Exact" } }] },
    expect: "yt-dlp.FFmpeg",
  },
  {
    label: "non-ascii publisher",
    kw: "brötje",
    body: { Query: { KeyWord: "brötje", MatchType: "Contains" } },
    expect: "BRÖTJE.ProfiTool",
  },
];

for (const c of cases) {
  reset();
  const data = await search(c.body);
  assert.ok(data.length > 0, `${c.label}: empty Data`);
  if (c.expect) {
    assert.ok(data.some((d) => d.PackageIdentifier === c.expect), `${c.label}: ${c.expect} missing`);
  }
  for (const d of data) {
    assert.ok(d.PackageIdentifier && d.PackageName && d.Publisher, `${c.label}: missing required fields`);
    assert.ok((d.Versions ?? []).length && d.Versions[0].PackageVersion, `${c.label}: empty Versions`);
    // PackageName must be the real one from the feed, not a dotted id with the
    // dots turned into spaces — that is what winget prints as 名称.
    const e = indexById.get(d.PackageIdentifier);
    if (e?.n) assert.equal(d.PackageName, e.n, `${c.label}: ${d.PackageIdentifier} reported as "${d.PackageName}", not its real name "${e.n}"`);
  }
  if (c.kw) assertExplainedByField(c.kw, data);
  assert.equal(githubCalls(), 0, `${c.label}: made ${githubCalls()} GitHub API call(s)`);
  console.log(`✅ ${c.label}: ${data.length} result(s), 0 GitHub calls`);
}

// Ranking is not arbitrary: the exact moniker must beat the substring hits that
// share no part of the word, or `winget install vscode` picks the wrong package.
reset();
const ranked = await search({ Query: { KeyWord: "vscode", MatchType: "Contains" } });
assert.equal(ranked[0].PackageIdentifier, "Microsoft.VisualStudioCode", `"vscode" ranked ${ranked[0].PackageIdentifier} first`);
console.log("✅ vscode sorts Microsoft.VisualStudioCode first (moniker exact beats id substring)");

// ── 2. an index miss is reported as "nothing found", not guessed at ──
// The stub above throws on any api.github.com request, so this case failing with
// "unexpected GitHub API call" is exactly the regression it guards: a fallback
// creeping back in.
reset();
const missed = await search({ Query: { KeyWord: "zzqxvnope", MatchType: "Contains" } });
assert.equal(missed.length, 0, `index miss returned ${missed.length} result(s)`);
assert.equal(githubCalls(), 0, "index miss reached the GitHub API");
console.log("✅ index miss: 0 result(s), 0 GitHub calls");

// ── 2b. same for a manifest request with no version and no index entry ──
reset();
const missing = await worker.fetch(
  new Request("http://worker.test/packageManifests/NoSuchPublisher.NoSuchPackage"), env, {}
);
assert.equal(missing.status, 404, `expected fail-close 404, got ${missing.status}`);
assert.equal(githubCalls(), 0, "missing manifest reached the GitHub API");
console.log("✅ packageManifests of an unindexed id: 404, 0 GitHub calls");

// ── 2c. nothing is answered by character scatter ──
// The old "abbreviation" tier matched any id whose normalized form contained the
// keyword as a subsequence. It is gone, and the field data replaced it: a query
// that only fits that shape must return nothing rather than a package no field
// of it explains.
reset();
for (const kw of ["sqblt3", "vscd", "mcd"]) {
  const scattered = await search({ Query: { KeyWord: kw, MatchType: "Contains" } });
  assertExplainedByField(kw, scattered);
  console.log(`✅ "${kw}": ${scattered.length} result(s), all explained by a real field`);
}
assert.equal(githubCalls(), 0, "the scatter queries reached the GitHub API");

// ── 3. odd-shaped keywords must not reach the API either ──
for (const kw of ["七", "123pan", ""]) {
  reset();
  const data = await search({ Query: { KeyWord: kw, MatchType: "Contains" } });
  assert.equal(githubCalls(), 0, `"${kw}" reached the GitHub API`);
  console.log(`✅ "${kw || "(empty)"}": 0 GitHub calls (${data.length} result(s))`);
}

// ── 4. manifest resolution picks the version from the index, not the API ──
// Git.Git's installer is GitHub-hosted, so it must come back mirror-rewritten.
reset();
const mf = await worker.fetch(
  new Request("http://worker.test/packageManifests/Git.Git"), env, {}
);
assert.equal(mf.status, 200, `packageManifests returned ${mf.status}`);
const mfJson = await mf.json();
const installers = mfJson.Data?.Versions?.[0]?.Installers ?? [];
assert.ok(installers.length > 0, "manifest has no Installers");
const GITHUB_HOST = /^https:\/\/[^/]*(github\.com|githubusercontent\.com)\//;
assert.ok(
  installers.every((i) => !GITHUB_HOST.test(i.InstallerUrl ?? "")),
  "a GitHub InstallerUrl was not rewritten to the mirror"
);
assert.ok(
  installers.some((i) => (i.InstallerUrl ?? "").startsWith(env.MIRROR + "/https://github.com/")),
  "GitHub installer URL was not routed through the mirror"
);
assert.ok(installers.every((i) => i.InstallerType), "an installer is missing InstallerType");
assert.equal(githubCalls(), 0, "packageManifests reached the GitHub API");
console.log(`✅ packageManifests/Git.Git: ${installers.length} installer(s), mirror-rewritten, 0 GitHub calls`);

// A non-GitHub installer must be left untouched (winget downloads it directly).
reset();
const ff = await worker.fetch(
  new Request("http://worker.test/packageManifests/Mozilla.Firefox"), env, {}
);
const ffInstallers = ((await ff.json()).Data?.Versions?.[0]?.Installers) ?? [];
assert.ok(ffInstallers.length > 0, "Firefox manifest has no Installers");
assert.ok(
  ffInstallers.every((i) => !(i.InstallerUrl ?? "").startsWith(env.MIRROR + "/")),
  "a vendor (non-GitHub) InstallerUrl was rewritten when it should not have been"
);
console.log(`✅ packageManifests/Mozilla.Firefox: ${ffInstallers.length} installer(s), vendor URLs untouched, 0 GitHub calls`);
