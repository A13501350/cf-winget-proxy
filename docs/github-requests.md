# GitHub 请求点清单（瓶颈分析用）

**Worker 已经完全不碰 `api.github.com`** —— 不是「尽量少碰」，是代码里不存在这条路径，
打包产物中 `api.github.com` 字符串出现 0 次。运行时能打到 GitHub 的只剩两类
**静态文件出口**：`cdn.jsdelivr.net`（不限流）和 `raw.githubusercontent.com`（限流极宽）。
下面按「一次用户操作会产生多少次请求」组织。

## 1. 请求封装函数

| 函数 | 位置 | 目标 | 边缘缓存 |
|---|---|---|---|
| `fetchManifestFile()` | src/index.ts:86 | jsDelivr → 再 raw.githubusercontent | 200=3600s，其余 0 |
| `getIndex()` | src/index.ts:168 | `INDEX_URL`（本仓库 raw） | 进程内 memo 1h + 边缘 3600s |

（历史上还有三个出口，均已删除：通用透明代理 `proxyRequest()` 及其
`/cache/**`、域名前缀路由；`ghFetch()` 及其全部 Contents API 调用点；
调试用的 `/debug/echo`。）

## 2. 为什么把 api.github.com 整条砍掉

Contents API 未认证限额是 **60 次/小时，且按源 IP 计**。Cloudflare Workers 的出口 IP
是共享的，所以这个额度**不是我们的**：一次突发失败会让同一 IP 上的所有用户一起不可用，
而我们无法预判、也无法独占那个额度。原先的目录枚举回落最坏要 43 次请求（改造前是
421 次串行），也就是说**一次搜索就能把整个出口 IP 接下来一小时打光**。

因此结论是：回源不是「慢」的问题，而是「一次失败毒害所有人」的问题。索引既然是全集
（见第 4 节审计），就没有任何查询值得冒这个风险。

被删掉的调用点，以及它们现在的答案：

| 原调用点 | 现在 |
|---|---|
| `keywordSearch` 索引未命中 → 枚举 `manifests/{letter}` 三级目录 | 返回空 `Data`，`no index match` 记一行日志 |
| `lookupPackageId` 索引未命中 → 列版本目录 | 返回 null（winget 视作查不到） |
| `handlePackageManifest` 无 `?Version=` 且索引未命中 → 列版本目录 | **404**（fail close） |

保留的唯一「兜底」是 `getIndex` 刷新失败时继续沿用 isolate 里上一次成功的索引 ——
过时但正确的结果，好过一片空集伪装成「没有这个包」。

### 索引没有 = 就当没有

代价是唯一的：上次索引重建之后发布的包，在最坏一整个重建周期内查不到。
这是**故意接受**的缺口，而不是待修的 bug；缓解手段是重建频率（第 5 节），不是回源。

### 仍然存在的静态文件出口（不限流，只影响延迟）

| # | 位置 | 端点 | 触发 | 单次请求数 |
|---|---|---|---|---|
| B1 | src/index.ts:487 | `{id}.installer.yaml` | `packageManifests` | 1（jsDelivr 命中即停） |
| B2 | src/index.ts:488 | `{id}.yaml` | 仅 B1 未命中（合并式单文件清单） | ≤1 |
| B3 | src/index.ts:498 | `{id}.locale.en-US.yaml` | `packageManifests` | 1 |
| B4 | src/index.ts:173 | `INDEX_URL` | 每小时每 isolate | 1 |

B1/B2 不是「回源」：`winget-pkgs` 本身就同时存在多文件布局和合并单文件布局，
只试一个文件名会对另一种布局的包直接 404。同理 jsDelivr → raw 两个候选是同一个
静态文件的两个主机，不涉及 API 配额。

`INDEX_URL` 默认是 `https://raw.githubusercontent.com/A13501350/cf-winget-proxy/main/index.json`
（wrangler.toml:13）。B1–B3 是顺序 await，冷缓存下最多 6 跳；可并行化（未做）。

## 3. 每次典型操作的请求矩阵

| 操作 | api.github.com | jsDelivr/raw |
|---|---|---|
| `winget search <索引内关键词>` | 0 | 0 |
| `winget search <索引外关键词>` | 0（返回空 `Data`） | 0 |
| `winget install <id>` | 0 | 2–3 |
| 依赖解析（ProductCode） | 0 | 2–3 |
| 索引里没有的新包 | 0 | 0（404） |

任何一行的 api.github.com 都不可能变成非零：这条出口在源码里已不存在。

## 4. 索引完整性审计（2026-09-30）

对着 `microsoft/winget-pkgs@master` 的真实目录树逐 publisher 比对，旧索引**并不全**，
缺的不是「新包」而是两类系统性缺陷：

1. **非 ASCII publisher 全部丢失**。`git ls-tree` 会把含非 ASCII 字节的路径做 C 转义
   （`"manifests/b/BR\303\226TJE/…"`），旧解析器按 `/` 切段，转义后的引号吃掉首尾字段，
   于是这些包以 `{"id":".package","v":"GDK"}`、`{"id":".validation","v":"2404"}` 这种垃圾形式
   漏进索引，而真正的包一条没有。上游 26 个首字母目录共 8958 个 publisher，旧索引少 10 个：
   `BRÖTJE`、`Chappée`、`ClémentGrennerat`、`DaniRodríguez`、`JanJoneš`、`JanKulhánek`、
   `PlotnikovDL`、`ReceitaFederaldoBrasil`、`AccessData`、`CyberPowerSystemsInc` 等。
   → 修法是 `git -c core.quotePath=false ls-tree`。
2. **id 从路径段推导，而不是从文件名推导**。`BtbN.FFmpeg.GPL.5.1` 这种 id 的目录是
   `manifests/b/BtbN/FFmpeg/GPL/5/1/{version}/`，路径推出来的「id」少了一段，
   索引里就多了 159 条根本不存在的前缀包（搜到也装不了），同时真正含空格版本的包
   （`V1.33 - Rev. 87104`、`py310_23.5.2-0`）被「版本号必须像数字」的猜测规则误杀。
   → 改成：id 只认文件名后缀，再要求「路径重建出的 id == 文件名推出的 id」互相印证。

重建后的索引：**15230** 条（当前随上游增长到 15284），与上游文件名集合完全一致
（0 真包丢失，+12 找回，-2 垃圾），
`scripts/build-index.sh` 加了失败即退出的校验（条数下限、行格式、去重、C 转义残留），
解析器拆到 `scripts/index-parser.awk` 并由 `scripts/test-index-parser.sh` 单测。
之后每天定时重建用的都是新解析器，校验在 CI 里持续生效。

## 5. 还能继续收敛的方向（未实施）

1. 给索引加 `Moniker` / `PackageName` 字段（代价：build 要读 YAML，blobless 克隆省不了
   流量，可改走 jsDelivr 批量拉 locale 文件）。删掉回源之后这件事的性质变了：
   它不再影响「能不能查到」，只影响「排得准不准」—— 缩写（subsequence）那一档已经
   保证 `vscode` → Microsoft.VisualStudioCode、`vlc` → VideoLAN.VLC 能命中，
   但裸 `code` 会同时命中几十个包，谁在前没有依据。别名索引才是排序的正解。
2. B1/B3 并行 `Promise.all`，冷缓存延迟减半。
3. 新包隐身窗口。现在是每天 04:23 UTC 重建一次，最坏 24 小时；一次完整重建实测只花
   约 20 秒，所以频率本身很便宜。但**同时**要把 `getIndex` 的 memo 与边缘 TTL（都是 1h）
   一起降下来，否则重建得再勤 Worker 也看不见 —— 这两处必须一起改，只改 cron 是无效功。
4. 极端情况下可以让索引自己带上构建时间，搜索无命中时在日志里区分
   「这个包比索引新」和「根本没这个包」；目前不值得为实验性实现加这条分支。
