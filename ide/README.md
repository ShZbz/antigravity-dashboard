# Antigrative Dashboard for Antigravity IDE

The standalone **Antigravity IDE** has a separate VSIX adapter starting with
**v0.7.0**. This targets Google's own IDE, not the Antigravity extensions in
VS Code, Visual Studio, JetBrains, Zed or Xcode. Those editor adapters are not
implemented. The desktop App and CLI retain their separate installers.

## What it shows

- Narrow Agent composer: three interactive speed, cache and context icons.
- Wide composer: numeric summaries appear when space permits.
- Too little space for even three icons: release the space to native controls.
- Hover or click for throughput, token/cache breakdown (including multi-model
  SVG donut rings and root/subagent task totals), context occupancy, and account
  quotas. English / 简体中文 choices stay at the bottom of context details.
- Live statistics come from the IDE's main language server. Autocomplete, desktop
  and other-profile servers are excluded. Tool follow-up requests sharing an
  execution ID remain separate samples, so cache reads are counted correctly.
- New conversations show `—` until a sample exists; account quota is independent.
  Missing private conversation state shows unavailable rather than another chat.
- Unchanged polling does not rebuild labels or reset a scrolled card.
- Open the cache icon and **View token usage** for daily/weekly activity heatmaps,
  day/week/month/custom-range stacked bars, single-bar drilldown, **By Model / By User / Project Stats**
  (with per-conversation drilldown, worktree grouping, expandable subagent rows, and synced SVG donut),
  **Simple / Detailed** variant grouping, interactive 24-hour spline trend charts,
  multi-account switching (`All Accounts (Aggregated)` across all dimensions), independent `Aa` font-scale
  settings (`80%`–`150%`), and manual remote-project usage logging. Chart colors follow the current IDE theme.
- Usage is backfilled from available IDE conversations with incremental `fileIndex`
  and optional native binary caches (`ledger-compact-v1.bin`, `project-ledger-v1.bin`,
  `project-meta-v1.json`) plus batched checkpoints, deduplicated per account, and stored
  locally in `usage-v1`. Desktop and IDE maintain separate ledgers; this is observed local
  consumption, not account billing. Prompts, replies and credentials are never
  retained in this ledger.

## Install a downloaded VSIX

Download `antigrative-dashboard-ide-0.12.6.vsix` and its `.vsix.sha256` from the
[releases](https://github.com/ShZbz/antigravity-dashboard/releases).
In Antigravity IDE, open Extensions, choose **Install from VSIX…** from the
Extensions menu and select the file. No desktop App installation is required.

The composer integration requires a **loopback renderer debugging endpoint**.
Fully quit the IDE normally when no task is running, then launch its executable
with these arguments:

```text
--remote-debugging-port=0 --remote-debugging-address=127.0.0.1
```

For example, Windows PowerShell (replace the path with your actual installation):

```powershell
& 'D:\Antigravity IDE\Antigravity IDE.exe' --remote-debugging-port=0 --remote-debugging-address=127.0.0.1
```

You can append the two arguments to an IDE shortcut's **Target** after the closing
quote around its executable. Keep using that shortcut after a full quit. Starting
an already-running IDE with new flags does not reconfigure its existing process.
The debugger binds to localhost only; do not expose it to the network.

## Install / launch / uninstall from the source ZIP

Download and extract `antigrative-dashboard-0.12.6.zip`, and download the VSIX to a
known location. You can run the helper with Node.js 20+ (`node ide/manage.mjs`) or
Python 3.10+ (`python ide/manage.py`); it uses the IDE's bundled runtime and needs
no third-party packages:

```powershell
node ide/manage.mjs install --exe 'D:\Antigravity IDE\Antigravity IDE.exe' --vsix 'C:\Downloads\antigrative-dashboard-ide-0.12.6.vsix'
node ide/manage.mjs launch --exe 'D:\Antigravity IDE\Antigravity IDE.exe'
node ide/manage.mjs uninstall --exe 'D:\Antigravity IDE\Antigravity IDE.exe'
```

On Linux/macOS, `python3 ide/manage.py ...` also works. macOS `--exe` points to the
executable inside `Antigravity IDE.app/Contents/MacOS/Antigravity IDE`, not to the
`.app` directory. Linux `--exe` points to the actual Electron executable, not a shell
wrapper. `launch --workspace /path/to/project` optionally opens a workspace.
Developers can build the VSIX with `node ide/package.mjs` (or `python ide/package.py`).

The extension owns the collector lifecycle. Multiple windows elect one collector
per default IDE profile; each renderer supplies its own current conversation ID.
Reloading reconnects automatically. The adapter checks PID lineage and socket
ownership before attaching to a workbench. Credentials stay in collector memory.
No proprietary app files or CSP policies are modified.

## Diagnostics and saved data

Run **Antigrative Dashboard: Show IDE Status** in the command palette.
Only recent health records are treated as current. Disable
`antigrativeDashboard.ide.enabled` or uninstall the VSIX to stop the integration.
Updates keep the extension identity, language preference and saved statistics.

Data lives under the IDE's `User/globalStorage/shzbz.antigrative-dashboard-ide/`:

| System | Default base directory |
| --- | --- |
| Windows | `%APPDATA%\Antigravity IDE` |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/Antigravity IDE` |
| macOS | `~/Library/Application Support/Antigravity IDE` |

> **Migrating from upstream `you-should-know-me.antigrative-dashboard-ide`:** Starting with the `shzbz` publisher VSIX, the extension ID and default storage directory changed from `you-should-know-me.antigrative-dashboard-ide` to `shzbz.antigrative-dashboard-ide`. To keep existing statistics and preferences, fully quit the IDE, copy `history-v1/`, `usage-v1/`, and `preferences.json` from `User/globalStorage/you-should-know-me.antigrative-dashboard-ide/` into `User/globalStorage/shzbz.antigrative-dashboard-ide/`, and uninstall the old `you-should-know-me.antigrative-dashboard-ide` extension before relaunching.

Only whitelisted numeric statistics and settings are persisted, not messages,
titles or credentials. Stop the extension before deleting `history-v1` (per-conversation
latest snapshot) or `usage-v1` (historical daily/weekly/monthly ledger). Available
local conversations will be backfilled again after activation. See
[usage accounting and limitations](../docs/USAGE.md).

## Verification scope

Windows 11 / **Antigravity IDE 2.5.5** (VS Code base 1.107.0) has been exercised
with real conversations, cache reads, restart/history restoration and narrow/wide
layouts. Three-platform CI runs discovery fixtures, VSIX manifest/entrypoint smoke
tests, and the production widget in Chromium with enforced Trusted Types. Linux/macOS
signed-in IDE GUI acceptance remains outstanding.

## 中文快速说明

从发布页下载 `antigrative-dashboard-ide-0.12.6.vsix`，在反重力独立 IDE 扩展页选择「从 VSIX 安装」，无需先装桌面 App。完全退出 IDE 后，用带 `--remote-debugging-port=0 --remote-debugging-address=127.0.0.1` 参数的快捷方式启动。

窄栏显示三个图标，拉宽后显示数值；支持多模型占比环、24 小时趋势图、按模型/按用户/项目统计（含项目会话下钻与按账号隔离）、简易/详细变体归并、多账号切换、独立 `Aa` 字体缩放及远程项目手动录入。数据保存在 `User/globalStorage/shzbz.antigrative-dashboard-ide/`。若从原上游 `you-should-know-me.antigrative-dashboard-ide` 迁移，请先完整退出 IDE，将旧目录下的 `history-v1/`、`usage-v1/` 与 `preferences.json` 复制到新目录并卸载旧版扩展。
