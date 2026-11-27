# 开发与验证（v0.11.0+ / v0.12.x）

## 架构与目录结构

自 **v0.11.0** 起，项目采用 **全栈 TypeScript 模块化源码（`src/`，单文件 `<300` 行）+ `esbuild` 零依赖原位编译产物** 架构；自 **v0.12.0** 起新增可选 **Rust N-API 原生加速层与独立 CLI（`native/pulse-accel`，含 SQLite 旁路、`ledger_index.rs`、`project_ledger.rs` 等模块）**。编译产物直接输出至宿主期望的原始入口路径（`sidecars/panel/`、`compat/`、`ide/`、`cli/` 与根目录 `manage.mjs`），在消除运行时 `module.exports` 字符串切片拼装与跨层协议漂移的同时，保持用户端零 `node_modules` / 零 `pip` 依赖分发：

```text
src/
├── contracts/              IPC、指标、用量账本、调用时间线与偏好设置的唯一类型契约 (SSOT)
├── shared/                 数字/时间格式化、WCAG 色彩合成、Trusted-Types DOM、原子写盘、PID 文件锁与零依赖 ZIP
├── platform/               manifest.ts (打包与脱敏清单唯一真源)、Pro + Vertex 双实例路径、DevTools 发现与实例锁
├── telemetry/              后端遥测核心库 (projector/, reader/, client/, metrics/, delegation/, ledger/, timeline/, store/)
├── ui/                     前端组件与样式 (host-adapter/, inline-widget/, usage-modal/, panel-webview/, update-banner/, shared/)
├── ide/                    独立 Antigravity IDE 扩展与发现适配器
└── lifecycle/              安装/双实例同步 (installer.ts)、ZIP/VSIX 打包与发布 (packager.ts)、CLI 状态栏与脱敏导出 (sanitizer.ts)

编译输出与工具层：
├── tools/build.mjs         esbuild 零依赖多目标构建器 (51 个产物同步校验 + 静态依赖图验证)
├── tools/ui-runner.mjs     基于 AsyncLocalStorage + ScopedBrowser 的并发 Playwright UI 测试运行器
├── manage.mjs / manage.py  桌面端与 CLI 生命周期管理入口 (Node 优先 + Python 兼容回退)
├── sidecars/panel/         Sidecar 后端模块 (*.mjs) 与侧边栏自包含浏览器 bundle (app.js, styles.css)
├── compat/                 桌面端 CDP/IPC 注入桥接与自包含工厂产物 (*.mjs, *.cjs)
├── ide/                    独立 IDE VSIX 运行时与打包脚本 (extension.cjs, main.mjs, package.mjs, manage.mjs)
└── cli/                    官方 CLI statusLine 独立运行产物 (statusline.mjs, metrics.mjs, render.mjs)
```

## 构建与测试

仅开发编译期使用 `typescript` 与 `esbuild`（`devDependencies`）；运行与安装包无任何第三方依赖：

```powershell
# 1. 类型检查与零依赖构建（--check 校验 51 个编译产物与 manifest 依赖图是否完全同步；仅构建 JS 可用 --skip-native）
npm run typecheck
npm run build
node tools/build.mjs --check

# 2. Node 单元测试（Sidecar 遥测、多账号账本、子代理、时间线、CLI、共享工具与生命周期）
npm test
node --test ide/tests/*.test.mjs

# 3. Python 生命周期与更新器事务测试
npm run test:lifecycle

# 4. Playwright 浏览器 UI 回归测试（需本机或 CI 安装 playwright）
npm run test:ui
npm run test:usage-ui
npm run test:panel-ui
node tools/check-ide-ui.mjs

# 5. 长对话与日志流式内存预算基准测试
node --expose-gc tools/check-trajectory-resources.mjs
node --expose-gc tools/check-transcript-resources.mjs

# 6. 生成 dist/ 发行包（App/CLI ZIP + IDE VSIX + SHA256）并校验发布完整性
npm run package
node tools/publish-release.mjs --tag v0.12.8 --check-only
```

## 本地实时预览

```powershell
node sidecars/panel/main.mjs
```

打开 `http://127.0.0.1:17891` 查看独立侧边栏面板。`/toolbar-preview?new` 验证新对话同行布局，`/toolbar-preview` 关联最近活动会话（需桌面 App 已启动）。

## 单一真源清单与数据安全边界

- **清单唯一真源（`src/platform/manifest.ts`）：** 统一维护桌面运行文件、私有排除目录（`data`、`history-v1`、`usage-v1`、`timeline-v1`、`sdk`）、IDE VSIX 模块白名单（`IDE_VSIX_MODULES`）、CLI 状态栏文件及开源脱敏排除规则。`tools/build.mjs` 在每次构建时通过 `verifyManifestDependencyGraph()` 静态扫描 `import`/`require` 传递闭包，杜绝 VSIX 或发行包遗漏模块。
- **凭据与正文隔离：** 安装包与仓库不携带任何账号凭据或个人标识（本地可选账号映射存放在 `.gitignore` 忽略的 `.data/usage-accounts.local.json` 中）。sidecar 仅在内存中持有当前 standalone 进程凭据并校验 PID 端口归属；前端只接收脱敏后的数值统计、状态、模型名称与纯结构化时间线节点，绝不落盘或传输提示词、回复正文、思考文本或工具参数。
- **默认零归档入侵：** 默认安装、升级与卸载绝不修改宿主 `resources/app.asar`（旧版主动注入参数已退役，仅保留经 SHA-256 严格校验的历史备份还原能力）。完整故障与恢复矩阵见 [ROBUSTNESS.md](ROBUSTNESS.md)。
