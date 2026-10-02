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
let allowGitHub = false;
globalThis.fetch = (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  seen.push(url);
  if (url === "http://index.test/index.json") {
    return Promise.resolve(new Response(INDEX_BODY, { status: 200 }));
  }
  if (url.includes("api.github.com")) {
    if (!allowGitHub) throw new Error("unexpected GitHub API call: " + url);
    // Rate-limited upstream: answer fast and badly, so the bounded-enumeration
    // assertion measures call count rather than wall-clock luck.
    return Promise.resolve(new Response('{"message":"rate limit"}', { status: 403 }));
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
  ["abbreviation vscode", { Inclusions: [{ PackageMatchField: "Moniker", RequestMatch: { KeyWord: "vscode", MatchType: "Exact" } }] }, "Microsoft.VisualStudioCode"],
  ["abbreviation vlc", { Query: { KeyWord: "vlc", MatchType: "Contains" } }, "VideoLAN.VLC"],
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

// ── 2. a keyword the index misses must enumerate, but within the hard budget ──
reset();
allowGitHub = true;
try {
  await search({ Query: { KeyWord: "zzqxvnope", MatchType: "Contains" } });
} finally {
  allowGitHub = false;
}
assert.ok(githubCalls() > 0, "expected enumeration to run on an index miss");
assert.ok(githubCalls() <= 43, `enumeration exceeded its budget: ${githubCalls()} calls (cap 43)`);
console.log(`✅ index miss enumerates within budget (${githubCalls()} calls ≤ 43)`);

// ── 3. keywords that cannot be enumerated must not reach the API at all ──
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
