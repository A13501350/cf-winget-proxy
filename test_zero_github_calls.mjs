// End-to-end guard for the search hot path: it drives the real Worker handler
// against the committed index.json and asserts that indexed queries never touch
// api.github.com — that is the whole point of the prebuilt index, and the only
// thing standing between a shared 60 req/h rate limit and total outage.
//   CI: node test_zero_github_calls.mjs
import assert from "node:assert";
import { readFileSync } from "node:fs";
import worker from "./.build-test/worker.mjs";

const INDEX_BODY = readFileSync(new URL("./index.json", import.meta.url));

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

// ── 1. every query shape winget actually sends must be answered from the index ──
const cases = [
  ["keyword (Query)", { Query: { KeyWord: "firefox", MatchType: "Contains" } }, "Mozilla.Firefox"],
  ["normalized substring vlc", { Query: { KeyWord: "vlc", MatchType: "Contains" } }, "VideoLAN.VLC"],
  ["normalized substring 7zip", { Query: { KeyWord: "7zip", MatchType: "Contains" } }, null],
  ["exact id (Filters)", { Filters: [{ PackageMatchField: "PackageIdentifier", RequestMatch: { KeyWord: "Git.Git", MatchType: "Exact" } }] }, "Git.Git"],
  ["lowercased id", { Filters: [{ PackageMatchField: "PackageIdentifier", RequestMatch: { KeyWord: "yt-dlp.ffmpeg", MatchType: "Exact" } }] }, "yt-dlp.FFmpeg"],
  ["ProductCode (dependency)", { Inclusions: [{ PackageMatchField: "ProductCode", RequestMatch: { KeyWord: "yt-dlp.ffmpeg_microsoft.winget.source_8wekyb3d8bbwe", MatchType: "Exact" } }] }, "yt-dlp.FFmpeg"],
  ["NormalizedPackageNameAndPublisher", { Inclusions: [{ PackageMatchField: "NormalizedPackageNameAndPublisher", RequestMatch: { KeyWord: "ytdlpffmpeg", MatchType: "Exact" } }] }, "yt-dlp.FFmpeg"],
  ["non-ascii publisher", { Query: { KeyWord: "brötje", MatchType: "Contains" } }, "BRÖTJE.ProfiTool"],
];

for (const [label, body, expectId] of cases) {
  reset();
  const data = await search(body);
  assert.ok(data.length > 0, `${label}: empty Data`);
  if (expectId) {
    assert.ok(data.some((d) => d.PackageIdentifier === expectId), `${label}: ${expectId} missing`);
  }
  for (const d of data) {
    assert.ok(d.PackageIdentifier && d.PackageName && d.Publisher, `${label}: missing required fields`);
    assert.ok((d.Versions ?? []).length && d.Versions[0].PackageVersion, `${label}: empty Versions`);
  }
  assert.equal(githubCalls(), 0, `${label}: made ${githubCalls()} GitHub API call(s)`);
  console.log(`✅ ${label}: ${data.length} result(s), 0 GitHub calls`);
}

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

// ── 2c. no query is answered by guessing ──
// A keyword that fits an id only as a *character subsequence* must return
// nothing. That shape used to be the "abbreviation" tier: it is how "vscode"
// found Microsoft.VisualStudioCode, and also how "sqlite3" handed back
// SublimeText 3 (s-q-l-i-t-e-3 scattered through "sublimehqsublimetext3").
// winget re-derives the match column from the package's own properties
// (FindBestMatchCriteria), so a package whose id does not literally contain the
// keyword prints "UnknownMatchField:" — and `winget install <keyword>` would
// offer the wrong package to install.
reset();
const guessed = await search({ Query: { KeyWord: "sqlite3", MatchType: "Contains" } });
assert.equal(guessed.length, 0, `"sqlite3" was answered by guessing: ${JSON.stringify(guessed.map((d) => d.PackageIdentifier))}`);
console.log("✅ sqlite3: nothing is guessed at any more (0 results)");

// "vscode" is the query that tier existed for. Anything it now returns must
// contain the literal string, and the package the tier was really propping up
// must be gone — that absence is the alias gap that a Moniker column in the
// index is supposed to close properly, not a subsequence.
reset();
const aliases = await search({ Query: { KeyWord: "vscode", MatchType: "Contains" } });
for (const d of aliases) {
  assert.ok(d.PackageIdentifier.toLowerCase().includes("vscode"), `"vscode" returned ${d.PackageIdentifier}, which does not contain "vscode"`);
}
assert.equal(
  aliases.some((d) => d.PackageIdentifier === "Microsoft.VisualStudioCode"),
  false,
  "Microsoft.VisualStudioCode was matched for 'vscode' without the id containing it"
);
console.log(`✅ vscode: ${aliases.length} result(s), all literally containing it, no invented alias hit`);
assert.equal(githubCalls(), 0, "the alias queries reached the GitHub API");

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
assert.ok(
  ffInstallers.some((i) => /^https:\/\/[^/]*mozilla/.test(i.InstallerUrl ?? "")),
  "unexpected Firefox installer host set"
);
assert.equal(githubCalls(), 0, "packageManifests reached the GitHub API");
console.log(`✅ packageManifests/Mozilla.Firefox: ${ffInstallers.length} installer(s), vendor URLs untouched, 0 GitHub calls`);
