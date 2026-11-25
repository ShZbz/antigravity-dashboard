# Antigrative Dashboard v0.12.7

> [!NOTE]
> **Independent Continuation Fork (`v0.12.7`):**
> This release is published by the independent continuation fork [`ShZbz/antigravity-dashboard`](https://github.com/ShZbz/antigravity-dashboard), maintained from `v0.8.7` of the MIT-licensed open-source project `antigrative-dashboard` (`Copyright (c) 2026 AG Pulse contributors`). Releases from `v0.8.8` onward are independently developed and maintained without affiliation with or endorsement from the original upstream authors.

> [!IMPORTANT]
> **Prebuilt Rust Native Binaries Included (`pulse-accel` & `ag-pulse-statusline`):**
> Both `antigrative-dashboard-0.12.7.zip` and `antigrative-dashboard-ide-0.12.7.vsix` bundle the prebuilt `pulse-accel.<platform>-<arch>.node` addons for all 5 platforms (`win32-x64`, `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`), and the ZIP also ships the standalone `ag-pulse-statusline` CLI binaries under `cli/bin/`. You can disable native acceleration at runtime with `PULSE_DISABLE_NATIVE_ACCEL=1` (falling back seamlessly to pure TypeScript) or roll back to **`v0.11.0`** if needed.

## What's New in v0.12.7

- **Antigravity `v2.34.0+` MCP Apps Support — Full-Page Token Usage Dashboard (`src/mcp/*`, `src/ui/mcp-usage-app/*`, `mcp_config.json`):**
  - Open the full-width, full-page **Token Usage** dashboard directly from **Plugins → Token Usage** in the Antigravity left sidebar — with zero CDP debugging flags, zero modal clipping, live host light/dark & custom theme synchronization, and full feature parity (activity heatmaps, daily/weekly/monthly/custom stacked charts, 24h spline, By Model / By User / Project Stats drilldown, multi-account switching, manual entries, and `Aa` font scaling).
  - Ships an on-demand, zero-runtime-dependency stdio MCP server (`mcp/server.mjs`) and self-contained single-file HTML bundle (`mcp/apps/usage.html`, `< 1 MiB`) sharing the existing `usage-v1/` ledger, `pulse-accel.node` native engine, and `preferences.json` with zero background polling overhead while keeping the existing sidecar `aux_pane` and optional inline composer bar 100% intact.
- **Read-Only Agent Query Tools (`query_usage_stats` & `get_quota_and_session`):**
  - Ask the agent directly in chat (App, `agy` CLI, or IDE) to inspect token usage totals by period (`today` / `week` / `month` / `custom`) and dimension (`model` / `user` / `project`), or check current 5h/weekly quotas and active session TPS/cache/context metrics.
  - Minimizes the tool surface to 4 tools (with 13 UI actions multiplexed behind `pulse_usage_action`, `visibility: ["app"]`) and normalizes `plugin.json` (`displayName` + `suggestedPrompts`) to pass `agy plugin validate --strict`.
- **Windows Live-Update Fix for Locked Native Addons (`src/lifecycle/fs-helpers.ts`):**
  - Eliminates `EBUSY` failures during `manage.mjs install` on Windows when a running sidecar holds `pulse-accel.node` open by rename-swapping the locked binary to `os.tmpdir()` before copying the new build.

## Downloads

- **App / CLI:** `antigrative-dashboard-0.12.7.zip` and `antigrative-dashboard-0.12.7.zip.sha256`
- **Standalone Antigravity IDE:** `antigrative-dashboard-ide-0.12.7.vsix` and `antigrative-dashboard-ide-0.12.7.vsix.sha256`

> [!IMPORTANT]
> **Standalone IDE Extension ID:** The IDE extension identifier is `shzbz.antigrative-dashboard-ide` (global storage path: `User/globalStorage/shzbz.antigrative-dashboard-ide/`). If migrating from upstream `you-should-know-me.antigrative-dashboard-ide`, quit the IDE, copy `history-v1/`, `usage-v1/`, and `preferences.json` to the new storage folder, and uninstall the old extension before relaunching. See [ide/README.md](ide/README.md).

Details: [full changelog](CHANGELOG.md) · [English README](README.md) · [IDE guide](ide/README.md) · [usage accounting](docs/USAGE.md) · [update verification](docs/UPDATES.md).

---

## 中文发布说明（v0.12.7）

> [!NOTE]
> **独立接续维护分支发布（`v0.12.7`）：**
> 本版本由基于原 MIT 协议开源项目 `antigrative-dashboard`（`Copyright (c) 2026 AG Pulse contributors`）`v0.8.7` 独立接续维护的仓库 [`ShZbz/antigravity-dashboard`](https://github.com/ShZbz/antigravity-dashboard) 发布。自 `v0.8.8` 起的所有更新均由当前仓库独立开发与维护，与原上游作者不存在从属或背书关系。

> [!IMPORTANT]
> **已内置 5 平台预编译 Rust 原生引擎：**
> `antigrative-dashboard-0.12.7.zip` 与 `antigrative-dashboard-ide-0.12.7.vsix` 均已直接内置全部 5 个平台（`win32-x64`、`darwin-arm64`、`darwin-x64`、`linux-x64`、`linux-arm64`）的预编译 `pulse-accel.<platform>-<arch>.node` 原生模块，ZIP 内 `cli/bin/` 同步附带独立原生状态栏可执行文件 `ag-pulse-statusline.*`。如需临时关闭原生加速，仍可通过环境变量 `PULSE_DISABLE_NATIVE_ACCEL=1` 无缝切回纯 TypeScript 模式。

### v0.12.7 新增与改进

- **新增 Antigravity `v2.34.0+` MCP Apps 原生支持 — 左侧栏全页「Token Usage」大盘（`src/mcp/*`、`src/ui/mcp-usage-app/*`、`mcp_config.json`）：**
  - 彻底解决 `v2.33+/v2.34+` 默认关闭调试端口后 Token 用量大盘被迫挤在窄侧边栏的痛点：无需开启 CDP 调试参数，点击左侧导航栏 **Plugins → Token Usage** 即可直接打开**原生全宽全页**大盘（完整支持热力图、日/周/月/自定义柱状图、24h 曲线、按模型/按用户/项目统计会话下钻、多账号切换、远程用量录入、`Aa` 字体缩放与实时深/浅色主题同步）。
  - 采用 Hybrid 增量共存架构：按需惰性运行的零依赖 stdio MCP Server（`mcp/server.mjs`）与自包含单文件 HTML（`mcp/apps/usage.html`，`< 1 MiB`）与现有 Sidecar 共享本地 `usage-v1/` 账本、`pulse-accel.node` 及 `preferences.json`，空闲零后台轮询开销，完整保留既有侧边栏（含 `conversationId` 跟随）与可选底部监控条。
- **新增 Agent 只读查询工具（`query_usage_stats` 与 `get_quota_and_session`）：**
  - 支持在对话中直接向 Agent 询问各周期/各维度 Token 用量与缓存命中率、当前 5h/周额度余额及活跃会话速率（在 `agy` CLI 与 IDE 自动输出清晰 Markdown 摘要）。
  - 严格收敛工具面（内部 13 项 UI 交互合并为单一 `visibility: ["app"]` 工具 `pulse_usage_action`），并规范化 `plugin.json`（`displayName` + 3 条 `suggestedPrompts`）以通过 `agy plugin validate --strict` 严格校验。
- **修复 Windows 运行中覆盖更新遇 `pulse-accel.node` 锁定报错（`src/lifecycle/fs-helpers.ts`）：**
  - 当运行中的 Sidecar 持有 `pulse-accel.node` 导致 `manage.mjs install` 触发 `EBUSY`/`EPERM` 时，自动采用同盘 rename-swap 将旧锁定文件移出插件目录至临时目录后再写入新文件，实现无报错热部署更新。

### 下载产物与迁移说明

- **App / CLI：** `antigrative-dashboard-0.12.7.zip`、`antigrative-dashboard-0.12.7.zip.sha256`
- **独立 Antigravity IDE：** `antigrative-dashboard-ide-0.12.7.vsix`、`antigrative-dashboard-ide-0.12.7.vsix.sha256`

更多说明请参阅 [CHANGELOG.md](CHANGELOG.md)、[中文 README](README.zh-CN.md) 与 [ide/README.md](ide/README.md)。
