// Offline guard for manifest resolution: fetch is stubbed with winget-pkgs
// fixtures, so no request leaves the process. Covers the shapes that broke
// `winget show -s winget-cn 2dust.v2rayN` (a default locale that is not en-US, and
// a package-level `InstallerType: zip` that the Worker used to invert), the
// `MediaArea.MediaInfo` shape that broke it with 0x8a150039 (installer fields
// declared only at the manifest root), the version manifest that says which locale
// to read, and the fail-close behaviour that replaced serving an incomplete
// manifest.
//   CI: node test_manifest_locale.mjs
import assert from "node:assert";
import worker from "./.build-test/worker.mjs";

const INDEX_LINES = [
  { id: "2dust.v2rayN", v: "7.24.8", n: "v2rayN", m: "v2rayn", t: ["proxy"] },
  { id: "MissingLocale.Example", v: "1.2.3", n: "Example", m: "example" },
  { id: "Merged.Format", v: "9.9.9", n: "Merged Format" },
  { id: "Empty.License", v: "1.0.0", n: "Empty License" },
  { id: "Zh.Default", v: "36.0.1", n: "Default Zh" },
  { id: "Gone.Nowhere", v: "1.0.0", n: "Gone Nowhere" },
  { id: "Broken.Cdn", v: "1.0.0", n: "Broken Cdn" },
  { id: "Fallback.Raw", v: "2.0.0", n: "Fallback Raw" },
  { id: "Rootlevel.Nested", v: "26.05", n: "Root Level Nested", m: "nested" },
];
const INDEX_BODY = INDEX_LINES.map((e) => JSON.stringify(e)).join("\n");

// The real 2dust.v2rayN 7.24.8 manifests. The installer manifest keeps
// InstallerType and NestedInstallerType at the package root and no installer
// repeats them; the version manifest names the default locale, which is not
// en-US.
const V2RAYN_VERSION = `
PackageIdentifier: 2dust.v2rayN
PackageVersion: 7.24.8
DefaultLocale: zh-CN
ManifestType: version
ManifestVersion: 1.12.0
`;

const V2RAYN_INSTALLER = `
PackageIdentifier: 2dust.v2rayN
PackageVersion: 7.24.8
InstallerType: zip
NestedInstallerType: portable
Installers:
- Architecture: arm64
  NestedInstallerFiles:
  - RelativeFilePath: v2rayN-windows-arm64\\v2rayN.exe
  InstallerUrl: https://github.com/2dust/v2rayN/releases/download/7.24.8/v2rayN-windows-arm64.zip
  InstallerSha256: B8AB5FF9C7AFEE308111E82E2E6432D55D41E54CD60CD6AE9A3A35933EFF0948
- Architecture: x64
  NestedInstallerFiles:
  - RelativeFilePath: v2rayN-windows-64\\v2rayN.exe
  InstallerUrl: https://github.com/2dust/v2rayN/releases/download/7.24.8/v2rayN-windows-64.zip
  InstallerSha256: FC7A9120B97EDF460B7B40BCB094A7ACC50F4890324ACE199FD1205937B74321
ManifestType: installer
ManifestVersion: 1.12.0
`;

const V2RAYN_LOCALE_ZH = `
PackageIdentifier: 2dust.v2rayN
PackageVersion: 7.24.8
PackageLocale: zh-CN
Publisher: 2dust
PublisherUrl: https://github.com/2dust
Author: 2dust
PackageName: v2rayN
PackageUrl: https://github.com/2dust/v2rayN
License: GPL-3.0
LicenseUrl: https://github.com/2dust/v2rayN/blob/HEAD/LICENSE
ShortDescription: 支持 Xray、v2fly 等 core 的 GUI 客户端
Moniker: v2rayn
Tags:
- proxy
- v2ray
Documentations:
- DocumentLabel: Wiki
  DocumentUrl: https://github.com/2dust/v2rayN/wiki
ManifestType: defaultLocale
ManifestVersion: 1.12.0
`;

// An additional (non-default) localization: the file name looks like a default
// locale's and it even holds License, but the schema does not require PackageName
// here. Reading one as the default is what used to make the source refuse the
// package; it is present here so the test proves we never ask for it.
const EXTRA_LOCALE_EN = `
PackageIdentifier: Zh.Default
PackageVersion: 36.0.1
PackageLocale: en-US
Author: Someone
License: Proprietary
ShortDescription: An English localization that is not the default one
ManifestType: locale
ManifestVersion: 1.12.0
`;

const ZH_DEFAULT_LOCALE = `
PackageIdentifier: Zh.Default
PackageVersion: 36.0.1
PackageLocale: zh-CN
Publisher: 中文
PackageName: 中文包
License: Proprietary
ShortDescription: 默认本地化
ManifestType: defaultLocale
ManifestVersion: 1.12.0
`;

const SIMPLE_INSTALLER = (id, ver, type, url) => `
PackageIdentifier: ${id}
PackageVersion: ${ver}
InstallerType: ${type}
Installers:
- Architecture: x64
  InstallerUrl: ${url}
ManifestType: installer
ManifestVersion: 1.12.0
`;

const VERSION_MANIFEST = (id, ver, locale) => `
PackageIdentifier: ${id}
PackageVersion: ${ver}
DefaultLocale: ${locale}
ManifestType: version
ManifestVersion: 1.12.0
`;

// Single-file layout: the locale fields live in the one and only manifest.
// `Commands` is an installer field sitting in the same document, so this also
// pins which side of the split it belongs to.
const MERGED_YAML = `
PackageIdentifier: Merged.Format
PackageVersion: 9.9.9
PackageLocale: en-US
Publisher: Merged
PackageName: Merged Format
License: MIT
ShortDescription: A merged manifest
Moniker: merged
InstallerType: exe
Commands:
- format
Installers:
- Architecture: x64
  InstallerUrl: https://github.com/merged/format/releases/download/9.9.9/format.exe
ManifestType: merged
ManifestVersion: 1.12.0
`;

// The real MediaArea.MediaInfo 26.05 installer manifest, reduced to the fields
// that matter, plus the root-declared type-specific fields that winget only
// copies into installers whose type asks for them. Everything is declared at the
// ROOT and repeated by nothing: an installer entry is Architecture + URL + hash.
// Serving this as-is used to send zip+portable with no NestedInstallerFiles, which
// winget validates as an error (ManifestValidation.cpp:444) and reports as
// 0x8a150039 for the entire source.
const ROOTLEVEL_INSTALLER = `
PackageIdentifier: Rootlevel.Nested
PackageVersion: "26.05"
InstallerType: zip
NestedInstallerType: portable
NestedInstallerFiles:
- RelativeFilePath: MediaInfo.exe
  PortableCommandAlias: MediaInfo
Commands:
- MediaInfo
ReleaseDate: 2026-05-12
ProductCode: "{7E1A0000-0000-0000-0000-000000000001}"
PackageFamilyName: MediaAreaMediaInfo-123
AppsAndFeaturesEntries:
- DisplayName: MediaInfo CLI
Dependencies:
  WindowsFeatures:
  - IIS-WebServerRole
Installers:
- Architecture: x86
  InstallerUrl: https://mediaarea.net/download/binary/mediainfo/26.05/MediaInfo_CLI_26.05_Windows_i386.zip
  InstallerSha256: A686129FCF2A0F8D03C93FDB6325C94E6DE7B8D5A1E5BDF40BC899A94D7E785A
- Architecture: x64
  InstallerUrl: https://mediaarea.net/download/binary/mediainfo/26.05/MediaInfo_CLI_26.05_Windows_x64.zip
  InstallerSha256: F7F80620CE6D14F4995F0DE6F98E3EF18AD29496DB01899571152EE3311229F9
  NestedInstallerFiles:
  - RelativeFilePath: x64/MediaInfo.exe
- InstallerType: msix
  Architecture: x64
  InstallerUrl: https://mediaarea.net/download/binary/mediainfo/26.05/MediaInfo_CLI_26.05.msix
  InstallerSha256: 0000000000000000000000000000000000000000000000000000000000000000
ManifestType: installer
ManifestVersion: 1.12.0
`;

const ROOTLEVEL_LOCALE = `
PackageIdentifier: Rootlevel.Nested
PackageVersion: "26.05"
PackageLocale: en-US
Publisher: MediaArea.net
PackageName: MediaInfo-CLI
License: BSD-2-Clause
ShortDescription: Displays technical and tag data for video and audio files
Moniker: mediainfo
Tags:
- audio
- media
ManifestType: defaultLocale
ManifestVersion: 1.12.0
`;

// The default locale file exists but carries none of the fields the REST schema
// requires. winget rejects the whole response for this (0x8a150039), so we must
// not return it.
const INCOMPLETE_LOCALE = `
PackageIdentifier: Empty.License
PackageVersion: 1.0.0
PackageLocale: en-US
Publisher: Empty
ManifestType: defaultLocale
ManifestVersion: 1.12.0
`;

const B = "https://cdn.jsdelivr.net/gh/microsoft/winget-pkgs@master/manifests";
const RAW = "https://raw.githubusercontent.com/microsoft/winget-pkgs/master/manifests";
// A value of `{ status }` is a host failing to answer at all, as opposed to
// answering "not here".
const FILES = new Map([
  [`${B}/2/2dust/v2rayN/7.24.8/2dust.v2rayN.yaml`, V2RAYN_VERSION],
  [`${B}/2/2dust/v2rayN/7.24.8/2dust.v2rayN.installer.yaml`, V2RAYN_INSTALLER],
  [`${B}/2/2dust/v2rayN/7.24.8/2dust.v2rayN.locale.zh-CN.yaml`, V2RAYN_LOCALE_ZH],
  // Deliberately absent: no en-US file for this package.
  [`${B}/z/Zh/Default/36.0.1/Zh.Default.yaml`, VERSION_MANIFEST("Zh.Default", "36.0.1", "zh-CN")],
  [`${B}/z/Zh/Default/36.0.1/Zh.Default.installer.yaml`,
    SIMPLE_INSTALLER("Zh.Default", "36.0.1", "nullsoft", "https://github.com/zh/default/releases/download/36.0.1/setup.exe")],
  [`${B}/z/Zh/Default/36.0.1/Zh.Default.locale.zh-CN.yaml`, ZH_DEFAULT_LOCALE],
  [`${B}/z/Zh/Default/36.0.1/Zh.Default.locale.en-US.yaml`, EXTRA_LOCALE_EN],
  [`${B}/m/MissingLocale/Example/1.2.3/MissingLocale.Example.yaml`,
    VERSION_MANIFEST("MissingLocale.Example", "1.2.3", "de-DE")],
  [`${B}/m/MissingLocale/Example/1.2.3/MissingLocale.Example.installer.yaml`,
    SIMPLE_INSTALLER("MissingLocale.Example", "1.2.3", "msi", "https://github.com/example/example/releases/download/1.2.3/example.msi")],
  [`${B}/m/Merged/Format/9.9.9/Merged.Format.yaml`, MERGED_YAML],
  [`${B}/r/Rootlevel/Nested/26.05/Rootlevel.Nested.yaml`,
    VERSION_MANIFEST("Rootlevel.Nested", "26.05", "en-US")],
  [`${B}/r/Rootlevel/Nested/26.05/Rootlevel.Nested.installer.yaml`, ROOTLEVEL_INSTALLER],
  [`${B}/r/Rootlevel/Nested/26.05/Rootlevel.Nested.locale.en-US.yaml`, ROOTLEVEL_LOCALE],
  [`${B}/e/Empty/License/1.0.0/Empty.License.yaml`, VERSION_MANIFEST("Empty.License", "1.0.0", "en-US")],
  [`${B}/e/Empty/License/1.0.0/Empty.License.installer.yaml`,
    SIMPLE_INSTALLER("Empty.License", "1.0.0", "exe", "https://github.com/empty/license/releases/download/1.0.0/license.exe")],
  [`${B}/e/Empty/License/1.0.0/Empty.License.locale.en-US.yaml`, INCOMPLETE_LOCALE],
  // Gone.Nowhere has no files at all on either host: that is a 404.
  // Broken.Cdn is answered with a 5xx by both: that is not a 404.
  [`${B}/b/Broken/Cdn/1.0.0/Broken.Cdn.yaml`, { status: 522 }],
  [`${RAW}/b/Broken/Cdn/1.0.0/Broken.Cdn.yaml`, { status: 429 }],
  // Fallback.Raw only exists on the second host, which is what the fallback is for.
  [`${RAW}/f/Fallback/Raw/2.0.0/Fallback.Raw.yaml`,
    VERSION_MANIFEST("Fallback.Raw", "2.0.0", "en-US")],
  [`${RAW}/f/Fallback/Raw/2.0.0/Fallback.Raw.installer.yaml`,
    SIMPLE_INSTALLER("Fallback.Raw", "2.0.0", "exe", "https://github.com/fallback/raw/releases/download/2.0.0/raw.exe")],
  [`${RAW}/f/Fallback/Raw/2.0.0/Fallback.Raw.locale.en-US.yaml`, `
PackageIdentifier: Fallback.Raw
PackageVersion: 2.0.0
PackageLocale: en-US
Publisher: Fallback
PackageName: Fallback Raw
License: MIT
ShortDescription: Served only by the second host
ManifestType: defaultLocale
ManifestVersion: 1.12.0
`],
]);

const seen = [];
globalThis.fetch = (input) => {
  const url = typeof input === "string" ? input : input.url;
  seen.push(url);
  if (url === "http://index.test/index.json") {
    return Promise.resolve(new Response(INDEX_BODY, { status: 200 }));
  }
  if (url.includes("api.github.com")) throw new Error("unexpected GitHub API call: " + url);
  const hit = FILES.get(url);
  if (hit === undefined) return Promise.resolve(new Response("not found", { status: 404 }));
  if (typeof hit !== "string") return Promise.resolve(new Response("upstream shrug", { status: hit.status }));
  return Promise.resolve(new Response(hit, { status: 200 }));
};

const env = { INDEX_URL: "http://index.test/index.json", MIRROR: "https://gh-proxy.org" };

const reset = () => { seen.length = 0; };
// Which files were asked for, ignoring that a miss is retried on the second
// host: the point of these assertions is that we read exactly the manifests the
// version manifest names, never a candidate list.
const manifestFiles = () => [
  ...new Set(
    seen
      .filter((u) => u.includes("/manifests/"))
      .map((u) => decodeURIComponent(u.slice(u.lastIndexOf("/") + 1)))
  ),
];
const data = (j) => j.Data?.Versions?.[0] ?? {};

const manifest = async (id) => {
  reset();
  const r = await worker.fetch(new Request(`http://worker.test/packageManifests/${id}`), env, {});
  return { status: r.status, json: await r.json() };
};

// ── 1. the default locale comes from the version manifest, not a guess ────────
{
  const { status, json } = await manifest("2dust.v2rayN");
  assert.equal(status, 200, `expected the declared zh-CN locale to resolve, got ${status} ${JSON.stringify(json)}`);
  const v = data(json);
  assert.equal(v.DefaultLocale.PackageLocale, "zh-CN", "served the wrong locale");
  assert.equal(v.DefaultLocale.License, "GPL-3.0", "License is not the upstream value");
  assert.equal(v.DefaultLocale.ShortDescription, "支持 Xray、v2fly 等 core 的 GUI 客户端");
  assert.equal(v.DefaultLocale.Moniker, "v2rayn", "Moniker was dropped from DefaultLocale");
  assert.deepEqual(v.DefaultLocale.Tags, ["proxy", "v2ray"], "Tags were dropped");
  assert.equal(json.Data.PackageName, "v2rayN", "top-level PackageName is not the locale's");
  assert.equal(json.Data.Publisher, "2dust");

  // The installer types come from the package root and must survive untouched.
  // The Worker used to turn `zip`+`portable` into `portable`+`zip`, which makes
  // the client treat a .zip download as a bare portable executable.
  const installers = v.Installers;
  assert.equal(installers.length, 2, "expected both architectures");
  for (const inst of installers) {
    assert.equal(inst.InstallerType, "zip", "InstallerType was rewritten");
    assert.equal(inst.NestedInstallerType, "portable", "NestedInstallerType was rewritten");
    assert.ok(inst.NestedInstallerFiles?.length, "NestedInstallerFiles were dropped");
    assert.ok(
      inst.InstallerUrl.startsWith("https://gh-proxy.org/https://github.com/"),
      `InstallerUrl not mirrored: ${inst.InstallerUrl}`
    );
  }
  assert.equal(
    manifestFiles().length,
    3,
    `expected version + installer + locale, saw ${JSON.stringify(manifestFiles())}`
  );
  console.log("✅ declared zh-CN locale: served from 3 files, zip+portable passed through");
}

// ── 2. a package that also has an en-US localization must not be read as it ───
{
  const { status, json } = await manifest("Zh.Default");
  assert.equal(status, 200, `expected 200, got ${status} ${JSON.stringify(json)}`);
  const v = data(json);
  assert.equal(v.DefaultLocale.PackageLocale, "zh-CN", "an additional locale was used as the default");
  assert.equal(v.DefaultLocale.PackageName, "中文包", "PackageName is not the default locale's");
  assert.ok(!manifestFiles().some((u) => u.includes(".locale.en-US")), "asked for the non-default locale file");
  console.log("✅ en-US localization present but not the default: zh-CN read, en-US never asked for");
}

// ── 3. declared locale file missing: fail close, don't invent one ─────────────
{
  const { status } = await manifest("MissingLocale.Example");
  assert.equal(status, 502, `expected fail-close 502, got ${status}`);
  assert.equal(manifestFiles().length, 3, "kept looking after the declared locale missed");
  console.log("✅ declared locale file missing: 502 fail-close, no locale guessing");
}

// ── 4. merged single-file layout: the one manifest is the locale ──────────────
{
  const { status, json } = await manifest("Merged.Format");
  assert.equal(status, 200, `merged layout returned ${status} ${JSON.stringify(json)}`);
  const v = data(json);
  assert.equal(v.DefaultLocale.PackageName, "Merged Format", "merged doc did not become DefaultLocale");
  assert.equal(v.DefaultLocale.PackageLocale, "en-US");
  assert.equal(v.Installers[0].InstallerType, "exe");
  assert.deepEqual(v.Installers[0].Commands, ["format"], "root Commands were not inherited");
  assert.equal(v.DefaultLocale.InstallerType, undefined, "installer config leaked into DefaultLocale");
  assert.equal(v.DefaultLocale.Commands, undefined, "installer Commands leaked into DefaultLocale");
  assert.equal(manifestFiles().length, 1, "merged layout fetched more than one file");
  console.log("✅ merged manifest layout: one file, locale read inline, installer keys kept out of it");
}

// ── 5. default locale file present but incomplete ─────────────────────────────
{
  const { status } = await manifest("Empty.License");
  assert.equal(status, 502, `expected an incomplete locale to be refused, got ${status}`);
  console.log("✅ incomplete default locale: 502 rather than invalid data");
}

// ── 6. no version manifest at all ─────────────────────────────────────────────
{
  const { status } = await manifest("Gone.Nowhere");
  assert.equal(status, 404, `expected 404 for an absent package, got ${status}`);
  console.log("✅ absent version manifest: 404");
}

// ── 7. an unindexed id never reaches a host ───────────────────────────────────
{
  const { status } = await manifest("Not.InIndex");
  assert.equal(status, 404, `expected 404 for an unindexed id, got ${status}`);
  assert.equal(manifestFiles().length, 0, "an unindexed id still asked a host for files");
  console.log("✅ unindexed id: 404 without touching any host");
}

// ── 8. a host that fails is not evidence of absence ───────────────────────────
{
  const { status, json } = await manifest("Broken.Cdn");
  assert.equal(status, 502, `a 5xx upstream must not become a 404, got ${status}`);
  assert.match(json.ErrorMessage, /522|429/, `failure reason lost: ${json.ErrorMessage}`);
  console.log("✅ both hosts failed: 502 with the reason, not 404");
}

// ── 9. the second host rescues a package the first one does not serve ─────────
{
  const { status, json } = await manifest("Fallback.Raw");
  assert.equal(status, 200, `expected the fallback host to serve it, got ${status}`);
  assert.equal(data(json).DefaultLocale.PackageName, "Fallback Raw");
  console.log("✅ package only on raw.githubusercontent: served via the fallback");
}

// ── 10. installer fields declared only at the manifest root ───────────────────
{
  const { status, json } = await manifest("Rootlevel.Nested");
  assert.equal(status, 200, `root-only installer fields returned ${status} ${JSON.stringify(json)}`);
  const v = data(json);
  const installers = v.Installers;
  assert.equal(installers.length, 3);

  // The one that says nothing: it inherits the whole root block. Without
  // NestedInstallerFiles winget fails the manifest for the archive installer and
  // the client reports the SOURCE as invalid, so this is not a display nicety.
  const inherited = installers[0];
  assert.equal(inherited.InstallerType, "zip");
  assert.equal(inherited.NestedInstallerType, "portable");
  assert.deepEqual(
    inherited.NestedInstallerFiles,
    [{ RelativeFilePath: "MediaInfo.exe", PortableCommandAlias: "MediaInfo" }],
    "root NestedInstallerFiles were dropped"
  );
  assert.deepEqual(inherited.Commands, ["MediaInfo"], "root Commands were dropped");
  assert.deepEqual(inherited.Dependencies, { WindowsFeatures: ["IIS-WebServerRole"] }, "root Dependencies were dropped");
  assert.equal(inherited.ReleaseDate, "2026-05-12", "root ReleaseDate was dropped");
  // zip+portable does write an ARP entry and does use a ProductCode, so both
  // come along; it is not an msix, so PackageFamilyName must not (that one is a
  // warning upstream — the two above are errors).
  assert.deepEqual(inherited.AppsAndFeaturesEntries, [{ DisplayName: "MediaInfo CLI" }], "root AppsAndFeaturesEntries were dropped");
  assert.equal(inherited.ProductCode, "{7E1A0000-0000-0000-0000-000000000001}", "root ProductCode was dropped");
  assert.equal(inherited.PackageFamilyName, undefined, "PackageFamilyName was copied to a portable installer");

  // The one that overrides: its own value must survive the inheritance.
  assert.deepEqual(
    installers[1].NestedInstallerFiles,
    [{ RelativeFilePath: "x64/MediaInfo.exe" }],
    "an installer's own NestedInstallerFiles were overwritten by the root's"
  );

  // msix is none of those types: no nested archive fields, no ProductCode, no ARP
  // entry — and PackageFamilyName, which it does use. Copying the root's anyway is
  // how a manifest upstream accepts would become an invalid one through us.
  const msix = installers[2];
  assert.equal(msix.InstallerType, "msix");
  assert.equal(msix.NestedInstallerType, undefined, "NestedInstallerType was copied to an msix installer");
  assert.equal(msix.NestedInstallerFiles, undefined, "NestedInstallerFiles were copied to an msix installer");
  assert.equal(msix.ProductCode, undefined, "ProductCode was copied to an msix installer");
  assert.equal(msix.AppsAndFeaturesEntries, undefined, "AppsAndFeaturesEntries were copied to an msix installer");
  assert.equal(msix.PackageFamilyName, "MediaAreaMediaInfo-123", "root PackageFamilyName was dropped for an msix installer");
  assert.deepEqual(msix.Commands, ["MediaInfo"], "root Commands were dropped for an msix installer");

  // A non-GitHub installer URL stays untouched, mirror or not.
  assert.ok(
    inherited.InstallerUrl.startsWith("https://mediaarea.net/"),
    `vendor URL was rewritten: ${inherited.InstallerUrl}`
  );
  // None of this belongs in the locale object.
  for (const key of ["NestedInstallerFiles", "Commands", "Dependencies", "ReleaseDate", "InstallerType", "ProductCode", "AppsAndFeaturesEntries"]) {
    assert.equal(v.DefaultLocale[key], undefined, `${key} leaked into DefaultLocale`);
  }
  assert.equal(v.DefaultLocale.PackageName, "MediaInfo-CLI");
  console.log("✅ root installer fields inherited per type; gated fields left off types that reject them");
}

assert.ok(!seen.some((u) => u.includes("api.github.com")), "a manifest path reached the GitHub API");
console.log("✅ manifest resolution made 0 GitHub API calls");
