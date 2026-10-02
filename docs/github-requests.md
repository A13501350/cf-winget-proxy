# GitHub 请求点清单（瓶颈分析用）

 Worker 运行时能打到 GitHub 的一共 **3 类出口**：`api.github.com`（Contents API）、
`raw.githubusercontent.com`、`cdn.jsdelivr.net`（非 GitHub 但同源内容）。
下面按「一次用户操作会产生多少次请求」组织。

## 1. 请求封装函数

| 函数 | 位置 | 目标 | 边缘缓存 |
|---|---|---|---|
| `ghFetch()` | src/index.ts:81 | `api.github.com` | 2xx/3xx=1800s，4xx/5xx=60s；带 `GITHUB_TOKEN` |
| `fetchManifestFile()` | src/index.ts:106 | jsDelivr → 再 raw.githubusercontent | 200=3600s，其余 0 |
| `getIndex()` | src/index.ts:197 | `INDEX_URL`（本仓库 raw） | 进程内 memo 1h + 边缘 3600s |

（原先还有一个通用透明代理 `proxyRequest()`，安装器下载已改为客户端直连 `MIRROR`，
该函数与其依赖的 `/cache/**`、域名前缀路由都已删除。）

## 2. 调用点与触发条件

### api.github.com（唯一的限流来源：认证 5000/h，未认证 60/h 且出口 IP 共享）

| # | 位置 | 端点 | 由谁触发 | 单次请求数 |
|---|---|---|---|---|
| A1 | src/index.ts:245 `lookupPackageId` | `GET /contents/manifests/{l}/{Pub}/{pkg…}` | **仅**索引里没有该 id 时（索引命中直接返回，0 请求） | 1 |
| A2 | src/index.ts:385 `keywordSearch` 枚举回落 | `GET /contents/manifests/{letter}` | 索引确实未命中 | 1 |
| A3 | src/index.ts:399 `keywordSearch` 枚举回落 | `GET /contents/manifests/{letter}/{pub}` | 同上 | ≤6，**并发** |
| A4 | src/index.ts:416 `keywordSearch` 枚举回落 | `GET /contents/manifests/{letter}/{pub}/{pkg}` | 同上 | ≤36，**并发** |
| A5 | src/index.ts:585 `handlePackageManifest` | 同 A1 | 索引无该包且未带 `?Version=` | 1 |

`lookupPackageId` 现在是**索引优先**（src/index.ts:224）：先查 `getIndex()`，
命中就凭索引里的最新版本直接拼 `Versions` 返回；只有索引完全查不到这个 id
（上一次构建之后才发布的新包）才落到 A1。所有按 id 的入口 —— 精确 ID 搜索、
ProductCode 依赖解析、`NormalizedPackageNameAndPublisher`（src/index.ts:492/518/545）
—— 都走这条路径，因此依赖查询也不再多打 GitHub。

枚举回落的预算写在 `ENUM_PUBLISHERS` / `ENUM_PACKAGES`（src/index.ts:267-268），
最坏 ≈ 1 + 6 + 36 = 43 次并发请求。改造前是 `1 + 20 + 400 = 421` 次**串行**请求 ——
那才是瓶颈本身：未配 `GITHUB_TOKEN` 时一次搜索就把 60/h 的共享额度打光，
而 `ghFetch` 当时刻意不缓存 4xx，于是限流期间每个请求都真打上游、毫无退避。

现在：只有首字母是 ASCII 的关键词才允许枚举（`isEnumerableKeyword`），
索引里版本为空的条目直接丢弃而不再回查 GitHub（避免 N+1），
4xx 以 60s 的短 TTL 缓存（既不会把失败钉死，也不会反复 replay 打爆上游）。

### raw.githubusercontent.com / cdn.jsdelivr.net（不限流，只影响延迟）

| # | 位置 | 端点 | 触发 | 单次请求数 |
|---|---|---|---|---|
| B1 | src/index.ts:613 | `{id}.installer.yaml` | `packageManifests` | 1（jsDelivr 命中即停） |
| B2 | src/index.ts:614 | `{id}.yaml` | 仅 B1 未命中（单文件清单） | ≤1 |
| B3 | src/index.ts:624 | `{id}.locale.en-US.yaml` | `packageManifests` | 1 |
| B4 | src/index.ts:202 | `INDEX_URL` | 每小时每 isolate | 1 |

`INDEX_URL` 默认是 `https://raw.githubusercontent.com/A13501350/cf-winget-proxy/main/index.json`
（wrangler.toml:13）。B1–B3 是顺序 await，冷缓存下最多 6 跳；可并行化（未做）。

## 3. 每次典型操作的请求矩阵

| 操作 | api.github.com | jsDelivr/raw | 命中缓存后 |
|---|---|---|---|
| `winget search <索引内关键词>` | 0 | 0 | 0 |
| `winget search <索引外关键词>`(冷) | ≤43（并发） | 0 | 30min 内 0 |
| `winget install <id>` | 0（走索引） | 2–3 | 0 |
| 依赖解析（ProductCode） | 0（走索引） | 2–3 | 0 |
| 索引里没有的新包 | 1（A1/A5） | 2–3 | 0 |

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

重建后的索引：**15230** 条，与上游文件名集合完全一致（0 真包丢失，+12 找回，-2 垃圾），
`scripts/build-index.sh` 加了失败即退出的校验（条数下限、行格式、去重、C 转义残留），
解析器拆到 `scripts/index-parser.awk` 并由 `scripts/test-index-parser.sh` 单测。

## 5. 还能继续收敛的方向（未实施）

1. 给索引加 `Moniker` / `PackageName` 字段，让纯别名查询也不进枚举回落
   （代价：build 要读 YAML，blobless 克隆省不了流量，可改走 jsDelivr 批量拉 locale 文件）。
   现在缩写（subsequence）那一档已经临时承担了这件事 —— `vscode` → Microsoft.VisualStudioCode、
   `vlc` → VideoLAN.VLC 都不再打 GitHub —— 但它只能保证「能命中」，无法保证「排得准」：
   裸 `code` 会同时命中几十个包，谁在前没有依据。别名索引才是正解。
2. B1/B3 并行 `Promise.all`，冷缓存延迟减半。
3. `ghFetch` 加单飞（同一 URL 并发请求合并），避免多 isolate 冷缓存同时回源打爆共享额度。
4. 索引重建频率：现在是每天一次，`winget-pkgs` 每天约 200 个新提交 —— 若枚举回落仍被频繁触发，
   可加一个「按 id 集合 diff 的增量刷新」而不是整表重建。
