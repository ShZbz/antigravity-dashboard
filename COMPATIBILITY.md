# 兼容性与验证范围

| 系统 | 安装 / 后台发现 | 验证范围 |
| --- | --- | --- |
| Windows | Node.js / Python / PowerShell，CIM 筛选 standalone + 单次 netstat / Get-NetTCPConnection PID 监听端口 | Windows 11 / 桌面 App 2.21.1、2.22.0、2.33.0、2.34.0；真实对话上下文、合并悬浮卡、多模型环形图、子代理/Swarm 状态树、调用时间线、侧边栏齿轮设置、环境变量 RPC 额度与多账号账本已实机验证；CI 生命周期与数据测试 |
| Linux | Node.js / Python3 / POSIX shell，当前用户 `/proc` + TCP/TCP6 socket inode | Ubuntu CI 原生端口测试、安装生命周期、官方 2.21.1 资源与 SDK 检查；完整登录 App GUI 待用户实机验证 |
| macOS | Node.js / Python3 / POSIX shell，当前用户 `ps` + `lsof` PID 所属端口 | macOS CI 原生端口测试、安装生命周期、官方 2.21.1 资源与 SDK 检查；完整登录 App GUI 待用户实机验证 |

上表面向 **Antigravity 桌面 App 2.21.1 / 2.22.0 / 2.33.0 / 2.34.0**（含 2.33.0 默认关闭调试端口下的纯侧边栏用法统计入口与可选桌面快捷方式调试开关，以及 2.34.0 环境变量本地 RPC 凭据恢复与无凭据时本地 SQLite 直读兜底）。CLI 使用独立 `statusLine` 适配；独立 Antigravity IDE 使用专用 VSIX。VS Code、Visual Studio、JetBrains、Zed、Xcode 中的 Antigravity 扩展以及 iOS 尚未兼容。Linux/macOS 官方资源检查固定为桌面 App 2.21.1，不等同于验证 IDE 或其 2.22.0 登录界面。

自 **v0.11.0** 起，生命周期管理支持原生 Node.js（`node manage.mjs <action>`，或通过 `./install.ps1` / `sh install.sh` 自动调用本机 Node.js 20+ 或宿主内置 `ELECTRON_RUN_AS_NODE=1`）以及 Python 3.10+ 兼容入口（`python manage.py <action>`），零第三方 npm / pip 运行时依赖。自 **v0.12.0** 起，可选原生 Rust 加速模块（`sidecars/panel/pulse-accel*.node` 与独立 CLI 二进制 `ag-pulse-statusline`）在可用时自动启用；未编译原生模块或设置 `PULSE_DISABLE_NATIVE_ACCEL=1` 时自动无缝回退至纯 TypeScript 实现。后台使用宿主 Node，内嵌桥接需原生 WebSocket，建议 Node 20+ / 24。官方系统要求见 [Antigravity 下载页](https://antigravity.google/download)。

## Antigravity 自带 IDE

专用包为 `antigrative-dashboard-ide-0.12.6.vsix`，安装入口与桌面 App 独立。
Windows 11 / IDE 2.5.5（VS Code base 1.107.0）已用真实对话验证速率、缓存、上下文、重启历史恢复和窄宽布局。
Linux/macOS 的 IDE 进程筛选、端口归属、安装打包（含解包 Node 入口冒烟测试）和 Trusted Types 浏览器 fixture 纳入 CI；登录后的 IDE GUI 仍待实机验收。
当前仅支持默认用户 profile；私有 Preact/DOM 或 RPC 变化可能需要适配，不能保证未来 IDE 版本无需维护。
插件需通过 loopback renderer 端口挂载：完整退出后带 `--remote-debugging-port=0 --remote-debugging-address=127.0.0.1` 参数启动。普通启动不会自动打开此端口。
不修改应用归档或 CSP，扩展启动／停止后台，并按 profile 协调多窗口所有权。用户数据保存在 IDE 自己的 extension global storage（`User/globalStorage/shzbz.antigrative-dashboard-ide/`），与桌面 App 的历史和语言设置独立。
完整安装、升级、数据清理与撤回流程见 [ide/README.md](ide/README.md)。

## 安装、双实例与自定义位置

- Windows：`node manage.mjs install`、`./install.ps1` 或 `python manage.py install`。
- Linux/macOS：`node manage.mjs install`、`sh install.sh` 或 `python3 manage.py install`。
- 启停、状态、卸载同样使用 `node manage.mjs <action>`、`python3 manage.py <action>` 或 `./uninstall.ps1` / `sh uninstall.sh`。不要使用 sudo，否则会安装到错误用户目录。
- 双实例支持：`install`、`enable`、`disable`、`status`、`uninstall` 均支持 `--instance (all|pro|vertex)`（默认 `all`），可对称管理默认 Pro 实例与 `.antigravity-vertex` 隔离实例。

默认查找 Windows 用户安装目录、macOS `/Applications/Antigravity.app` 与 `~/Applications/Antigravity.app`、Linux `/opt/Antigravity`、`/opt/antigravity`、`/usr/share/antigravity`，以及 PATH 中启动器所在目录。
自定义安装：`node manage.mjs install --app-path '/path/to/resources/app.asar'`；安装器记住资源位置供 SDK 发现。
`AG_PULSE_APP_ASAR` 可覆盖生命周期检测位置；`AG_PULSE_PROFILE` 可在安装时指定用户配置目录并保存。
如果宿主省略 SDK 解析与语言服务器路径，可用 `ANTIGRAVITY_AGENTAPI_EXE` 指定其已安装的语言服务器，或 `AG_PULSE_APP_RESOURCES` 指定资源目录。环境变量应传给启动 App 的环境。

语言服务日志：Windows/Linux 默认读取 `<profile>/logs/language_server.log`（及 Windows `.gemini` 日志回退）；macOS 优先读取 `~/Library/Logs/Antigravity/language_server.log`，缺失或不能匹配当前 PID 端口时回退到 profile 日志。`AG_PULSE_LOG` 可显式指定唯一日志位置。回退仍校验当前进程拥有该 HTTP 端口，不连接旧日志中的失效接口。

## 独立用户数据目录

| 内容 | Windows | Linux | macOS |
| --- | --- | --- | --- |
| App profile | `%APPDATA%/Antigravity` | `${XDG_CONFIG_HOME:-~/.config}/Antigravity` | `~/Library/Application Support/Antigravity` |
| 插件设置 | `%LOCALAPPDATA%/AntigravityPulse/settings.json` | `${XDG_DATA_HOME:-~/.local/share}/AntigravityPulse/settings.json` | `~/Library/Application Support/AntigravityPulse/settings.json` |
| 用户偏好 | `%LOCALAPPDATA%/AntigravityPulse/preferences.json` | `${XDG_DATA_HOME:-~/.local/share}/AntigravityPulse/preferences.json` | `~/Library/Application Support/AntigravityPulse/preferences.json` |
| 备份 | `%LOCALAPPDATA%/AntigravityPulseBackups` | `${XDG_DATA_HOME:-~/.local/share}/AntigravityPulseBackups` | `~/Library/Application Support/AntigravityPulseBackups` |

三系统插件均位于 `~/.gemini/config/plugins/antigravity-pulse`；数据目录位于 `~/.gemini/antigravity/sidecar_data/antigravity-pulse/panel/data/`（宿主可覆盖 data 目录），包含：
- `history-v1/<account-hash>/<conversation-id>.json`：单会话最新统计快照。
- `usage-v1/`：按账号严格隔离（`ownership-v1.json`、`accounts-v1.json`、`backfill-v1.json`）的本地 Token 历史用量账本，以及可选加速缓存与元数据索引（`ledger-compact-v1.bin`、`project-ledger-v1.bin`、`project-meta-v1.json`）。
- `timeline-v1/<account-hash>/<conversation-id>.json`：仅在用户显式开启 `modelTimelineEnabled`（默认关闭）时写入的有界结构化调用时间线树（`<= 400` 节点 / `<= 192 KiB`）。

更新、重装、卸载保留统计数据，不保留已卸载的运行代码。设置开关保留其他插件和自定义字段。

## 上下文数值的含义

最近一次 chat model 的 `chatStartMetadata.contextWindowMetadata` 中，`estimatedTokensUsed` 是宿主估计，`maxContextTokens` 是该请求容量（云端 Remote Agent 会话由 `modelInfo.maxTokens` 合成）。已用 = used/max，剩余不小于零。
这是请求开始时的采样，非会话累计 Token，非实时流式计数。悬停卡明确注明来源、采样模型和历史恢复时间。没有容量就不显示百分比，不通过模型名称猜容量；新模型没有元数据就不沿用旧模型窗口。压缩后允许下降。

## 更新与失败恢复

默认安装不修改 `resources/app.asar`（历史版本主动注入 `patch-loader.py --apply` 已退役，仅保留经 SHA-256 严格校验的旧备份还原能力），由用户插件中的运行时适配器通过宿主现有 loopback 调试通道挂载。每 3 秒重试端口变化、文档替换与窗口重启。只允许 loopback 主 frame，通过受限桥接传递白名单统计。后台凭据仅在内存使用，匹配当前 PID 所属 HTTP 端口。

三系统共用同一套合并布局和 V4 桥接协议。每个宿主后台具有独立实例标识与绑定；data 目录中的 `active-sidecar.json` 由新实例原子接管，旧实例每 2 秒检测接管后解绑退出。启动接管用短期文件锁串行化，异常退出的锁可恢复；不终止无关 PID。

内嵌悬浮卡与侧边栏多模型额度弹出卡均通过浏览器原生 popover 顶层展示（侧边栏支持 CSS Anchor Positioning 并保留视口回退定位），避免输入区或容器裁剪导致按钮遮挡；不支持该 API 的旧宿主回退为普通固定定位。侧边栏通过 `@container sidebar` 容器查询随面板自身宽度自适应布局，控件、卡片、图表与配额菜单自动跟随宿主深浅主题与自定义 `--primary`、`--background`、`--foreground` 颜色并校正对比度。

汉化与子代理兼容：通过 WAI-ARIA 可编辑语义、稳定 `data-testid` 与最近 `[data-cascade-id]` 作用域定位主对话与多级子代理输入区；完整数值放不下时通过 240ms WAAPI 动画平滑降级为三个图标，发生实际可见碰撞时安全隐藏。

只保存白名单统计、模型/状态与结构化调用元数据，不保存正文、标题、凭据、原始上下文或命令参数。完整故障矩阵见 [ROBUSTNESS.md](docs/ROBUSTNESS.md)。
