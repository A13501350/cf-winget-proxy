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

```powershell
npm install
wrangler deploy
```

### 配置（`wrangler.toml`）

```toml
name = "cf-winget-proxy"
main = "src/index.ts"
compatibility_date = "2024-07-25"

[vars]
# 安装器镜像，必须支持路径形式：<MIRROR>/https://github.com/owner/repo/...
# 安装器由客户端直接从此镜像下载（不经 Worker）。
MIRROR = "https://gh-proxy.org"
```

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

`Microsoft.Rest` 源没有官方那种全文索引。本 Worker 的搜索策略：

1. **精确 ID**（`Publisher.Package`，带点）：直接查 `winget-pkgs` 目录，返回版本列表。
2. **关键词**：GitHub 代码搜索（`/search/code`）对 `winget-pkgs` 这种巨型仓库**经常返回 0 命中**，
   因此改为**枚举目录**：列出 `manifests/{关键词首字母}` 下的 publisher 目录，过滤名字包含关键词者，
   再逐级解析其最新版本。

### 已知限制

- 关键词搜索只能匹配 **publisher 名** 包含关键词的包。
  - ✅ `winget show HandBrake` 能命中（publisher 就是 `HandBrake`）。
  - ❌ `winget show vscode` 命中不了（`Microsoft.VisualStudioCode` 的 publisher 是 `Microsoft`）。
  - 「包名命中、publisher 不命中」的场景需要额外索引，暂未实现。
- 目录枚举对首字母目录过大的 publisher（如 `m`）受 GitHub 单目录 1000 条上限影响，可能截断。

## 调试

```powershell
wrangler tail
```

Worker 会打印：

- `manifestSearch body: ...` —— winget 发来的搜索请求原始体；
- `keywordSearch: letter=h, dirs=N, matchedPubs=M` —— 目录枚举搜索的中间结果；
- `manifestSearch: no results (empty Data)` —— 确实没找到。

## 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `MIRROR` | 否 | 安装器镜像地址，如 `https://gh-proxy.org`；缺失时回退到该默认值 |
| `GITHUB_TOKEN` | 否 | 提升 GitHub API 限流（目录枚举 / 版本列举） |

## License

派生自 [lihongjie0209/cf-winget-proxy](https://github.com/lihongjie0209/cf-winget-proxy)。
