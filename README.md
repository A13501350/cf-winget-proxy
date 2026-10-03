# winget-cn · Cloudflare Workers 镜像源

基于 [lihongjie0209/cf-winget-proxy](https://github.com/lihongjie0209/cf-winget-proxy)
修改而来的 winget 国内加速源。相比上游，核心改动是：**把包清单里的 GitHub `InstallerUrl`
自动改写为国内镜像（默认 `https://gh-proxy.org`），安装器由客户端直连镜像下载。**

## 它解决什么问题

winget 官方的 `winget` 源是微软签名的 SQLite 索引（`Microsoft.PreIndexed`），安装器托管在
GitHub，国内直连经常很慢或超时。本项目提供一个**自建的 `Microsoft.Rest` 源**，后端直接读
`microsoft/winget-pkgs` 的 YAML 清单，并把其中的 GitHub 安装包地址改写成镜像。

> 为什么不做成官方源的透明反代？官方源是二进制 SQLite（`PreIndexed`），无法在 REST 层改写
> `InstallerUrl`；只能像本项目这样自建 `Microsoft.Rest` 源，自己从 GitHub 取清单、改写链接。

## 工作原理

```
winget ──REST(JSON)──▶ Cloudflare Worker ──▶ index.json（本仓库，包列表）
                          │
                          └──▶ jsDelivr 上的 YAML 清单（只取命中的那个包）
   │
   │ 改写 InstallerUrl：github.com / githubusercontent.com → <MIRROR>/https://github.com/...
   └── 客户端直连 MIRROR（gh-proxy 等）下载安装器，不经 Worker
```

- 清单（小 JSON）经 Cloudflare 边缘取回，改写后交给 winget；
- 安装器（大文件）由**客户端直连镜像**下载，不经 Worker，因此不受 Worker 25MB 体积极限影响，
  且镜像对 GitHub Release 是字节透明的，winget 的 SHA256 校验照常通过。

### 清单是怎么拼出来的

`winget-pkgs` 里一个版本目录通常是三个文件，也可能是一个合并文件：

```
{id}.yaml                          ManifestType: version  —— 声明 DefaultLocale
{id}.installer.yaml                ManifestType: installer —— 安装器列表
{id}.locale.{DefaultLocale}.yaml   ManifestType: defaultLocale
```

先取 `{id}.yaml`：它既告诉 Worker 这是三文件还是合并布局（`ManifestType: merged`
时一个文件就是全部），也告诉 Worker **默认 locale 是哪一个**。第二步才并行取
installer 与那份 locale，并把 locale 的字段整体透传进 REST 的 `DefaultLocale`
（Moniker、Author、Tags、ReleaseNotes、Documentations…… 只有 `Installers`、
`ManifestType` 这类外壳键丢掉），`InstallerUrl` 换成镜像地址，其余原样返回。

默认 locale 必须问 `{id}.yaml`，不能猜。曾经按「en-US 最常见」的顺序探文件名，
结果是：`115.115Chrome`、`Alibaba.UC` 这类包**确实有** `{id}.locale.en-US.yaml`，
但那是 `ManifestType: locale`（附加本地化），schema 不要求它带 `PackageName`，
拿它当默认 locale 只会拼出一份残缺清单。探测还最坏要 16 次 404；问一次
`{id}.yaml` 是确定的。

**拼不出就报错，不交残缺清单**：索引里没有这个包、或两个静态主机都答 404 → 404；
版本 manifest 声明的 locale 文件取不到、locale 缺 `PackageName`/`License`、
请求本身失败（5xx / 429 / 网络异常）→ 502 并带上原因。区分这两类是刻意的：
把 CDN 抖动说成「没有这个包」，用户在 winget 里看到的就是一个不存在的包。
而交一份残缺清单更糟 —— `ManifestValidation`→`Interface.cpp:290` 只要错误数 > 0
就抛 `APPINSTALLER_CLI_ERROR_RESTSOURCE_INVALID_DATA`，客户端看到的是
`0x8a150039 REST 源返回的数据无效`，那是**整源**级别的报错，和源坏了无法区分。

`InstallerType` / `NestedInstallerType` / `Dependencies` 是包级键，REST 要求每个
安装器都带 `InstallerType`，所以 Worker 把包级的值补进每个安装器，但**不改写它**：
上游写 `zip` + `portable`（zip 里装一个 portable exe，官方源显示
`portable (zip)`），Worker 曾把它反转成 `portable` + `zip`，客户端于是把一个 `.zip`
当成裸 exe 执行。反转已删除。

### REST 端点

| 端点 | 说明 |
| --- | --- |
| `GET  /information` | 源元数据（Microsoft.Rest 协议） |
| `POST /manifestSearch` | 包搜索，后端为 `index.json`（官方源的包索引） |
| `GET  /packageManifests/{id}` | 包清单（最新版本取自 `index.json`），`InstallerUrl` 已改写为镜像地址 |
| `GET  /packageManifests/{id}?Version=x` | 指定版本（winget 以 query 参数传版本） |
| `GET  /_index` | 自检：强制重取 `INDEX_URL`，返回条数/moniker/tag 计数。搜索返回空 `Data` 时先看它 |

## 部署

推送到 `main` 即由 **Cloudflare Workers Builds**（GitHub App 集成）自动构建上线，
因此 `.github/workflows/deploy.yml` 是**故意停用**的
—— 它需要 `CLOUDFLARE_API_TOKEN`，而这条路径不需要。

Builds **不筛路径**：任意文件的推送都会重建并上线，只改 README 和 `ci.yml` 的
`d3c7507` 同样产出了新版本。所以别把「这次没动代码」当成不会影响线上的理由。
唯一不重建的是提交信息带 `[skip ci]` —— 每天那条 `chore: update winget index` 就靠它
不重复部署（那是一次 GitHub Actions 的 `skipped`，Cloudflare 也认这个标记），
因为索引是 Worker 运行时从 `INDEX_URL` 拉的，换索引内容不需要重新上线。

手动部署（本地已 `wrangler login` 时）：

```powershell
npm install
wrangler deploy
```

### 配置（`wrangler.toml`）

```toml
name = "cf-winget-proxy"
main = "src/index.ts"
compatibility_date = "2026-09-29"

[vars]
# 安装器镜像，必须支持路径形式：<MIRROR>/https://github.com/owner/repo/...
# 安装器由客户端直接从此镜像下载（不经 Worker）。
MIRROR = "https://gh-proxy.org"
```

> 本地 `wrangler dev` 可能需要更旧的 `compatibility_date`（取决于本机 wrangler
> 二进制支持的日期）。用一份 gitignore 掉的 `wrangler.dev.toml` 覆盖，
> 不要为此改动提交里的值。

不需要任何 secret：代码里没有能打向 `api.github.com` 的路径，清单全部走静态主机。
`GITHUB_TOKEN` 因此无人读取，别为它创建 PAT。

## 使用

添加镜像源（保留官方源）：

```powershell
winget source add --name winget-cn --arg https://<你的worker域名> --type Microsoft.Rest
winget install Git.Git -s winget-cn
```

或**替换官方源**（之后所有 `winget` 命令自动走镜像，最省心）：

```powershell
winget source remove --name winget
winget source add --name winget --arg https://<你的worker域名> --type Microsoft.Rest
winget upgrade --all
```

> ⚠️ 注意：`winget upgrade <id> -s winget-cn` 只会升级「由 `winget-cn` 源安装的包」。
> 若某包是从官方 `winget` 源装的，请用 `winget install <id> -s winget-cn`
> （发现新版本会直接升级，且走镜像），或先 `winget source remove winget` 把默认源换成镜像源。

落地页（`https://<你的worker域名>/`）会根据实际请求域名和 `MIRROR` 动态生成上面的
`winget source add` 命令，可直接复制。

## 搜索

只有一条路径：**预建索引 → 按索引取清单 → 改写 → 返回**。代码里不存在任何能打
到 `api.github.com` 的调用（打包产物中该字符串出现 0 次）。

索引 `index.json` 不是从 git 路径推出来的，而是从官方源自己的库里导出来的：
`https://cdn.winget.microsoft.com/cache/source2.msix` 里的 `Public/index.db`
（SQLite），也就是 winget 默认源下载并本地检索的那份数据。每行是

```json
{"id":"Microsoft.VisualStudioCode","v":"1.140.0","n":"Microsoft Visual Studio Code","m":"vscode","t":["editor","developer-tools"]}
```

1.5 万条、约 2.3 MB，其中 15310 条有名称、5940 条有 moniker、11496 条有 tag。

1. **精确 ID**（`Publisher.Package`，带点）：在 `index.json` 里直接查到最新版本。
2. **关键词**：对 `id / moniker / name / tag` 四个字段做大小写无关的
   精确 → 前缀 → 子串匹配，再按「匹配质量优先、字段其次」排序：
   `vscode` 首条是 `Microsoft.VisualStudioCode`（Moniker 精确），排在
   仅仅 id 里含 `vscode` 的 `…CommandPalette-VSCode` 之前。
   关键词必须**字面出现**在某个字段里，没有更弱的了。
3. **依赖解析**（`ProductCode`）：剥掉 `_microsoft.winget.source_…` 后缀还原 id，同样走索引。

结果条数不截断，和官方源一致（`winget search e` 官方返回 14468 条，本 worker 返回
同量级）；截断会把用户要找的那个包悄悄藏起来。

**不做缩写/子序列猜测。** 曾经有过第五档，它让 `vscode` 命中
`Microsoft.VisualStudioCode`，也顺手让 `sqlite3` 命中了 `SublimeText 3`
（`sublimehqsublimetext3` 里正散落着 s-q-l-i-t-e-3）。而 `winget install <关键词>`
是真会拿这个假命中去装包的，所以整档删除。
现在 `vscode` 靠 Moniker 字段命中、`sqlite3` 靠 Tag 字段命中，是数据不是猜测。

**索引里没有就当没有**：搜索返回空 `Data`，`packageManifests/{id}`（未带 `?Version=`）
返回 404。不做目录枚举回源 —— Contents API 未认证限额是 **60 次/小时且按 IP 计**，
而 Cloudflare 的出口 IP 是和别的 worker 共享的，一次突发失败会让同 IP 上的所有用户
一起不可用，比「查不到」更糟。

### 已知限制

- **新包隐身**：官方 feed 本身就落后 `winget-pkgs`，索引再每天 04:23 UTC 重建一次，
  两层延迟叠加。这是删掉回源后故意接受的唯一缺口（可手动触发 workflow）。
- **feed 拿不到就报错**：重建依赖 `cdn.winget.microsoft.com` 可达且 `source2.msix`
  仍在那个路径上；任一条件不满足，`build-index.sh` 直接失败、保留仓库里上一版
  `index.json`，而不是发布一份残缺索引。
- **`匹配` 列在 moniker/tag 命中时显示 `UnknownMatchField:`**（官方源同一行显示
  `Tag: sqlite3`）。这不是可以修的东西，是 `Microsoft.Rest` 源类型的上限：搜索响应里
  一个 version 只有 `PackageVersion / Channel / PackageFamilyNames / ProductCodes`
  （1.4 起再加 `UpgradeCodes`），**不带清单**
  （`SearchResponseDeserializer_1_0.cpp:163` 把 `VersionInfo::Manifest` 直接写成空）。
  客户端于是用 `FindBestMatchCriteria` 拿包自身的属性回推命中列，能查的只有
  Id / Name / 那几个系统引用串；Moniker、Command、Tag 存在清单的本地化段里，
  REST 命中一律为空 → `Field` 停在 `Unknown`，而 `Unknown` 没有 `ToString()` 分支，
  就打出了字面量 `UnknownMatchField`。id/name 命中在两种源上都显示空白
  （`WorkflowBase.cpp:38` 对这两个字段直接返回空串）。官方源是预索引 SQLite，
  命中列由那条查询自己给出，所以它知道、我们不知道。
  **返回的包集合和排序都不受影响**，只有这一列不同。
- **只交默认 locale**：`Locales` 恒为空数组，附加本地化（同一包的
  `ManifestType: locale` 文件）没有搬运过来。`winget show` 里的文案因此永远是
  默认那一份，切 `--locale` 不会换词。
- **拼不出只坏那一个包**：404/502 是单个 `packageManifests/{id}` 请求的返回值，
  源本身不受影响。相比交一份残缺清单（那会让客户端报 `0x8a150039`，看起来像整源
  坏了），宁可在这里明确失败。

### 自检

```bash
npm run build:index   # 下载 source2.msix → 导出 index.json → 校验（需要联网）
npm run test:index    # index.json 完整性 + 字段覆盖率 + 索引命中率（全离线）
npm run typecheck     # tsc --noEmit
npm run test:worker   # esbuild 打包 Worker，用 stub fetch（任何 api.github.com 调用直接抛错）跑 22 个用例
npm run test:manifest # 清单拼装：读哪份 locale、拼不出怎么失败、安装器类型透传（全离线 fixture）
```

`test:worker` 里索引未命中的用例断言的是「0 结果 **且** 0 次 GitHub 调用」，
所以任何回源代码一旦被加回来，这条命令会立刻抛 `unexpected GitHub API call` 变红。
`test:manifest` 的 fixture 是真从 `winget-pkgs` 抄下来的文件（`2dust.v2rayN` 的三件套、
一份 `ManifestType: locale` 的诱饵、一份 merged），fetch 全被替换成内存表，
所以它不需要网络也不会随上游抖动而变红。
`ci.yml`（push/PR，不需要任何 secret）跑这四条；`build-index.yml` 重建索引后跑
`node test_index_search.mjs`（校验列齐不齐、老词还查不查得到）。
`deploy.yml` 是停用的（上线由 Cloudflare Workers Builds 负责），别指望它兜底。

完整的 GitHub 请求点与限流/延迟分析见 [docs/github-requests.md](docs/github-requests.md)。

## 调试

```powershell
wrangler tail
```

Worker 会打印：

- `manifestSearch body: ...` —— winget 发来的搜索请求原始体；
- `manifestSearch: looking up package id: ...` / `productCode -> id: ...` —— 走 id 直查的路径；
- `keywordSearch: index hit, returned=M for "..."` —— 命中索引，返回 M 条（不截断）；
- `keywordSearch: no index match for "..."` —— 索引里没有，直接返回空（不再回源）；
- `manifestSearch: no results (empty Data)` —— 确实没找到；
- `packageManifests: <文件名> for <id>@<版本>: <原因>` —— 某个清单文件没拿到，
  原因是 `404`/`not served by ...`（当没有这个包）或 `5xx from ...` /
  `fetch threw ...`（当上游失败，返回 502）；
- `packageManifests: incomplete default locale for ...` —— locale 拿到了但缺
  `PackageName`/`License`，502；
- `packageManifests: unexpected manifest layout ...` —— `{id}.yaml` 的
  `ManifestType` 既不是 `version` 也不是 `merged`；
- `packageManifests: version manifest has no DefaultLocale ...` —— 版本清单没声明
  默认 locale，无法知道该取哪份 locale，502。

区分「索引没加载」和「索引里真没这个词」：`curl https://<worker>/_index`。它绕过
memo 和边缘缓存重取一次，返回 `entries` / `withMoniker` / `withTags`；
`entries: 0` 是索引问题（看同一行日志里的 `getIndex: <status> from <url>`），
条数正常则是查询本身无命中。

## 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `MIRROR` | 否 | 安装器镜像地址，如 `https://gh-proxy.org`；缺失时回退到该默认值 |
| `GITHUB_TOKEN` | 否 | **当前无代码读取**（回源路径已删除），保留仅为日后接入用 |

## License

派生自 [lihongjie0209/cf-winget-proxy](https://github.com/lihongjie0209/cf-winget-proxy)。
