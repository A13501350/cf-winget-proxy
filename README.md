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
winget  ──REST(JSON)──▶  Cloudflare Worker  ──读 YAML──▶  microsoft/winget-pkgs (GitHub)
   ▲                         │
   │ 改写 InstallerUrl        └── 把 github.com / githubusercontent.com 的 InstallerUrl
   │                              换成  <MIRROR>/https://github.com/...
   │
   └── 客户端直连 MIRROR（gh-proxy 等）下载安装器（不经 Worker）
```

- 清单（小 JSON）经 Cloudflare 边缘取回，改写后交给 winget；
- 安装器（大文件）由**客户端直连镜像**下载，不经 Worker，因此不受 Worker 25MB 体积极限影响，
  且镜像对 GitHub Release 是字节透明的，winget 的 SHA256 校验照常通过。

### REST 端点

| 端点 | 说明 |
| --- | --- |
| `GET  /information` | 源元数据（Microsoft.Rest 协议） |
| `POST /manifestSearch` | 包搜索，后端为 `microsoft/winget-pkgs` |
| `GET  /packageManifests/{id}` | 包清单，`InstallerUrl` 已改写为镜像地址 |
| `GET  /packageManifests/{id}?Version=x` | 指定版本（winget 以 query 参数传版本） |

## 部署

推送到 `main` 即由 **Cloudflare Workers Builds**（GitHub App 集成）自动构建上线，
因此 `.github/workflows/deploy.yml` 是**故意停用**的
—— 它需要 `CLOUDFLARE_API_TOKEN`，而这条路径不需要。

Builds **不筛路径**：任意文件的推送都会重建并上线，只改 README 和 `ci.yml` 的
`d3c7507` 同样产出了新版本。所以别把「这次没动代码」当成不会影响线上的理由。
唯一不重建的是提交信息带 `[skip ci]` —— 每天那条 `chore: update winget index` 就靠它
不重复部署，因为索引是 Worker 运行时从 `INDEX_URL` 拉的，换索引内容不需要重新上线。

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

可选，但强烈建议——目录枚举搜索会调用 GitHub contents API，设置后限流更宽松：

```powershell
wrangler secret put GITHUB_TOKEN   # 细粒度 PAT，仅需 public-repo 读权限
```

> 不要在 `wrangler.toml` 里明文写 `GITHUB_TOKEN`，请用上面的 secret 方式。

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

1. **精确 ID**（`Publisher.Package`，带点）：在 `index.json` 里直接查到最新版本。
2. **关键词**：对 `index.json`（1.5 万条左右，每天由 Action 重建）做四档匹配，
   精度从高到低：id 精确 → id 前缀 → 归一化前缀 → 子串。四档的共同点就一个：
   关键词必须**字面出现**在 id 里。没有更弱的了。
3. **依赖解析**（`ProductCode`）：剥掉 `_microsoft.winget.source_…` 后缀还原 id，同样走索引。

**不做缩写/子序列猜测。** 曾经有过第五档，它让 `vscode` 命中
`Microsoft.VisualStudioCode`，也顺手让 `sqlite3` 命中了 `SublimeText 3`
（`sublimehqsublimetext3` 里正散落着 s-q-l-i-t-e-3）。winget 拿到结果后会用包
自身的属性回推「命中在哪个字段」（`FindBestMatchCriteria`），推不出来就显示
`UnknownMatchField:` —— 而 `winget install <关键词>` 是真会拿这个假命中去装包的。
官方源答 `vscode` 靠的是 Moniker 字段，那是数据不是猜测。

**索引里没有就当没有**：搜索返回空 `Data`，`packageManifests/{id}`（未带 `?Version=`）
返回 404。不做目录枚举回源 —— Contents API 未认证限额是 **60 次/小时且按 IP 计**，
而 Cloudflare 的出口 IP 是和别的 worker 共享的，一次突发失败会让同 IP 上的所有用户
一起不可用，比「查不到」更糟。

### 已知限制

- **新包隐身**：索引每天 04:23 UTC 重建，之后发布的包最坏 24 小时查不到
  （可手动触发 workflow）。这是删掉回源后故意接受的唯一缺口。
- **没有别名检索**：索引只含 `PackageIdentifier` + 最新版本，不含 moniker /
  display name / tag。所以 `winget search vscode` 查不到
  `Microsoft.VisualStudioCode`（它的 id 里并没有 `vscode` 这个字面串），得写全名或
  `visualstudio`；靠 tag 才能命中的词（`sqlite3`）一律返回空。要补就是给索引加
  moniker / package name 列（需逐包读 YAML），见 `docs/github-requests.md` §5.1。
- 命中列（`匹配`）多为空：我们按 id 匹配，winget 对 Id/Name 命中就是显示空白，
  这是正常的；只要不再出现 `UnknownMatchField:` 就说明结果都是可归因的。

### 自检

```bash
npm run test:index    # 解析器单测 + index.json 完整性 + 索引命中率（全离线）
npm run typecheck     # tsc --noEmit
npm run test:worker   # esbuild 打包 Worker，用 stub fetch（任何 api.github.com 调用直接抛错）跑 17 个用例
```

`test:worker` 里索引未命中的用例断言的是「0 结果 **且** 0 次 GitHub 调用」，
所以任何回源代码一旦被加回来，这条命令会立刻抛 `unexpected GitHub API call` 变红。
`ci.yml`（push/PR，不需要任何 secret）跑全部三条；`build-index.yml` 重建索引前跑
`scripts/test-index-parser.sh` + `node test_index_search.mjs`（后者需要刚构建出的 `index.json`）。
`deploy.yml` 是停用的（上线由 Cloudflare Workers Builds 负责），别指望它兜底。

完整的 GitHub 请求点与限流/延迟分析见 [docs/github-requests.md](docs/github-requests.md)。

## 调试

```powershell
wrangler tail
```

Worker 会打印：

- `manifestSearch body: ...` —— winget 发来的搜索请求原始体；
- `manifestSearch: looking up package id: ...` / `productCode -> id: ...` —— 走 id 直查的路径；
- `keywordSearch: index hit, matched=N, returned=M for "..."` —— 命中索引，候选 N 个、截断后返回 M 个；
- `keywordSearch: no index match for "..."` —— 索引里没有，直接返回空（不再回源）；
- `manifestSearch: no results (empty Data)` —— 确实没找到。

## 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `MIRROR` | 否 | 安装器镜像地址，如 `https://gh-proxy.org`；缺失时回退到该默认值 |
| `GITHUB_TOKEN` | 否 | **当前无代码读取**（回源路径已删除），保留仅为日后接入用 |

## License

派生自 [lihongjie0209/cf-winget-proxy](https://github.com/lihongjie0209/cf-winget-proxy)。
