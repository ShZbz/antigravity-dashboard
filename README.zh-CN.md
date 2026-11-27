<div align="center">

<img src="docs/assets/hero-zh.png?v=0.8.0" width="100%" alt="Antigrative Dashboard：最新版速度、缓存和上下文控件，就在输入框旁。">

# Antigrative Dashboard

模型选择旁常驻显示生成速率、缓存命中与上下文占用；悬停上下文，一并查看上下文、5 小时和周额度详情。<br>
缩略信息常驻；鼠标悬停或打开侧边栏，展开完整多维监控。

[![Version 0.12.8](https://img.shields.io/badge/version-0.12.8-91adff?style=flat-square&labelColor=252936)](CHANGELOG.md)
[![Platforms](https://img.shields.io/badge/host-Windows%20%7C%20Linux%20%7C%20macOS-83d8b9?style=flat-square&labelColor=252936)](COMPATIBILITY.md)
[![Antigravity 2.21.1 - 2.35.1](https://img.shields.io/badge/Antigravity-2.21.1%20--%202.35.1-c5a0ff?style=flat-square&labelColor=252936)](COMPATIBILITY.md)
[![MIT](https://img.shields.io/badge/license-MIT-d4d9e6?style=flat-square&labelColor=252936)](LICENSE)

[看看效果](#看看效果) · [IDE](#antigravity-ide) · [CLI](#antigravity-cli-状态栏) · [开始安装](#安装) · [启用与停用](#可插拔) · [兼容性](#兼容性) · [常见问题](#常见问题) · [English](README.md)

</div>

> [!NOTE]
> **独立接续维护声明（Independent Continuation Fork）：** 本仓库基于原 MIT 协议开源项目 `antigrative-dashboard`（`Copyright (c) 2026 AG Pulse contributors`，原上游仓库已被作者删除）的 `v0.8.7` 版本独立接续维护。**`v0.8.8` 及之后版本**由当前仓库（`ShZbz/antigravity-dashboard`）独立开发与维护，与原作者不存在从属、合作或背书关系。

> [!IMPORTANT]
> **`v0.12.0` Rust 原生引擎提示与回退说明：** `v0.12.0` 正式引入 **Rust 原生加速引擎（`pulse-accel`）**，通过 SQLite 本地直读旁路、二进制用量索引、堆外结构化 Diff 与文本脱敏等底层加速大幅提升界面响应速度，并显著缓解早期版本长时间运行或大账本场景下内存占用过高的问题。由于新引擎刚全量上线，如您在使用过程中遇到任何异常、数据偏差或兼容性问题，欢迎及时前往 [GitHub Issues](https://github.com/ShZbz/antigravity-dashboard/issues) 反馈；如需临时关闭原生加速，可设置环境变量 `PULSE_DISABLE_NATIVE_ACCEL=1` 无缝切换回纯 TypeScript 模式，若问题暂时无法容忍亦可先回退至 **`v0.11.0`** 版本。

**v0.12.8 更新：** 全链路零体验退化内存优化 — 紧凑化 Rust 账本缓存（原生内存约降 39%）、将多账号共享文件项目统计去重下沉至 Rust（消除项目统计 +25–28 MiB V8 堆飙升）并新增 `releaseNativeCaches('soft' | 'full')` 两级空闲释放；MCP Server 懒加载（冷启动增量约降 68%）、解耦 `MetricsStore` 与 90s 空闲缓存回收；修复 Sidecar 原生模式 `fileIndex` 泄漏、为会话/历史/轨迹缓存引入 LRU 上限与 3 分钟非活跃空闲裁剪（完整保留 8 MiB 活跃预算）、内嵌栏 2.2s 轮询改传轻量 `usageTotals` 并消除 CDP 桥双重序列化（轮询内存抖动降 98%）；`focus-trap` 监听改为弹窗打开时按需绑定以恢复主窗口合成器滚动，侧边栏兜底弹窗拆分懒加载使 `app.js` 体积骤降 46.7%。

**v0.12.7 更新：** 正式接入 **Antigravity `v2.34.0+` MCP Apps** — 无需开启 CDP 调试端口，直接从左侧导航栏 **Plugins → Token Usage** 打开原生全宽全页 Token 用量大盘（实时跟随宿主主题并复用现有本地账本与 Rust 原生引擎）；新增按需零运行时依赖 stdio MCP Server（`mcp/server.mjs`）、自包含单文件页面（`mcp/apps/usage.html`）与跨端只读 Agent 查询工具（`query_usage_stats`、`get_quota_and_session`），同步规范 `plugin.json` 通过 `agy plugin validate --strict` 校验，并加固 Windows 运行中覆盖更新锁定 `pulse-accel.node` 时的自动 rename-swap 替换逻辑。

**v0.12.6 更新：** 修复 Token 用量详情弹窗悬停 Tooltip 严重偏移问题——将 `#tip` 升级为顶层 `popover="manual"` 以消除 `#usage-dashboard` 打开态 `scale: 1` 导致的 `position: fixed` 包含块偏移与裁切，柱状图 Tooltip 改为锚定实际 `.stack` 柱体并支持底部回退，同时在日视图展示全部 `1..30/31` 日期刻度；同步增强安装器在覆盖更新时自动清理过期运行时文件的能力。

**v0.12.5 更新：** 全面适配 **Antigravity `2.34.0`** — 通过宿主注入的 `ANTIGRAVITY_LS_ADDRESS` / `ANTIGRAVITY_CSRF_TOKEN` 环境变量凭据恢复云端额度与账号邮箱自动识别（附严格环回校验、PID/端口归属校验、Pro/Vertex 双实例隔离与 401/403 平滑降级）；新增无凭据时的**本地 SQLite 直读兜底模式**、侧边栏手动记录账号切换（与邮箱 SHA-256 100% 对齐）及历史会话归属迁移；修复原生 `/swarm` 子代理在侧边栏显示「未命名会话」的问题；新增 `Gemini 4 Neon (High)` (`MODEL_PLACEHOLDER_M532`) 模型映射，并优化侧边栏动画流畅度、5h 耗尽态圆环与额度实时刷新策略。

**v0.12.4 更新：** 全面适配 **Antigravity `2.33.0`**（兼容 `panelScope` 与 `auxPaneComponent` Redux 侧栏派发及 `?cascadeId=` 会话解析，修复底栏「打开侧边栏」按钮；约束非独立预览模式下侧边栏 `.widget` 卡片高度以恢复鼠标滚轮上下滚动）；将侧边栏右上角设置升级为统一齿轮弹窗（整合**可选默认关闭**的快捷方式调试启动开关、`简体中文`/`English` 语言切换以及三端 `Aa` 字体缩放），并在采样模型行新增**「用量统计」**按钮（当底栏调试未启用时可在侧边栏内嵌打开完整 Token 用量大盘）。[更新说明](CHANGELOG.md)。

**v0.12.3 更新：** 重构侧边栏面板（标题栏同心圆环多模型额度胶囊与悬停/点击倒计时弹出卡、双列 Speed/Cache 指标卡与内嵌上下文进度条、可点击折叠的详情卡区域、防跳动吸底布局及 `@container sidebar` 容器响应式断点）；优化 Token 用量弹窗标签栏账号切换器与细节布局；引入 Rust `readLedgerProjectSummariesJson` + `project-ledger-v1.bin` + `project-meta-v1.json` 与查表/二分高速时区计算以大幅提升项目统计速度；修复项目统计切换账号无法按 `viewScope` / `ownership-v1.json` 正确隔离与去重的 Bug。

**v0.12.1 更新：** 修复 `v0.12.0` 发布包未包含 Rust 原生二进制的问题，将 5 平台预编译 `pulse-accel.<platform>-<arch>.node` 与独立 CLI 二进制 `ag-pulse-statusline.*` 直接打包进 Release ZIP 与 IDE VSIX；串联 `native.yml` 与 `release.yml` 流水线、在 Windows 打包时保留 Linux/macOS 可执行权限，并在发布校验阶段强制检查 5 平台原生产物完整性。

**v0.12.0 更新：** 引入 Rust N-API 原生加速引擎（`native/pulse-accel`）与零 RPC 本地 SQLite 直读旁路，并推出原生状态栏二进制 `ag-pulse-statusline`、二进制账本增量缓存（`ledger-compact-v1.bin`）、跨进程共享 SQLite 缓存（`shared-usage-cache-v1.db`）、`.antigravity-vertex` 懒惰轮询、商用/Vertex 缓存命中率修复及三平台 CI / macOS 符号链接检查加固。

**v0.11.0 更新：** 完成全栈 TypeScript + `esbuild` 零依赖模块化重构（`src/`），建立打包与发布文件清单唯一真源（`src/platform/manifest.ts`），将生命周期安装、CLI 状态栏与 VSIX/ZIP 打包工具统一迁移至原生 Node.js（`manage.mjs`、`ide/package.mjs`，同时保留 Python 兼容回退），新增 `UsageLedger` 内存增量文件索引、连续异步分片 `TranscriptReader`、远程会话 `64 KiB` 流式投影、`WeakRef` 轨迹缓存防泄漏以及并发隔离 Playwright UI 回归测试套件。

**v0.9.0 – v0.10.2：** 新增云端 Remote Agent 会话支持（50 步尾部窗口冷读与增量切片）、混合 Orchestrator 身份与多模型 SVG 环形占比图、可选结构化调用时间线树（`modelTimelineEnabled`，默认关闭）、多账号严格隔离与切换查看（`全部账号汇总`、`按模型 / 按用户` 维度、`简易 / 详细` 模型变体归并、远程项目手动录入）、24 小时趋势折线图、自定义日期范围、单柱下钻以及多层子代理/Swarm 上下文占用环与状态树。

## 看看效果

<img src="docs/assets/responsive-zh.png?v=0.8.0" width="100%" alt="最新版主对话窄窗口三图标布局，以及子代理输入框旁的独立统计。">

<table>
<tr><th width="50%">生成速度、缓存与多模型环形分布</th><th width="50%">上下文与共享额度</th></tr>
<tr>
<td width="50%" valign="top"><img src="docs/assets/speed.png?v=0.11.0" width="100%" alt="会话统计卡片：模型与工具用时、TTFT、会话与最近请求 TPS 及打开侧边栏入口"><br><img src="docs/assets/widget.png?v=0.11.0" width="100%" alt="Token 用量卡片：缓存命中率、任务总 Token、子代理汇总与 36px 多模型占比环"></td>
<td width="50%" valign="top"><img src="docs/assets/context-zh.png?v=0.8.0" width="100%" alt="最新版上下文、5h 和周额度详情，以及持久化语言切换入口"></td>
</tr>
</table>

<table>
<tr><th width="50%">子代理与 Swarm 状态树</th><th width="50%">可选结构化模型调用时间线</th></tr>
<tr>
<td width="50%" valign="top"><img src="docs/assets/sidebar-subagents.png?v=0.11.0" width="100%" alt="侧边栏 Subagents 区域：5 个 Swarm Worker 的实时状态圆点、模型标签、TPS、Token 用量与上下文占用环"></td>
<td width="50%" valign="top"><img src="docs/assets/sidebar-timeline.png?v=0.11.0" width="100%" alt="侧边栏 Model timeline 区域：Plan / Worker / Tools·Agents 水平泳道与可折叠 Turn / Handoff 调用树"></td>
</tr>
</table>

<table>
<tr><th width="50%">每日 / 每周活动热力图</th><th width="50%">多账号与按模型/按用户统计</th></tr>
<tr>
<td width="50%" valign="top"><img src="docs/assets/usage-overview-zh.png?v=0.8.0" width="100%" alt="Token 用量活动概览，支持每日和每周贡献图"></td>
<td width="50%" valign="top"><img src="docs/assets/usage-details.png?v=0.11.0" width="100%" alt="Token 用量详情：支持全部账号汇总、按模型/按用户、简易/详细分组以及天/周/月/自定义日期柱状图"></td>
</tr>
<tr>
<th colspan="2">24 小时趋势折线图、简易/详细模型变体归并与远程项目手动录入</th>
</tr>
<tr>
<td colspan="2"><img src="docs/assets/usage-hourly-breakdown.png?v=0.11.0" width="100%" alt="24 小时平滑趋势折线图、可展开模型变体明细表格与远程项目手动录入列表"></td>
</tr>
</table>

<sub>上方包含实机采集截图与控件源码示意渲染。主对话与子代理统计分别独立计算，账号额度全局共享；上下文百分比读取最近请求开始时的宿主估计值，而非会话累计输入。中英文显示可随时在上下文详情卡底部或用量窗口右上角一键切换并跨重启保存。</sub>

**不用停下手头的工作，关键指标始终在视线之内。**

| 看见真实速度 | 掌握额度余额 | 洞察多代理与多模型协同 |
| --- | --- | --- |
| 会话加权 TPS、已结算最近请求速率、模型 / 工具用时、首 token 时间及一键打开侧边栏。 | Gemini 与 Claude/GPT 独立 5h、周余额及实时重置倒计时。 | 多模型 SVG 环形占比图、多级 Swarm/子代理上下文占用环与可选结构化调用时间线树。 |

### 它还处理了这些细节

- **Token 用量与多模型占比环。** 紧凑展示总 Token 与缓存命中率；悬停查看未缓存输入、缓存读取、输出、根任务总计（`Task total tokens`）与子代理汇总（`Subagents`）。当会话或任务涉及 2 个及以上模型时，内联卡片自动渲染 `36px` Top-3 多模型 SVG 环形图，侧边栏同步提供 `78px` 交互式环形图与明细列表（支持 `总计 / 输出 / 调用` 与 `仅当前会话 / 包含子代理` 切换）。
- **Hybrid Orchestrator 混合模型识别。** 精确映射 `Orchestrator (Argon)`（`M668`）、`Gemini Flash`（`M669`）、Gemini 4 Argon/Hydrogen/Carbon 与 Claude 5.5 系列占位符，在侧边栏展示 `Orchestrator (Argon) → Gemini Flash` 协同流向，并在规划模型与执行模型分属不同配额池时给出配额拆分提示。
- **多级子代理与 Swarm 状态树（`Subagents`）。** 自动提取 `invokeSubagentSpec`（`role`、`typeName`、`conversationId`）并传递解析多级委派子代理，展示语义化状态圆点（运行中、等待中、已完成、空闲、异常、已停止）、本地化状态文案、各子代理实时 TPS、Token 总量、圆形上下文占用环及可展开性能明细（`ℹ`），轮询刷新不丢失折叠状态。
- **可选结构化模型调用时间线（`modelTimelineEnabled`）。** 默认关闭（`modelTimeline: null`，零 `timeline-v1` 磁盘写入）。在侧边栏开启后，仅提取纯结构化元数据（绝不记录提示词、回复、思考文本、文件路径或命令参数），渲染 `Plan` / `Worker` / `Tools·Agents` 三泳道概览条与可折叠 `Turn → Phase → Model Call / Tool Group / Subagent` 调用树（磁盘上限 `<= 400` 节点 / `<= 192 KiB`），支持一键清空（`Clear`）与关闭（`Disable`）。
- **Cloud Remote Agent 远程会话支持。** 完整适配 `v1/default/jetski_remote_agents_3p/...` 云端远程项目，支持 50 步尾部窗口冷读、后台稀疏数组异步补全、基于 `initialStepsPageBounds` 的增量切片、`64 KiB` 流式 Connect+JSON 帧投影与卡死 `RUNNING` 状态自动重校。
- **防误触悬停、稳定菜单与紧凑布局。** 首次悬停等待 250ms，卡片展开期间切换指标零延迟；轮询期间额度组下拉菜单保持打开且倒计时每秒跳动；窄窗口下通过 240ms WAAPI 动画平滑降级为三个可交互图标，不遮挡宿主原生按钮。
- **主题自适应与本机隐私保护。** 自动跟随 Antigravity 深浅模式与自定义背景、卡片、文字、强调色；全部数据通过本机回环接口采集并保存在本地，绝不上传第三方服务。

## Antigravity IDE

**v0.7.0+** 提供反重力独立 IDE 的专用 VSIX 适配。从发布页下载
`antigrative-dashboard-ide-0.12.8.vsix`，在 IDE 扩展页选择「从 VSIX 安装」，无需先装桌面 App。

完全退出 IDE 后，使用带
`--remote-debugging-port=0 --remote-debugging-address=127.0.0.1`
参数的快捷方式启动。窄栏显示三个可交互图标，拉宽后显示数值；悬停或点击即可查看详情与本地 Token 用量大盘。

Windows IDE **2.5.5** 已验证真实对话；Linux/macOS IDE 具备三平台 CI 自动化覆盖，登录后的实机 GUI 验收仍待完成。VS Code、Visual Studio、JetBrains、Zed、Xcode 扩展暂不支持。详见 [IDE 安装、更新、诊断和数据清理](ide/README.md)。

## Antigravity CLI 状态栏

**v0.6.0+** 提供独立的 CLI 官方 `statusLine` 适配：展示上下文占用、当前请求缓存命中率與读取 Token、状态、分组额度及重置倒计时，支持中英文和终端宽度适配。额度数字与进度条按剩余量分档着色：**≥70% 绿色、≥30% 且 <70% 黄色、<30% 红色**。预览：`node cli/statusline.mjs --preview --language zh-CN`；安装：`node manage.mjs install-cli` 或 `python manage.py install-cli`（Linux/macOS 用 `python3`）。详见 [CLI 使用及撤回](docs/CLI.md)。

![真实 Antigravity CLI 两轮对话及当前请求缓存率](docs/assets/cli-conversation-zh.png?v=0.8.4-cli-1)

<sub>Linux Antigravity CLI 1.3.3 真实中文两轮对话，当前请求缓存率 95.4%、缓存读取 13.1K；账号邮箱已遮挡。</sub>

## 安装

以下命令安装**桌面 App 适配器**；IDE 用户请使用[上方专用 VSIX 安装流程](#antigravity-ide)。

适用于 **Windows / Linux / macOS 的 Antigravity 桌面 App 2.21.1 / 2.22.0 / 2.33.0 + Node.js 20+（或通过安装脚本直接调用宿主自带 Electron 运行时）或 Python 3.10+**。三系统共用同一个 release ZIP，零第三方 npm / pip 运行时依赖。完整验证范围见 [COMPATIBILITY.md](COMPATIBILITY.md)。

> 模型选择旁的内嵌位置通过标准 sidecar 与本地渲染调试端口挂载控件，默认安装绝不修改 `resources/app.asar`。原生侧面板同时作为常驻多维监控面板与备用入口。

下载 [最新 Release](https://github.com/ShZbz/antigravity-dashboard/releases/latest) 的 ZIP 并解压到固定目录，或克隆仓库：

```powershell
git clone https://github.com/ShZbz/antigravity-dashboard.git
cd antigravity-dashboard
node manage.mjs install
```

Windows 用户也可直接运行 `./install.ps1`，Linux / macOS 运行 `sh install.sh`（自动优先使用本机 Node.js 20+ 或宿主 Electron Node 运行时，并保留 `python3 manage.py install` 兼容回退）。请勿使用 sudo。

完全退出并重新打开 Antigravity，打开对话即可在模型选择右侧看到监控条。**请保留解压后的源码目录**，以便后续启停、升级和卸载。

<details>
<summary><strong>让 Agent 帮你安装：展开完整提示词</strong></summary>

```text
请帮我安装并启用 Antigrative Dashboard。
仓库：https://github.com/ShZbz/antigravity-dashboard
1. 读取 README.md、COMPATIBILITY.md、docs/CLI.md 和 ide/README.md。先用只读检查
   分析系统、可执行文件、宿主版本和已有插件配置，区分桌面 App、Antigravity CLI
   （agy）和独立 Antigravity IDE；不能仅凭系统判断安装目标。
2. 下载安装包或修改配置前，向我说明检测到哪些宿主，并让我明确确认要安装
   App、CLI 还是独立 IDE 适配。如同时安装了多个，让我选一个或多个；无法识别
   则询问可执行文件路径。不要因为我是 Linux 或在终端里就默认安装桌面端。
3. 查询最新稳定发布，说明插件版本、宿主版本和路径、选定适配器。App 与 CLI
   共用 ZIP，但安装命令不同；独立 IDE 使用单独 VSIX。只下载已确认目标需要的
   文件并校验 SHA256，将源码解压到固定目录。不要未经单独确认安装、升级、
   降级或替换 Antigravity 宿主。
4. 使用 Node.js 20+（node manage.mjs ...）或 Python 3.10+（python/python3 manage.py ...）执行：
   - App：先 node manage.mjs status，再 node manage.mjs install（或 python manage.py install）。
   - CLI：检查 agy --version 和 Node.js 20+，执行 node manage.mjs install-cli，
     不要执行桌面版 install。已有 statusLine 按 CLI 文档备份／覆盖流程处理。
   - 独立 IDE：通过 Install from VSIX... 安装发布版 VSIX，或使用
     node ide/manage.mjs install --exe <已核实的IDE可执行文件> --vsix <发布版VSIX>。
     不需要桌面 App，不要执行 App 安装器。
5. 保留其他设置和已保存数据。需要重启或登录时先告知，不强制结束正在执行的
   任务。IDE 按文档保留本机回环调试启动参数；CLI 在新会话中验证。
6. 在选定的真实宿主中验证，报告插件／宿主版本、安装目标和路径、实际完成的
   检查、剩余步骤，以及该适配器的停用／卸载方法。下载 ZIP 不代表 CLI 已安装成功。
```

</details>

## 可插拔

### 打开 App 侧边栏面板

在会话统计悬浮卡底部点击 **打开侧边栏（Open sidebar →）**，或用右上角开关展开右侧辅助栏并点击 **＋ → Extensions → Antigrative Dashboard**。重构后的侧边栏在标题栏以同心圆环胶囊常驻展示多模型 5h/周额度并支持悬停/点击查看倒计时详情，顶部三栏卡片直观呈现速率、缓存与内嵌上下文进度条，支持点击激活标签平滑折叠详情区与防跳动吸底布局，并通过 `@container sidebar` 自适应任意侧栏宽度，同时集成多模型交互环形图、多级子代理状态树、可选结构化调用时间线与独立 `Aa` 字体缩放设置。

在项目目录运行（`node manage.mjs <action>` 或 `python manage.py <action>`，可通过 `--instance (all|pro|vertex)` 指定单实例或双实例同步）：

| 操作 | 命令 | 行为 |
| --- | --- | --- |
| 安装 / 更新插件 | `node manage.mjs install` | 复制运行时适配器，保留其他配置和历史统计 |
| 停用 | `node manage.mjs disable` | 关闭插件，缩略条在下一次轮询隐藏 |
| 启用 | `node manage.mjs enable` | 启动插件并重新显示控件 |
| 查看状态 | `node manage.mjs status` | 检查安装、开关和控件连接健康状态 |
| 卸载 | `node manage.mjs uninstall` | 移除本插件目录，保留历史统计与旧版备份 |

首次安装、更新插件代码或卸载后需要完整重启 App；启停开关无需重装。`./uninstall.ps1` / `sh uninstall.sh` 等同于卸载命令。`node manage.mjs install --panel-only` 仅安装原生 sidecar 面板。

## 数据如何计算与计时质量

| 项目 | 口径 |
| --- | --- |
| 上下文窗口 | 最近一次请求开始时的 `estimatedTokensUsed` / `maxContextTokens`；容量未知时显示不可用 |
| 缓存命中率 | 缓存读取 ÷（未缓存输入 + 缓存读取 + 缓存写入），按请求 Token 总量加权；缓存写入不算命中 |
| 总 Token | 未缓存输入 + 缓存读取 + 缓存写入 + 输出（含思考输出）；`Task total tokens` 汇总根会话与全部委派子代理 |
| 会话 TPS | 有效请求的输出 Token 总数 ÷ 对应流式时长总和 |
| 最近一次 TPS | 最近一次已完成有效请求的输出 Token ÷ 流式时长；生成中显示「计算中…」 |
| TTFT / 模型 / 工具用时 | 首 token 平均耗时（不计入流式 TPS）、TTFT + 流式时长总和、工具执行区间去重合并时长 |
| 5h / 周余额与倒计时 | 账户返回的 `remainingFraction` 与 `resetTime` 差值 |

输出集中到达或长 TTFT 后短促刷出工具调用时，宿主记录的流式窗口可能只有几毫秒。插件在不设人为速度上限的前提下筛除异常计时样本：
- **不计入 TPS 的样本：** Token 口径分裂（`token-scope`）、重复记录冲突、无对应计时的重试记录、零 Token 样本，以及缓冲式工具调用窗口（`short-tool-window`：流式时长 `< 5s`、`TTFT >= 1s` 且 `TTFT / duration >= 12`）。
- **同模型短样本离群过滤：** 同一模型、供应商和原始 Token 口径下至少有 2 次时长 `>= 1s` 的有效采样后，时长 `< 1s` 且超过 `max(中位数 × 2.5，中位数 + MAD × 6)` 的短时尖峰将被隔离。
- **流式思考与生成中防抖：** 持续流式思考（`duration >= 15s` 或 `duration >= max(2s, 2 × ttft)`）使用完整 `outputTokens` 配对 `streamingDuration`；执行中会话将「最近一次请求」锚定在已完成请求上，避免工具调用期间闪烁误报「计时异常」。详见[计时策略与限制](docs/TPS.md)。

## 对话统计持久化与长对话采集

已完成请求的 TPS、缓存、多模型分布和白名单上下文估算自动保存至 `~/.gemini/antigravity/sidecar_data/antigravity-pulse/panel/data/history-v1/<账号哈希>/<对话ID>.json`（详见[上下文口径](docs/CONTEXT_LIMITS.md)）。本地长对话与云端 Remote Agent 会话采用偏移分页读取（`includeMessages: false`）、`64 KiB` 流式 JSON 投影与 `8 MiB` `WeakRef` 有界缓存，不保留对话正文或工具输出（详见[长对话采集](docs/LONG_CONVERSATIONS.md)）。

## 本地 Token 用量统计

打开缓存 / 数据库图标并点击「查看用量统计」：
- **活动概览（Activity）：** 每日与每周贡献热力图。
- **用量详情（Usage details）：** 支持 **天 / 周 / 月 / 自定义日期范围** 堆叠柱状图与单柱点击下钻、**按模型统计 / 按用户统计 / 项目统计** 三维切换、**简易 / 详细** 模型变体归并（支持点击分组行展开 `[N variants ▸]` 变体明细）、**项目统计**会话级下钻（自动归并工作区路径与 worktree 会话、可展开子代理明细与联动 SVG 环形分布图，由 Rust `readLedgerProjectSummariesJson` + `project-ledger-v1.bin` + `project-meta-v1.json` 加速与持久化）、**24 小时交互式平滑趋势折线图**（区间汇总 / 今日视图）、三端独立 `Aa` 字体缩放（`80%`–`150%`）以及 **远程项目手动录入（`+ Remote Usage`）**。
- **多账号隔离与增量索引：** 通过 `ownership-v1.json` 与请求级去重严格按账号隔离会话归属（全面覆盖「按模型」「按用户」与「项目统计」三个维度），内置内存 `fileIndex`、二进制 `ledger-compact-v1.bin` / `project-ledger-v1.bin` 增量缓存与分批回填检查点，支持切换单账号或查看「全部账号 (汇总)」（`All Accounts (Aggregated)`）。

桌面路径：`~/.gemini/antigravity/sidecar_data/antigravity-pulse/panel/data/usage-v1/`；IDE 路径：`User/globalStorage/shzbz.antigrative-dashboard-ide/usage-v1/`。日期按 `Asia/Shanghai`（UTC+8）划分，周一为每周起始。详见[统计口径、清理和边界](docs/USAGE.md)。

## 兼容性

当前实机验证：**Windows 11 / Antigravity App 2.21.1、2.22.0** 及独立 **Antigravity IDE 2.5.5**（专用 VSIX）。Linux/macOS 具备三系统 CI 自动化覆盖，完整登录 GUI 仍待实机验收。

> **验证与素材说明：** 上方沿用的 `v0.8.0` 顶部横幅/窄窗响应式/上下文/活动热力图/CLI 示意图及 [COMPATIBILITY.md](COMPATIBILITY.md) 中 `v0.8.7` 及以前的基线验证描述源自原上游项目（`AG Pulse contributors`）；`v0.8.8+` 新增特性与 `v0.11.0` 更新的会话统计卡、多模型环形卡片、子代理/Swarm 状态树、调用时间线树及多账号用量详情截图由当前维护者（`ShZbz`）独立实机验证。

[完整边界与更新策略 →](COMPATIBILITY.md)

## 常见问题

<details><summary><strong>安装后没出现？</strong></summary>

确认已完全退出主进程再启动 App。执行 `node manage.mjs status`（或 `python manage.py status`），检查 `~/.gemini/antigravity/sidecar_data/antigravity-pulse/panel/logs/sidecar.log` 和 `data/integration-state.json`。

</details>

<details><summary><strong>为什么新对话没有 tok/s？</strong></summary>

尚无已完成请求统计时刻意隐藏，防止显示旧会话速率；完成一次模型响应后自动出现。

</details>

<details><summary><strong>为什么 Gemini 与 Claude/GPT 的余额不同？</strong></summary>

服务端返回两个独立共享额度组。控件默认跟随当前模型，也可在上下文详情卡的额度菜单中切换查看另一组。

</details>

<details><summary><strong>升级 Antigravity 后怎么办？</strong></summary>

App 更新不会覆盖用户插件目录中的运行时适配器，后台会自动重新发现端口、凭据和渲染窗口。详见[鲁棒性分析](docs/ROBUSTNESS.md)。

</details>

## 开发与发行

```powershell
npm run typecheck
npm run build
npm test
npm run test:lifecycle
npm run package
```

全栈 TypeScript 源码位于 `src/`（`contracts`、`shared`、`platform`、`telemetry`、`ui`、`lifecycle`），通过 `tools/build.mjs`（`esbuild`）编译生成零外部依赖的 `sidecars/panel/`、`compat/`、`ide/`、`cli/` 与 `manage.mjs` 运行时产物。ZIP 与 VSIX 发行包及 `.sha256` 校验文件输出到 `dist/`。

[开发说明 →](docs/DEVELOPMENT.md) · [版本记录 →](CHANGELOG.md)

## 许可与 App 手动更新

源码使用 [MIT](LICENSE) 许可证。在**上下文详情 → 右下角 ⋯ → 检查更新**中可手动检查并安装稳定发行版（详见 [校验、恢复及边界说明](docs/UPDATES.md)）。
