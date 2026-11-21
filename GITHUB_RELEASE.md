# Antigrative Dashboard v0.12.6

> [!NOTE]
> **Independent Continuation Fork (`v0.12.6`):**
> This release is published by the independent continuation fork [`ShZbz/antigravity-dashboard`](https://github.com/ShZbz/antigravity-dashboard), maintained from `v0.8.7` of the MIT-licensed open-source project `antigrative-dashboard` (`Copyright (c) 2026 AG Pulse contributors`). Releases from `v0.8.8` onward are independently developed and maintained without affiliation with or endorsement from the original upstream authors.

> [!IMPORTANT]
> **Prebuilt Rust Native Binaries Included (`pulse-accel` & `ag-pulse-statusline`):**
> Both `antigrative-dashboard-0.12.6.zip` and `antigrative-dashboard-ide-0.12.6.vsix` bundle the prebuilt `pulse-accel.<platform>-<arch>.node` addons for all 5 platforms (`win32-x64`, `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`), and the ZIP also ships the standalone `ag-pulse-statusline` CLI binaries under `cli/bin/`. You can disable native acceleration at runtime with `PULSE_DISABLE_NATIVE_ACCEL=1` (falling back seamlessly to pure TypeScript) or roll back to **`v0.11.0`** if needed.

## What's New in v0.12.6

- **Fixed Usage Modal Hover Tooltip Displacement (`src/ui/usage-modal/{dom-shell,tooltip,heatmap,focus-trap}.ts`, `src/ui/usage-modal/usage.css`):**
  - Promoted `#tip` to the browser top layer via `popover="manual"` (`inset: auto; margin: 0;` with guarded `showPopover()` / `hidePopover()`), eliminating the `position: fixed` containing-block offset (`+dialog.left`, `+dialog.top`) and `overflow: hidden` clipping caused by `#usage-dashboard`'s open `scale: 1` transition.
  - Shared `revealTip()` positioning across stacked bars, overview heatmap, 24-hour hourly spline, and project breakdown; anchored `.bar-column` tooltips directly to `.stack` instead of the full-height plot column, with a below-target fallback when above-target placement would reach the dialog top.
- **Full Calendar Day Labels on Daily Bar Chart (`src/ui/usage-modal/stacked-bar.ts`, `tools/check-usage-ui.mjs`):**
  - Rendered every `1..30/31` calendar day label from `bucket.from` in day-period view when `buckets.length <= 31` (keeping sparse ticks for longer custom ranges), and added Playwright geometric tooltip alignment and day-label completeness checks.
- **Stale Runtime File Pruning on Reinstall (`src/lifecycle/{fs-helpers,installer}.ts`, `src/platform/manifest.ts`, `manage.{mjs,py}`):**
  - Automatically prunes obsolete runtime files when reinstalling or upgrading desktop plugin folders while preserving private user directories (`data`, `history-v1`, `usage-v1`, `timeline-v1`, `sdk`) and verified native binaries.

## Downloads

- **App / CLI:** `antigrative-dashboard-0.12.6.zip` and `antigrative-dashboard-0.12.6.zip.sha256`
- **Standalone Antigravity IDE:** `antigrative-dashboard-ide-0.12.6.vsix` and `antigrative-dashboard-ide-0.12.6.vsix.sha256`

> [!IMPORTANT]
> **Standalone IDE Extension ID:** The IDE extension identifier is `shzbz.antigrative-dashboard-ide` (global storage path: `User/globalStorage/shzbz.antigrative-dashboard-ide/`). If migrating from upstream `you-should-know-me.antigrative-dashboard-ide`, quit the IDE, copy `history-v1/`, `usage-v1/`, and `preferences.json` to the new storage folder, and uninstall the old extension before relaunching. See [ide/README.md](ide/README.md).

Details: [full changelog](CHANGELOG.md) · [English README](README.md) · [IDE guide](ide/README.md) · [usage accounting](docs/USAGE.md) · [update verification](docs/UPDATES.md).

---

## 中文发布说明（v0.12.6）

> [!NOTE]
> **独立接续维护分支发布（`v0.12.6`）：**
> 本版本由基于原 MIT 协议开源项目 `antigrative-dashboard`（`Copyright (c) 2026 AG Pulse contributors`）`v0.8.7` 独立接续维护的仓库 [`ShZbz/antigravity-dashboard`](https://github.com/ShZbz/antigravity-dashboard) 发布。自 `v0.8.8` 起的所有更新均由当前仓库独立开发与维护，与原上游作者不存在从属或背书关系。

> [!IMPORTANT]
> **已内置 5 平台预编译 Rust 原生引擎：**
> `antigrative-dashboard-0.12.6.zip` 与 `antigrative-dashboard-ide-0.12.6.vsix` 均已直接内置全部 5 个平台（`win32-x64`、`darwin-arm64`、`darwin-x64`、`linux-x64`、`linux-arm64`）的预编译 `pulse-accel.<platform>-<arch>.node` 原生模块，ZIP 内 `cli/bin/` 同步附带独立原生状态栏可执行文件 `ag-pulse-statusline.*`。如需临时关闭原生加速，仍可通过环境变量 `PULSE_DISABLE_NATIVE_ACCEL=1` 无缝切回纯 TypeScript 模式。

### v0.12.6 新增与改进

- **修复用量详情弹窗悬停 Tooltip 严重偏移问题（`src/ui/usage-modal/{dom-shell,tooltip,heatmap,focus-trap}.ts`、`usage.css`）：**
  - 将 `#tip` 升级为顶层 `popover="manual"`（配合 `inset: auto; margin: 0;` 及安全的 `showPopover()` / `hidePopover()`），彻底消除 `#usage-dashboard` 打开态 `scale: 1` 导致的 `position: fixed` 包含块坐标偏移（`+dialog.left`、`+dialog.top`）及 `overflow: hidden` 裁切。
  - 统一日柱状图、活动热力图、24 小时趋势图与项目会话明细的 `revealTip()` 定位逻辑；日柱状图 Tooltip 改为锚定实际 `.stack` 柱体而非全高占位列，并在顶部空间不足时自动回退至目标下方。
- **日视图 X 轴完整展示每天日期刻度（`src/ui/usage-modal/stacked-bar.ts`、`tools/check-usage-ui.mjs`）：**
  - 当日视图桶数 `<= 31` 时依据 `bucket.from` 完整显示 `1..30/31` 每天刻度（长自定义区间仍保持稀疏刻度），并在 Playwright UI 测试中新增 Tooltip 几何对齐与日期刻度完整性校验。
- **覆盖安装时自动清理过期运行时文件（`src/lifecycle/{fs-helpers,installer}.ts`、`src/platform/manifest.ts`、`manage.{mjs,py}`）：**
  - 升级或重装桌面端适配器时自动裁剪已废弃的历史运行时文件，同时完整保留用户本地统计数据目录（`data`、`history-v1`、`usage-v1`、`timeline-v1`、`sdk`）与原生加速模块。

### 下载产物与迁移说明

- **App / CLI：** `antigrative-dashboard-0.12.6.zip`、`antigrative-dashboard-0.12.6.zip.sha256`
- **独立 Antigravity IDE：** `antigrative-dashboard-ide-0.12.6.vsix`、`antigrative-dashboard-ide-0.12.6.vsix.sha256`

更多说明请参阅 [CHANGELOG.md](CHANGELOG.md)、[中文 README](README.zh-CN.md) 与 [ide/README.md](ide/README.md)。
