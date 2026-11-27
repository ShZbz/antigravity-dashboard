# Antigrative Dashboard v0.12.8

> [!NOTE]
> **Independent Continuation Fork (`v0.12.8`):**
> This release is published by the independent continuation fork [`ShZbz/antigravity-dashboard`](https://github.com/ShZbz/antigravity-dashboard), maintained from `v0.8.7` of the MIT-licensed open-source project `antigrative-dashboard` (`Copyright (c) 2026 AG Pulse contributors`). Releases from `v0.8.8` onward are independently developed and maintained without affiliation with or endorsement from the original upstream authors.

> [!IMPORTANT]
> **Prebuilt Rust Native Binaries Included (`pulse-accel` & `ag-pulse-statusline`):**
> Both `antigrative-dashboard-0.12.8.zip` and `antigrative-dashboard-ide-0.12.8.vsix` bundle the prebuilt `pulse-accel.<platform>-<arch>.node` addons for all 5 platforms (`win32-x64`, `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`), and the ZIP also ships the standalone `ag-pulse-statusline` CLI binaries under `cli/bin/`. You can disable native acceleration at runtime with `PULSE_DISABLE_NATIVE_ACCEL=1` (falling back seamlessly to pure TypeScript) or roll back to **`v0.11.0`** if needed.

## What's New in v0.12.8

- **Zero-UX-Regression Memory Optimization Across Rust, MCP, Sidecar & Renderer (`native/pulse-accel`, `src/mcp/*`, `src/telemetry/*`, `src/ui/*`):**
  - **Rust Native Compaction & Shared-File Project Dedup:** Interned model/scope pools, inline SHA-256 `RecordId`s, and `-1`-sentinel fields shrink native ledger memory by ~39%; multi-scope shared-file deduplication moves into Rust (`readLedgerSharedProjectSummaries`) with stamp-validated caching (eliminating the +25–28 MiB V8 heap spike on Project Stats), paired with two-tier `releaseNativeCaches('soft' | 'full')`.
  - **MCP Server Lazy Loading & 90s Idle Reclaim:** Defers heavy backend imports until first `tools/call` (-68% startup RSS delta), decouples `open_usage_dashboard` / `query_usage_stats` from instantiating `MetricsStore`, and reclaims idle native & JS caches after 90s without exiting the stdio process.
  - **Sidecar Leak Fixes, Idle Trimming & 2.2s Lightweight Polling:** Stops write-only JS `fileIndex` growth under native accel, bounds `MetricsStore.sessions` (16 LRU), SHA-256 hashes history/timeline write caches, idle-trims inactive trajectories/delegated/transcript entries (>3m) while keeping the full 8 MiB active session budget, and omits unused `conversations[]` + full `usage` during closed-modal 2.2s polls (`usageTotals` ~225 B/frame, -98% poll RSS churn, single `JSON.stringify` in CDP bridge).
  - **Host Renderer Hygiene & -46.7% Smaller Sidebar Bundle:** Attaches `focus-trap.ts` capture listeners (including non-passive `wheel`/`touchmove`) only while the usage modal is open to restore compositor scrolling, guards `mount-dom.ts` scroll/mutation hot paths, and lazy-loads `/usage-ui.js` for the sidebar fallback modal (`sidecars/panel/app.js`: `432.4 KiB → 230.3 KiB`).

## Downloads

- **App / CLI:** `antigrative-dashboard-0.12.8.zip` and `antigrative-dashboard-0.12.8.zip.sha256`
- **Standalone Antigravity IDE:** `antigrative-dashboard-ide-0.12.8.vsix` and `antigrative-dashboard-ide-0.12.8.vsix.sha256`

> [!IMPORTANT]
> **Standalone IDE Extension ID:** The IDE extension identifier is `shzbz.antigrative-dashboard-ide` (global storage path: `User/globalStorage/shzbz.antigrative-dashboard-ide/`). If migrating from upstream `you-should-know-me.antigrative-dashboard-ide`, quit the IDE, copy `history-v1/`, `usage-v1/`, and `preferences.json` to the new storage folder, and uninstall the old extension before relaunching. See [ide/README.md](ide/README.md).

Details: [full changelog](CHANGELOG.md) · [English README](README.md) · [IDE guide](ide/README.md) · [usage accounting](docs/USAGE.md) · [update verification](docs/UPDATES.md).

---

## 中文发布说明（v0.12.8）

> [!NOTE]
> **独立接续维护分支发布（`v0.12.8`）：**
> 本版本由基于原 MIT 协议开源项目 `antigrative-dashboard`（`Copyright (c) 2026 AG Pulse contributors`）`v0.8.7` 独立接续维护的仓库 [`ShZbz/antigravity-dashboard`](https://github.com/ShZbz/antigravity-dashboard) 发布。自 `v0.8.8` 起的所有更新均由当前仓库独立开发与维护，与原上游作者不存在从属或背书关系。

> [!IMPORTANT]
> **已内置 5 平台预编译 Rust 原生引擎：**
> `antigrative-dashboard-0.12.8.zip` 与 `antigrative-dashboard-ide-0.12.8.vsix` 均已直接内置全部 5 个平台（`win32-x64`、`darwin-arm64`、`darwin-x64`、`linux-x64`、`linux-arm64`）的预编译 `pulse-accel.<platform>-<arch>.node` 原生模块，ZIP 内 `cli/bin/` 同步附带独立原生状态栏可执行文件 `ag-pulse-statusline.*`。如需临时关闭原生加速，仍可通过环境变量 `PULSE_DISABLE_NATIVE_ACCEL=1` 无缝切回纯 TypeScript 模式。

### v0.12.8 新增与改进

- **全链路零体验退化内存优化（Rust 原生层 / MCP Server / Sidecar / 宿主渲染器）：**
  - **Rust 紧凑账本与跨账号共享文件原生去重：** 引入模型/作用域字符串驻留池、内联 32 字节 SHA-256 `RecordId` 与 `-1` 哨兵紧凑记录结构（账本原生内存约降 39%）；将多账号共享文件项目统计去重逻辑下沉至 Rust（`readLedgerSharedProjectSummaries`，保留 `PULSE_DISABLE_NATIVE_ACCEL=1` 回退），消除点击项目统计时的 +25–28 MiB V8 堆飙升，并新增 `releaseNativeCaches('soft' | 'full')` 两级空闲释放（`soft` 保留 50 KiB 热快照）。
  - **MCP Server 懒加载与 90s 空闲回收：** 启动与 `tools/list` 零重模块加载（冷启动内存增量约降 68%）；`open_usage_dashboard` 与 `query_usage_stats` 不再多余实例化 `MetricsStore`；空闲 90 秒在不退出进程的前提下自动释放 JS 与 Rust 缓存。
  - **Sidecar 止漏、有界裁剪与 2.2s 轻量轮询：** 修复原生模式下只写不读的 JS `fileIndex` 泄漏；为 `MetricsStore.sessions` 增加 16 条 LRU 上限并将历史/时间线写缓存替换为 SHA-256 哈希；每 60 秒自动裁剪 >3 分钟未访问的非活跃会话缓存（完整保留活跃会话 8 MiB 预算）并在 120 秒空闲后执行原生 `soft` 释放；弹窗关闭期间 2.2s 内嵌轮询仅返回轻量 `usageTotals`（省略未使用的 `conversations[]` 与完整 `usage`，并消除 CDP 桥双重 `JSON.stringify`，200 次轮询内存增量降低 98%）。
  - **主窗口滚动流畅度与侧边栏包体瘦身：** `focus-trap.ts` 的 7 个 `document` 捕获监听（含非被动 `wheel`/`touchmove`）改为仅在打开弹窗时绑定、关闭即解绑，恢复主窗口合成器快速滚动；为 `mount-dom.ts` 滚动与 `MutationObserver` 增加早退护栏；侧边栏兜底用量弹窗拆分为按需加载 `/usage-ui.js`，`sidecars/panel/app.js` 体积由 `432.4 KiB` 降至 `230.3 KiB`（-46.7%）。

### 下载产物与迁移说明

- **App / CLI：** `antigrative-dashboard-0.12.8.zip`、`antigrative-dashboard-0.12.8.zip.sha256`
- **独立 Antigravity IDE：** `antigrative-dashboard-ide-0.12.8.vsix`、`antigrative-dashboard-ide-0.12.8.vsix.sha256`

更多说明请参阅 [CHANGELOG.md](CHANGELOG.md)、[中文 README](README.zh-CN.md) 与 [ide/README.md](ide/README.md)。
