# Changelog

## 0.12.8 — 2026-11-27

- Compact Rust native ledger cache, native multi-scope shared project deduplication, and two-tier idle cache release (`native/pulse-accel/src/{ledger_index,project_ledger,napi_entry}.rs`, `src/platform/native-bridge.ts`, `src/telemetry/ledger/project-stats.ts`):
  - Intern model and scope strings via `model_pool`/`scope_pool` (`u16` indices), store SHA-256 record IDs inline via `RecordId::Sha256([u8; 32]) | Raw(Box<str>)`, pack timestamps/counters into `-1`-sentinel `i64`s + `flags: u8`, and call `shrink_to_fit()` after load/update, cutting Rust ledger native memory by ~39%.
  - Add `readLedgerSharedProjectSummaries` (`read_ledger_shared_project_summaries_json`) with stamp-validated `PROJECT_MEM_CACHE` and 100% parity against `loadSharedFileSummariesJs` (retaining `PULSE_DISABLE_NATIVE_ACCEL=1` fallback at concurrency 4), eliminating the +25–28 MiB V8 heap spike on Project Stats queries.
  - Add `releaseNativeCaches('soft' | 'full')` (`release_native_caches_json`): `'soft'` retains the ~50 KiB `last_snapshot` and lightweight `file_stamps` for fast unchanged hits while dropping raw record vectors; `'full'` clears both ledger and project caches.
- Lazy-load the MCP Server, decouple `MetricsStore`, and reclaim idle memory (`src/mcp/{tools,server}.ts`, `sidecars/panel/tests/mcp-app.test.mjs`):
  - Defer heavy telemetry/ledger/store/theme/preferences imports behind cached dynamic `import()` on first `tools/call` (cutting MCP startup RSS delta by ~68% with zero heavy loads on `initialize`/`tools/list`/`resources/list`), avoid instantiating `MetricsStore` on `open_usage_dashboard`/`query_usage_stats`/`get_project_*`, and add a 90s `.unref()` idle cache teardown (`inFlightCalls`-guarded, process stays resident) calling `releaseNativeCaches('full')`.
- Eliminate Sidecar leaks, bound long-running caches, and trim 2.2s CDP polling payloads (`src/contracts/{ipc,metrics}.ts`, `src/telemetry/{main,preview-server}.ts`, `src/telemetry/ledger/{storage,backfill}.ts`, `src/telemetry/store/{metrics-store,session-runner,history}.ts`, `src/telemetry/timeline/store.ts`, `src/telemetry/reader/{trajectory-reader,transcript}.ts`, `src/telemetry/delegation/delegated-usage.ts`, `src/ui/runtime-ui/{runtime-ui,session-lifecycle,renderer-bridge,binding-dispatch,event-handler}.ts`):
  - Skip write-only JS `LedgerStorage.fileIndex` writes when Rust native acceleration is active; cap `MetricsStore.sessions` at 16 LRU entries (protecting `pending` and active sessions) and prune stale `baseMetrics`; replace full JSON strings in `SessionHistory`/`TimelineStore` `writeCache` with SHA-256 digests (16/8 caps); add `trimIdle(180_000, keepIds)` across `TrajectoryReader` (preserving the 8 MiB active session budget while capping inactive multi-session retention to 2 MiB), `DelegatedUsage`, and `TranscriptReader`; clear `compatCache` after startup assembly, compute `guardedSource` on demand, throttle `integration-state.json` disk writes to state changes or 60s intervals, skip redundant `/json/list` probes when CDP sessions are live, and run 60s `.unref()` housekeeping across Pro and `.antigravity-vertex` with 120s-idle `releaseNativeCaches('soft')`.
  - Add `includeUsage?: boolean` and lightweight `usageTotals` (`DesktopUsage.totalsSnapshot()` preserving 60s background `sync()`) so closed-modal 2.2s inline polls omit unused `conversations[]` and full `usage`, and remove double `JSON.stringify` in the CDP bridge (cutting 200-poll RSS churn by ~98%).
- Improve host renderer scrolling hygiene and lazy-split sidebar fallback modal (`src/ui/inline-widget/{polling-state,index,mount-dom,speed-card}.ts`, `src/ui/usage-modal/focus-trap.ts`, `src/ui/panel-webview/index.ts`, `tools/check-panel-ui.mjs`):
  - Attach `focus-trap.ts` document capture listeners (including non-passive `wheel`/`touchmove`) only inside `present()` and detach them on `conceal()`/`dispose()`; guard capture `scroll` and connected `MutationObserver` fast-paths in `mount-dom.ts`; fetch full `usage` on demand when opening `#open-usage` / `__agPulseOpenUsage()`; and lazy-load `/usage-ui.js` for the non-CDP sidebar fallback modal, shrinking `sidecars/panel/app.js` from 432.4 KiB to 230.3 KiB (-46.7%).
- Expand automated coverage (`sidecars/panel/tests/{memory-hygiene,ui-memory-hygiene,project-stats,mcp-app}.test.mjs` and Rust unit tests) and bump version to `0.12.8` across `plugin.json`, `package.json`, `package-lock.json`, `ide/package.json`, `sidecars/panel/package.json`, `src/mcp/server.ts`, and `src/ui/mcp-usage-app/index.ts`.

## 0.12.7 — 2026-11-25

- Add Antigravity `v2.34.0+` **MCP Apps** integration — full-page **Token Usage** dashboard (`global` entrypoint) and read-only Agent query tools (`src/mcp/{protocol,tools,server}.ts`, `mcp_config.json`, `src/ui/mcp-usage-app/{index,bridge,theme-bridge}.ts`, `src/ui/usage-modal/{types,dom-shell,usage.css,focus-trap,index}.ts`, `tools/build.mjs`, `src/platform/manifest.ts`, `plugin.json`):
  - Ship an on-demand, zero-runtime-dependency stdio MCP server (`mcp/server.mjs`, auto-using Antigravity's bundled Node.js runtime via `"command": "node"`) that shares the existing `UsageLedger`, Rust `pulse-accel.node`, and `PreferencesStore` data directory without starting duplicate background polling, `RuntimeUi`, or auto-backfill timers.
  - Register `open_usage_dashboard` (`ui://antigravity-pulse/usage.html`, `text/html;profile=mcp-app`, `com.google.antigravity/ui` `global` entrypoint titled **Token Usage**) so users on Antigravity `v2.34.0+` can open the full-width, full-page Token Usage dashboard directly from **Plugins** in the left sidebar even when CDP debug launch is off, with automatic `768 KiB` deferred-snapshot fallback for large ledgers.
  - Expose read-only `query_usage_stats` (day/week/month/custom × model/user/project with Markdown + structured totals and `cacheRead / (uncached + cacheRead + cacheWrite)` hit rate) and `get_quota_and_session` (5h/weekly quotas + active session TPS/cache/context via host env credentials with SQLite fallback), alongside a single multiplexed `visibility: ["app"]` `pulse_usage_action` tool (13 UI actions) to prevent tool-list bloat in Antigravity CLI (`agy`).
  - Add `displayMode: 'fullpage'` to `createUsageDashboard` and bundle a self-contained single-file `mcp/apps/usage.html` (`~847 KiB`, zero external scripts/links, `@modelcontextprotocol/ext-apps` bundled at build time, FIFO 3-call concurrency cap, live SEP-1865 host theme syncing, and `PreferencesStore`-backed persistence); normalize `plugin.json` (`displayName` + 3 `suggestedPrompts`) to pass `agy plugin validate --strict`.
- Harden Windows desktop plugin updates when live sidecars lock `pulse-accel.node` (`src/lifecycle/fs-helpers.ts`, `sidecars/panel/tests/{mcp-app,stage7-lifecycle,stage8c-cli-and-matrix}.test.mjs`): detect `EBUSY`/`EPERM` on locked `.node` files during `manage.mjs install`, rename-swap the locked binary out of the plugin directory to `os.tmpdir()` (with `EXDEV` fallback) before writing the updated addon, add end-to-end stdio MCP App and locked-binary tests, and bump version to `0.12.7` across `plugin.json`, `package.json`, `package-lock.json`, `ide/package.json`, and `sidecars/panel/package.json`.

## 0.12.6 — 2026-11-21

- Fix severe hover tooltip displacement across the Token Usage modal (`src/ui/usage-modal/{dom-shell,tooltip,heatmap,focus-trap}.ts`, `src/ui/usage-modal/usage.css`, `tools/check-usage-ui.mjs`): promote `#tip` to the browser top layer via `popover="manual"` (`inset: auto; margin: 0;` with guarded `showPopover()` / `hidePopover()` across `tooltip.ts`, `heatmap.ts`, and `focus-trap.ts`) so `#usage-dashboard`'s open `scale: 1` transform never establishes a `position: fixed` containing block that shifts tooltips by `(+dialog.left, +dialog.top)` or clips them under `overflow: hidden`; extract shared `revealTip()` for both `show()` and `showNodes()` (covering stacked bars, overview heatmap, 24h hourly spline, and project conversation breakdown), anchor `.bar-column` tooltips to `.stack` so tooltips sit directly above each bar rather than floating above the 500M plot ceiling, and fall back below the target when above-target placement would exceed the dialog top.
- Show every calendar day label on the usage modal daily bar chart (`src/ui/usage-modal/stacked-bar.ts`, `tools/check-usage-ui.mjs`): render all `1..30/31` day-of-month ticks derived from `bucket.from` whenever `buckets.length <= 31` while keeping sparse ticks for longer custom ranges, and add Playwright geometric tooltip alignment and day-label completeness assertions.
- Prune stale runtime files on desktop reinstall & clean up build/test hygiene (`src/lifecycle/{fs-helpers,installer}.ts`, `src/platform/manifest.ts`, `src/types/css.d.ts`, `manage.{mjs,py}`, `tools/check-panel-ui.mjs`, `sidecars/panel/tests/stage7-lifecycle.test.mjs`, `tests/test_lifecycle.py`, `docs/assets/capture-manifest.json`): recursively prune outdated non-runtime files during `install` while preserving private user directories (`data`, `history-v1`, `usage-v1`, `timeline-v1`, `sdk`), consolidate shared CSS module typings into `src/types/css.d.ts`, wait for `card-stage` collapse animations to settle before asserting `data-pin-bottom`, and bump version to `0.12.6` across `plugin.json`, `package.json`, `package-lock.json`, `ide/package.json`, and `sidecars/panel/package.json`.

## 0.12.5 — 2026-11-21

- Recover Antigravity `2.34+` live cloud quotas & automatic account email detection via host-injected environment credentials (`src/telemetry/client/{server-discovery,rpc-client,snapshot-stream,index}.ts`, `src/telemetry/store/metrics-store.ts`, `src/telemetry/main.ts`): when `--csrf_token` is omitted from `language_server` CLI args, fall back to `ANTIGRAVITY_LS_ADDRESS` and `ANTIGRAVITY_CSRF_TOKEN` with strict loopback-only host validation (`127.0.0.1`, `localhost`, `[::1]`), live standalone PID/port ownership checks, Pro-vs-`.antigravity-vertex` dual-instance credential isolation (`env: {}` in `createVertexInstance`), and automatic SHA-256-tracked 401/403 fallback to local SQLite direct-read mode.
- Add zero-credential local SQLite direct-read fallback & local recording account management (`src/telemetry/reader/{local-summaries,trajectory-reader}.ts`, `src/telemetry/store/metrics-store.ts`, `src/telemetry/ledger/{accounts,backfill,summary}.ts`, `src/telemetry/context.ts`, `src/ui/panel-webview/{index,settings-popover,panel.css}.ts`, `src/ui/usage-modal/project-detail.ts`, `src/ui/runtime-ui/*`): recover live TPS, token/cache metrics, context window, and `conversation_summaries.db` session discovery directly from local SQLite when RPC credentials are unavailable; add sidebar recording-account switching with `sha256(email)` alignment and atomic conversation ownership reassignment; and map `MODEL_PLACEHOLDER_M532` to `Gemini 4 Neon (High)`.
- Fix native `/swarm` subagent role naming in the sidebar and timeline (`src/telemetry/delegation/{hints,delegated-collector,delegation,task-validation}.ts`, `src/telemetry/reader/local-summaries.ts`): forward `agent_name`, `subagentSpec`, and `nestingDepth` from local summaries without injecting placeholder `'未命名会话'` into `rawSummaries`, merge `trajectoryMetadata` across summary and trajectory payloads so partial summary metadata never shadows `subagentSpec.role`, and filter placeholder labels so stale `history-v1` caches self-heal automatically.
- Optimize sidebar motion, responsiveness, 5h depleted ring, and live quota refresh (`src/ui/panel-webview/{dom-motion,index,model-mix,panel.css,polling,quota-section,settings-popover,subagent-tree,swimlane-timeline,timeline-helpers}.ts`, `src/telemetry/store/{metrics-store,session-runner}.ts`, `src/ui/theme/*`): render a dashed red indicator when the 5h quota bucket is depleted, tighten dirty/settled quota refresh scheduling, and improve sidebar animations and responsive layout; expand automated coverage in `sidecars/panel/tests/local-sqlite-fallback.test.mjs` and bump version to `0.12.5` across `plugin.json`, `package.json`, `package-lock.json`, `ide/package.json`, and `sidecars/panel/package.json`.

## 0.12.4 — 2026-11-18

- Support Antigravity `2.33.0` standalone dashboard usage without mandatory debug launch (`src/lifecycle/{debug-launch,installer,manage-cli}.ts`, `src/contracts/preferences.ts`, `src/platform/preferences-store.ts`, `src/telemetry/{main,preview-server}.ts`): add opt-in cross-platform shortcut/launcher debug-flag management (`debugLaunchEnabled`, default `false`) via `manage.mjs debug-launch <status|on|off>`, `install --enable-debug-launch`, and `/api/debug-launch` (`--remote-debugging-port=0 --remote-debugging-address=127.0.0.1`), automatically cleaning up patched shortcuts/launchers when disabled or uninstalled; and expose `/api/usage/open`, `/api/usage/accounts`, `/api/usage/switch-account`, `/api/usage/manual/{add,delete}`, and `/api/usage/project-{overview,detail}` so the Token Usage dashboard works directly inside the sidebar even when the inline bottom bar is offline.
- Redesign sidebar settings popover and add sidebar Usage stats entry (`sidecars/panel/index.html`, `src/ui/panel-webview/{index,polling,settings-popover,panel.css,types}.ts`, `src/ui/shared/font-popover.ts`, `src/ui/usage-modal/*`, `src/ui/i18n/dictionary-{en,zh}.ts`): replace the standalone header `Aa` / language buttons with an anchored gear popover (`#settings-button` / `#settings-popover`) combining the opt-in bottom-bar debug toggle (`#debug-launch-toggle` + live status readout), `简体中文` / `English` language selector, and 3-row `createFontScaleControls` (`Usage modal`, `Sidebar`, `Bottom card`); add `#open-usage-button` (`Usage stats` / `用量统计`) on the `.sampled-model` row that invokes `RuntimeUi.openUsageModal()` over `/api/usage/open` when connected or falls back to an embedded `createUsageDashboard` (`#panel-usage-host`) with narrow-viewport `@media (max-width: 520px)` styling.
- Fix Antigravity `2.33.0` sidebar wheel scrolling and bottom-bar "Open sidebar" dispatch (`src/ui/panel-webview/panel.css`, `src/ui/host-adapter/{redux-sidebar,react-fiber}.ts`): lock non-standalone `html:has(> body:not(.standalone))` and `body:not(.standalone)` to `height: 100%; overflow: hidden` while bounding `body:not(.standalone) > .widget` to `calc(100% - 20px)` (`min-height: 0; flex: 1 1 0%`) so overflowing sidebar content scrolls smoothly via mouse wheel without breaking `.standalone` previews or `data-pin-bottom`; probe `auxPaneComponent?.redesignEnabled` in `probeReduxDependencies()`, send both `panelScope` and `treeId` across `sidePanelV2/setContent`, `sidePanel/setContent`, and `sidePanel/setSidePanelOpen`, and parse `?cascadeId=` in `readDesktopConversationId()`.
- Expand tests (`sidecars/panel/tests/{debug-launch,host-adapter,preferences}.test.mjs`, `tools/check-{panel,language-persistence}-ui.mjs` / `tools/check-language-persistence.mjs`) covering shortcut flag tokenization/cleanup, gear popover & usage modal fallback, `opaque-iframe-wheel` overflow scrolling, and Antigravity `2.33.0` `panelScope`/`?cascadeId=` dispatch; bump version to `0.12.4` across `plugin.json`, `package.json`, `package-lock.json`, `ide/package.json`, and `sidecars/panel/package.json`.

## 0.12.3 — 2026-11-18

- Refactor the sidebar panel layout, header quota display, and responsive behavior (`sidecars/panel/index.html`, `src/ui/panel-webview/{index,dom-motion,quota-section,subagent-tree,swimlane-timeline,types,panel.css}`, `src/ui/i18n/dictionary-{en,zh}.ts`, `src/telemetry/main.ts`): replace the header `<select id="quota-group">` and duplicate `#context-card` quota rows with concentric SVG header quota rings (`#quota-rings-pill`) and an interactive hover/focus/click `#quota-popover` (`popover="manual"` with CSS Anchor Positioning fallback, `Weekly only` / `仅周额度` badges, live 1s countdowns, and `<5%`/`<20%` threshold colors); serve `/logo.svg` with an inline SVG fallback in `.brand`; split `.status-strip` into two-column Speed/Cache chips plus an inline-progress Context chip (`#strip-context-size` and `#strip-context-track`/`#strip-context-fill` with 80%/90% warning/danger thresholds); enable click-to-collapse on active `#card-stage` tabs (`allowToggle` with WAAPI height morphing and scroll preservation); add `syncPinBottom()` (`data-pin-bottom`) to anchor collapsed lower sections cleanly; and introduce `@container sidebar` breakpoints (`420px` down to `245px`).
- Polish the Token Usage modal UI & account switcher layout (`src/ui/usage-modal/{dom-shell,account-switcher,localize-modal,stacked-bar,breakdown-table,usage-sections.css,usage.css}`): move `#account-switcher` onto the right end of `.tabs-bar` and omit redundant account scope text from `#subtitle` in multi-account mode (`renderSubtitle`); replace `#detail-title` with a stacked `.detail-heading-group` (`.detail-picker-row` + `.detail-summary-row`); refine the project dimension label to `Project Stats` / `项目统计`; and update responsive wrapping around pickers and chart controls.
- Accelerate project statistics & ledger summarization (`native/pulse-accel/src/{project_ledger,ledger_index,lib,napi_entry}.rs`, `src/platform/native-bridge.ts`, `src/telemetry/ledger/{project-stats,storage,backfill,timezone,summary}.ts`): add Rust N-API `readLedgerProjectSummariesJson` (`readLedgerProjectSummaries`) with streaming `DeserializeSeed` parsing, parallel dirty-file refresh, process-local `PROJECT_MEM_CACHE`, and binary sidecar cache `project-ledger-v1.bin` (`AGPPRJ01`); add `LEDGER_MEM_CACHE` and `CachedSummarySnapshot` fast path in `ledger_index.rs`; persist non-empty conversation/workspace metadata in `project-meta-v1.json` (`persistProjectMetaFromRawSummaries` via `DesktopUsage.sync()` and `loadSummaryMeta()`) so project mappings survive `conversation_summaries.db` truncation or deletion without clobbering existing fields; track `LedgerStorage.projectDirtyRelPaths` separately from `dirtyRelPaths`; add stat-validated `SummaryMetaCacheEntry` (`.db`, `.db-wal`, `project-meta-v1.json`) and Level-2 candidate file filtering in `queryProjectConversationDetail`; and replace hot-path `Intl.DateTimeFormat().formatToParts()` calls in `timezone.ts` with precomputed UTC/UTC+8/UTC+9 offsets, binary-searched transition tables (`resolveTimeZoneSpec`), and `formatCivilDateFromDays`.
- Fix project statistics failing to isolate and filter by account (`src/telemetry/ledger/project-stats.ts`, `src/ui/usage-modal/{index,stacked-bar}.ts`): forward the active `viewScope` (`'all'` or 64-hex account hash) from `loadProjectDetail` and `ensureProjectUsage` into `getProjectUsage` / `getProjectDetail` and cache keys, dynamically updating `#project-scope-note` on `#account-switcher` changes; and align `buildScopeFilePlan` + `loadSharedFileSummariesJs` with `UsageLedger.summary()` using `ownership-v1.json`, `buildPrimaryPicker` tie-breaking, and record-level `recordScopes` deduplication so per-account and `All Accounts (Aggregated)` project totals match without cross-account leakage.
- Expand automated tests (`sidecars/panel/tests/project-stats.test.mjs`, `tools/check-{panel,theme,usage}-ui.mjs`) covering `dateTimeParts` DST/epoch parity, candidate-file filtering, `projectDirtyRelPaths` + WAL invalidation, native-vs-TS project parity, multi-account project isolation (`acctA` / `acctB` / `'all'`), `project-meta-v1.json` persistence, header quota rings/popover, collapsible stage, and account-switcher project re-querying; bump version to `0.12.3` across `plugin.json`, `package.json`, `package-lock.json`, `ide/package.json`, and `sidecars/panel/package.json`.

## 0.12.2 — 2026-11-17

- Add "By Project" (`按项目统计`) usage dimension and per-conversation drilldown (`native/pulse-accel/src/{lib,napi_entry,sqlite_trajectory}.rs`, `src/platform/native-bridge.ts`, `src/telemetry/ledger/project-stats.ts`, `src/telemetry/main.ts`, `src/ide/main.ts`, `src/ui/runtime-ui/*`, `src/ui/ipc-host/index.ts`, `src/ui/usage-modal/*`): expose `readSqliteConversationSummariesJson` (`readSqliteConversationSummaries`) to resolve workspace URIs, worktrees, parent conversation chains, Antigravity CLI sessions, general conversations, and remote sessions; add `queryProjectUsageOverview` and `queryProjectConversationDetail` behind `getProjectUsage` / `getProjectDetail` across sidecar, preview, IPC, and standalone IDE hosts; replace legacy selects with a shared popover listbox (`createPopoverListbox` in `src/ui/usage-modal/picker.ts`); and render an interactive project conversation breakdown (`src/ui/usage-modal/project-detail.ts`) with horizontal session bars, expandable subagent rows, and a synced SVG donut chart.
- Add independent `Aa` font-scale customization across all three surfaces (`src/contracts/preferences.ts`, `src/platform/preferences-store.ts`, `src/ui/shared/font-popover.ts`, `src/ui/i18n/dictionary-{en,zh}.ts`, `src/ui/{inline-widget,panel-webview,usage-modal}/*`): persist `usageFontScale`, `sidebarFontScale`, and `inlineFontScale` (`0.80`–`1.50` / `80%`–`150%` in 5% steps) in `preferences.json` and `localStorage`, expose an anchored `Aa` popover (`createFontPopover`) with `-`/`+` steppers and direct percentage input, and drive CSS scaling variables (`--pulse-usage-font-scale`, `--pulse-sidebar-font-scale`, `--pulse-inline-font-scale`) cleanly across light/dark themes.
- Expand automated coverage (`sidecars/panel/tests/{project-stats,preferences}.test.mjs`, `tools/check-{panel,usage}-ui.mjs`) and bump version to `0.12.2` across `plugin.json`, `package.json`, `package-lock.json`, `ide/package.json`, and `sidecars/panel/package.json`.

## 0.12.1 — 2026-11-17

- Bundle 5-platform prebuilt Rust native binaries directly into Release ZIP and IDE VSIX packages (`src/platform/manifest.ts`, `src/lifecycle/packager.ts`, `src/shared/zip.ts`, `manage.py`, `ide/package.py`, `tools/publish-release.py`): allowlist `RELEASE_NATIVE_ADDONS` (`sidecars/panel/pulse-accel.<platform>-<arch>.node` for `win32-x64`, `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`) and `RELEASE_NATIVE_CLI_BINS` (`cli/bin/ag-pulse-statusline.*`) during release packaging while continuing to exclude untagged local binaries, debug symbols, and open-source Git exports; register `.node` MIME type in VSIX `[Content_Types].xml`; preserve Unix `0755` executable mode bits for POSIX CLI binaries and shell scripts when packaged on Windows; and add `--require-native` / `AG_PULSE_REQUIRE_NATIVE=1` verification across Node and Python packagers and release asset checks.
- Wire `native.yml` into `release.yml` (`.github/workflows/{native,release}.yml`): expose `workflow_call` on `native.yml`, add the `native` matrix job to `release.yml`, download all 5 `pulse-native-*` build artifacts into `sidecars/panel/` and `cli/bin/` before running `manage.py package --require-native`, `ide/package.py --require-native`, and `tools/publish-release.py`.
- Bump version to `0.12.1` across `plugin.json`, `package.json`, `package-lock.json`, `ide/package.json`, and `sidecars/panel/package.json`.

## 0.12.0 — 2026-11-17

- Introduce Rust N-API native engine & zero-RPC SQLite direct-read bypass (`native/pulse-accel`, `src/platform/native-bridge.ts`): bundle SQLite + Protobuf wire decoders (`proto_wire.rs`, `enums.rs`, `sqlite_trajectory.rs`) and `napi_entry.rs` bindings with automatic JS/RPC fallback (`PULSE_DISABLE_NATIVE_ACCEL`), bypassing `language_server.exe` RPC calls for settled local conversations across `TrajectoryReader`, `local-conversations.ts`, `UsageLedger`/`backfill-sync.ts`, and `delegated-collector.ts`.
- Add native ledger, diff, sanitizer & log accelerators (`native/pulse-accel/src/{ledger_index,snapshot_diff,sanitizer_accel,log_rotator}.rs`, `src/telemetry/snapshot-diff.ts`, `src/shared/logger.ts`, `src/lifecycle/sanitizer.ts`): cache parsed usage records in binary `ledger-compact-v1.bin` with dirty-file incremental refreshes, compute structural snapshot fingerprints off V8, parallelize open-source privacy auditing and text sanitization, and rotate oversized logs cleanly.
- Add native SVG, transcript, Win32 discovery, streaming projection, shared cache, lazy Vertex polling & standalone CLI (`native/pulse-accel/src/{svg_compiler,transcript_scan,win32_discovery,json_projector,shared_cache}.rs`, `native/pulse-accel/src/bin/statusline.rs`, `src/telemetry/{lazy-vertex,host-watchdog}.ts`, `.github/workflows/native.yml`, `tools/build.mjs`): accelerate SVG splines/swimlanes, JSONL transcript tailing, Win32 process/port discovery, and Connect+JSON frame projection; share parsed usage across processes via `shared-usage-cache-v1.db`; ship standalone `ag-pulse-statusline` binary and cross-platform build matrix (`--native-tag`, `--native-only`, `--target`); defer `.antigravity-vertex` polling lazily; and guard `export-opensource.py` checks in exported release trees (`stage7-lifecycle.test.mjs`).
- Fix commercial / Enterprise / Vertex cache hit rate (`—`), history/cache self-healing & native CLI `--snapshot` (`src/telemetry/metrics/primitives.ts`, `src/telemetry/delegation/task-records.ts`, `src/telemetry/store/history.ts`, `native/pulse-accel/src/{sqlite_trajectory,shared_cache}.rs`, `native/pulse-accel/src/bin/statusline.rs`): accept `API_PROVIDER_GOOGLE_VERTEX`, `API_PROVIDER_GOOGLE_EVERGREEN`, `API_PROVIDER_ANTHROPIC_VERTEX`, `API_PROVIDER_OPENAI_VERTEX`, `API_PROVIDER_OPENAI_RESPONSES_VERTEX`, and `API_PROVIDER_INTERNAL` via anchored `isSupportedCacheProvider()` validation, self-heal complete Schema-2 `history-v1` snapshots, bump `shared-usage-cache-v1.db` `PRAGMA user_version` to `2` to invalidate pre-fix `partial: true` rows, and tag SQLite-derived `--snapshot` payloads with `"snapshot_source": "sqlite-cache"` so `compute_cache_rate()` computes cache percentages directly.
- Harden CI, open-source export, macOS ancestor-symlink handling & Playwright resource hygiene (`.github/workflows/{ci,release,native}.yml`, `tools/{build,ui-runner}.mjs`, `src/lifecycle/{fs-helpers,installer,cli-installer}.ts`, `{manage,cli/lifecycle}.py`, `sidecars/panel/tests/*`): install `npm ci` before `tools/build.mjs --check` in CI/release workflows, remove `paths` filter on `native.yml` tag triggers, ignore `OPENSOURCE_EXCLUDED_REL_FILES` when absent in exported release trees and exclude `.pytest_cache` everywhere, distinguish direct target symlinks/junctions from ancestor symlinks such as macOS `/var -> /private/var`, deduplicate concurrent `runUiSuite` shared Chromium launches with closed-context pruning, and cleanly skip/guard native-only test assertions when `pulse-accel.node` is absent.
- Bump version to `0.12.0` across `plugin.json`, `package.json`, `package-lock.json`, `ide/package.json`, and `sidecars/panel/package.json`.

## 0.11.0 — 2026-11-16

- Establish single-source-of-truth file manifest & build-time dependency verification (`src/platform/manifest.ts`, `tools/build.mjs`, `compat/update-worker.py`, `tools/publish-release.py`): unify plugin identity, runtime file inventories, private directory exclusions (`PRIVATE_RUNTIME_DIRS` including `timeline-v1`), IDE VSIX module allowlists, CLI statusLine files, release archive requirements (`uninstall.ps1`, `manage.mjs`), and open-source exclusion rules, verified statically at build time via `verifyManifestDependencyGraph()`.
- Migrate lifecycle installer, CLI statusLine, PKZIP/VSIX packager, release publisher & open-source sanitizer to TypeScript (`src/shared/zip.ts`, `src/lifecycle/*`, `install.{ps1,sh}`, `uninstall.{ps1,sh}`): compile 51 zero-dependency targets including `manage.mjs`, `cli/{metrics,render,statusline}.mjs`, `ide/{package,manage}.mjs`, and `tools/{export-opensource,publish-release}.mjs`; retire active `patch-loader.py --apply` ASAR mutation while retaining verified backup restoration; preserve caller `ELECTRON_RUN_AS_NODE` environment in `install.ps1` / `uninstall.ps1`; support semver pre-release version precedence in `AppUpdater` / `update-worker.py`; enforce two-phase private draft staging and public-release overwrite protection in `publishRelease()`; and add fallback privacy pattern parsing and full Node/IDE/Python test verification to `sanitizer.ts`.
- Parallelize Playwright UI regression suite (`tools/ui-runner.mjs`, `tools/check-*.mjs`, `.github/workflows/{ci,release}.yml`): introduce `AsyncLocalStorage`-backed `ScopedBrowser` context isolation to run Wave 1 UI checks concurrently on a shared browser instance while keeping Wave 2 timing-sensitive checks sequential, and add `node tools/build.mjs --check` to CI and release workflows.
- Modularize the usage dashboard modal, sidebar webview, inline toolbar, update banner, host adapters & IDE extension (`src/ui/*`, `src/ide/*`, `src/platform/devtools.ts`): split `compat/usage-ui.cjs`, `sidecars/panel/app.js`, and `compat/inline-widget.cjs` into `<300`-line TypeScript/CSS modules (`usage-modal/`, `panel-webview/`, `inline-widget/`, `update-banner/`, `host-adapter/`, `shared/model-donut.ts`); isolate React Fiber, Redux sidebar dispatch, and IDE Preact traversal; share `DevToolsActivePort` loopback discovery; and replace runtime `module.exports` string-slicing script assembly with scoped CommonJS factory wrappers (`evaluateCjsFactoryExpression`, `bindWindowFactory`, `invokeCjsFactory`, `makeEsmExportFromCjs`).
- Modularize backend telemetry & shared contracts (`src/contracts/*`, `src/shared/*`, `src/platform/*`, `src/telemetry/*`): establish zero-dependency ES2023 TypeScript + `esbuild` compilation; unify IPC/metrics/usage/timeline/preferences contracts, formatting, WCAG color synthesis, Trusted-Types DOM helpers, atomic file writes, advisory PID locks, dual-instance (`Pro` + `.antigravity-vertex`) path discovery, and `extractRequestIdentity()`; split backend telemetry into 67 `<300`-line TypeScript modules.
- Optimize backend data pipeline & hot-path I/O (`src/telemetry/ledger/*`, `src/telemetry/reader/*`, `src/telemetry/client/*`, `src/telemetry/store/*`): add an in-memory `fileIndex` and split read/write queue scheduling in `UsageLedger` alongside 3s batched `saveBackfillState()` checkpoints; advance multi-slice `TranscriptReader` passes continuously via `setImmediate` with round-robin fairness; stream-decode `StreamAgentStateUpdates` Connect+JSON frames in 64 KiB chunks through `TrajectoryJson`; and replace hot-path `JSON.stringify` deep comparisons in `MetricsStore.session()` with structural equality helpers.
- Bump version to `0.11.0` across `plugin.json`, `package.json`, `package-lock.json`, `ide/package.json`, and `sidecars/panel/package.json`.

## 0.10.2 — 2026-11-16

- Externalize local account metadata (`sidecars/panel/usage.mjs`, `sidecars/panel/tests/multi-account-features.test.mjs`, `tools/export-opensource.py`): replace hardcoded `KNOWN_ACCOUNTS` and personal email/hash fallbacks with `loadKnownAccounts()` reading gitignored `.data/usage-accounts.local.json`, allow `UsageLedger` constructor injection via `knownAccounts`, simplify `export-opensource.py` sanitizers, and add `--check` source privacy audit mode.
- Fix IDE VSIX missing transitive modules & `MetricsStore` strong-reference retention (`ide/package.py`, `tests/test_ide.py`, `sidecars/panel/store.mjs`, `sidecars/panel/tests/usage.test.mjs`): add `delegated-usage.mjs`, `delegation.mjs`, `timeline.mjs`, `timeline-store.mjs`, and `task-usage.mjs` to VSIX `MODULES` with unpacked Node entrypoint smoke tests; replace `entry.rawRef` and strong `ancestorRaws` references in `MetricsStore` with `WeakRef` (`entry.rawWeak`) and dead-reference pruning so evicted trajectories are not pinned in V8 heap.
- Align dual-instance lifecycle & Electron IPC preferences (`manage.py`, `compat/ipc-host.cjs`, `tests/test_lifecycle.py`): parameterize `manage.py` (`enable`, `disable`, `status`, `uninstall`, and `install`) with `--instance (all|pro|vertex)` to manage Pro and `.antigravity-vertex` symmetrically and sync `.data/usage-accounts.local.json`; align `ag-pulse:preferences` IPC whitelist to `language`, `languageGuideDismissed`, `usageGuideDismissed`, and `modelTimelineEnabled`.
- Bump version to `0.10.2` across `plugin.json`, `package.json`, `ide/package.json`, and `sidecars/panel/package.json`.

## 0.10.1 — 2026-11-15

- Fix live sidecar and Teamwork subagent capture (`sidecars/panel/{main.mjs,trajectory-json.mjs,delegation.mjs,delegated-usage.mjs,store.mjs}`): switch `MetricsStore` `owns` predicates to synchronous `ownership.running` instead of async `ownership.isOwner()`, extract `invokeSubagentSpec` (`conversationId`, `role`, `typeName`), transitively resolve multi-level delegated descendants, preserve `role`/`parentId`/`depth` hints after subagents leave active summaries, inherit root `taskUsage` on subagent composers without overwriting own stats, and prefer root trajectories in default panel polling.
- Usage statistics simple/detailed model grouping (`compat/usage-ui.cjs`, `tools/check-usage-ui.mjs`): add `#model-view-controls` ("简易 / 详细", default simple, visible in "按模型统计"), normalize and group variant suffixes/casing via `baseModelName()` across legend, stacked bars, tooltip, and breakdown table while preserving `Orchestrator (Argon)`, and support clicking/keyboard-toggling grouped rows (`tr.model-group-row`) to expand inline per-suffix breakdown rows (`tr.model-variant-row`).
- Bump version to `0.10.1` across `plugin.json`, `package.json`, `ide/package.json`, and `sidecars/panel/package.json`.

## 0.10.0 — 2026-11-14

- Orchestrator (Argon) hybrid model identity: map `MODEL_PLACEHOLDER_M668` to `Orchestrator (Argon)` and `MODEL_PLACEHOLDER_M669` to `Gemini Flash` (alongside Argon, Hydrogen, Carbon, and Claude 5.5 placeholder aliases) in `sidecars/panel/context.mjs`; expose `speed.planModel` and `speed.activeModel` while preserving `speed.model` and `speed.context.model`. Render `Orchestrator (Argon) → Gemini Flash` in sidebar `#strip-model` and reveal `#context-orchestrator-row` with planner/worker quota-split notes when planner and active models differ or multiple models are present.
- Multi-model usage rings (`compat/inline-widget.cjs`, `sidecars/panel/{app.js,index.html,styles.css,metrics.mjs,task-usage.mjs,delegated-usage.mjs,history.mjs}`): always-on lightweight aggregation of `speed.modelUsage` and `speed.taskUsage.modelUsage` (including loaded Swarm/subagent children with zero extra RPCs), cleanly hidden in single-model sessions. When 2+ models appear, renders a TrustedHTML-safe `36px` SVG donut ring with Top-3 legend inside inline `#cache-card`, and a `78px` interactive SVG donut + breakdown inside sidebar `#panel-model-mix` with `Total`/`Output`/`Calls` and `Session only`/`Include subagents` switchers.
- Opt-in model call timeline tree (`modelTimelineEnabled`, default `false`): dual-gated preference in `compat/preferences.mjs` (`schema: 1`) wired through `compat/runtime-ui.mjs`, `sidecars/panel/main.mjs`, `ide/main.mjs`, and `MetricsStore`. Disabled by default with zero extra trajectory fields retained, `modelTimeline: null`, zero `timeline-v1` disk writes, and a fixed-height collapsed `#timeline-off-bar`. When enabled, extracts strictly structural metadata (no prompts, response/thinking text, paths, commands, or args) into `Plan` / `Worker` / `Tools·Agents` horizontal swimlanes and a collapsible `Turn → Phase → Model Call / Tool Group / Subagent` tree (`sidecars/panel/timeline.mjs`), bounded on disk (`<= 400` nodes / `<= 192 KiB` in `sidecars/panel/timeline-store.mjs`) with one-click `clearTimeline`.
- Multi-account token usage isolation & ledger deduplication (`sidecars/panel/usage.mjs`, `compat/usage-ui.cjs`, `tools/reconcile-usage-ledger.mjs`): enforce strict per-account conversation ownership across live `DesktopUsage.ingest` and historical `DesktopUsage.runSync` (`registerOwnership`, `otherScopeFiles`, `inspectOtherAccounts`, primary-account tie-breaking, and time-bounded splitting of cross-account active continuations) so multi-account switches and rescans never inflate or leak token counts across accounts; remove the obsolete `Legacy unassigned` (`早期历史未区分用量`) tooltip row; add conservation-checked `tools/reconcile-usage-ledger.mjs` (`dry-run`/`--apply`) for cleaning historical duplicate ledger entries.
- Bump version to `0.10.0` across `plugin.json`, `package.json`, `ide/package.json`, and `sidecars/panel/package.json`, and exclude `timeline-v1` in `manage.py` runtime/package copy filters.

## 0.9.2 — 2026-11-13

- Subagent context occupancy ring & detail row: display per-subagent context usage percentage in a circular ring and expandable detail row (`sidecars/panel/app.js`, `delegated-usage.mjs`, `task-usage.mjs`, `compat/i18n.cjs`).
- Plain-language subagent status labels: translate raw `CASCADE_RUN_STATUS_*` enums into localized ZH/EN labels while preserving the raw enum in tooltips and handling prefix normalization cleanly.
- Inline subagent status indicator dot: place a colored 6×6px `.subagent-status-dot` directly after `.subagent-name` with semantic `data-status` styling (`running`, `waiting`, `done`, `idle`, `error`, `stopped`, `unknown`) so collapsed rows show status at a glance.
- Bump version to `0.9.2` across `plugin.json`, `package.json`, `ide/package.json`, and `sidecars/panel/package.json`.

## 0.9.1 — 2026-11-13

- Sidebar panel UI & animations: smooth quota/context meter transitions, elevated active metric chip indicator, GPU-composited status pulse halo, SVG chevron & WAAPI subagent tree/detail animations, narrow-width layout stability, and reduced-motion support.
- Inline widget & usage modal UX: 24-hour SVG trend line interactive crosshair and active point highlight, stacked bar & drilldown backdrop transitions, heatmap hover micro-interactions, `@starting-style` popover/modal entrance animations, permanent removal of the `#rate-note`/`#speed-basis` footnote, and an `Open sidebar` (`打开侧边栏`) action button in Session statistics.
- Responsiveness & performance: indexed day-lookup map in the usage modal, keyed in-place subagent tree reconciliation and delegated event handling, server-reuse and log-tail discovery caching, bounded chunk framing, parallel conversation stat hashing and quota requests, async TTL caching in the Electron IPC host, and Trusted Types DOM creation in the usage UI.
- Compatibility & bug fixes: fixed remote backfill metadata merge ordering and cancellation race conditions, `DesktopUsage.owns` boolean check, and invalid `[data-cascade-id]` owner isolation.

## 0.9.0 — 2026-11-11

- Model legend grouping and collapsible history: split model overview into currently active models in the selected date range (flat) and historical models (collapsible accordion via `#toggle-all-models`), maintaining full model filter compatibility.
- Custom date range and single-bar drilldown: added customizable date range picker (`<input type="date">`) with adaptive container horizontal scrolling for ranges > 31 days. Single bar drilldown highlights the clicked bar (`.selected`) and filters the lower detail table and metrics to that single bucket, with a one-click reset button.
- 24-hour token trend line chart (Hourly View): introduced interactive SVG 24-point smooth bezier curve line chart with gradient area fill. Supports viewing period-combined 24-hour total distribution across all days in the selected date range and single-day/today views, with strict geometric non-negative clamping preventing spline undershoot.
- Multi-account isolation and email display: decoupled active RPC connection from UI viewing scope (`viewScope`). Persisted user metadata in `accounts-v1.json` to display account emails and added an `All Accounts (Aggregated)` option.
- Legacy duplicate data gray styling: marked 302 legacy unassigned duplicate sessions as `isLegacy: true`, rendering them with a distinctive dashed gray style in the chart and tooltip annotations.
- Statistics dimension toggle: added `按模型统计` (By Model) <-> `按用户统计` (By User) toggle to switch chart colors, legend, and details breakdown between models and users.
- Remote project manual usage CRUD: added dialog and ledger management for manual token logging for mobile/remote project sessions using SHA-256 hashed JSON files, integrated across CDP bridge and Electron IPC.
- Header action layout fix: corrected CSS specificity bug in `.actions button` that squashed `.btn-manual` into a 32x32 square, ensuring neat inline alignment with window controls.
- Bump version to 0.9.0 across plugin, desktop, and lifecycle packages.

## 0.8.14 — 2026-11-11

- Bind "Last request" (`latestTps`) to settled requests: eliminate generating jitter and rate flicker by anchoring metric display to completed requests during streaming.
- Fix in-turn latest TPS settling in multi-round runs: eliminate `!isCurrentTurn` filtering so that completed requests in the current round immediately update `latestTps` across turns instead of locking to the prior turn.
- Prioritize latest valid settled rate (`status === 'ok'`) during execution: seamlessly absorb short tool-call windows (`short-tool-window`) to suppress false "Timing uncertain" (`计时异常`) red alert flickering while maintaining real-time throughput tracking.
- Safeguard pre-TTFT and early in-flight requests: accurately condition completed sample slicing on `hasActiveInSamples` so running generators without initial usage metadata do not inadvertently slice off the last completed sample.
- Decouple live generating state from timing anomalies, allow in-flight trajectory updates, and prevent false token-scope quarantines on fast text streams.
- Bump version to 0.8.14 across desktop, IDE, and lifecycle packages.

## 0.8.13 — 2026-11-11

- Fix streamed-thinking / periodic thought-summary TPS scope mismatch: pair full `outputTokens` with `streamingDuration` on sustained multi-block thinking streams (`duration >= 15s` or `duration >= max(2s, 2 × ttft)`) and quarantine shorter split-boundary windows (`token-scope`) instead of severely undercounting throughput.
- Prevent zero-visible-token thinking turns (`responseOutputTokens = 0`) from polluting session TPS denominators with hundreds of seconds of zero-numerator time.
- Expand buffered tool-call quarantine (`short-tool-window`) to cover multi-second flushes (`< 5s`, `ttft >= 1s`, `ttft / duration >= 12`) and preamble-plus-tool steps (`hasTools`), including normalized remote agent snapshots.
- Tighten short-sample (`< 1s`) spike outlier baseline (`>= 2` same-model samples, `max(2.5 × median, median + 6 × MAD)`) across unified model raw token basis, and skip trailing empty placeholder generator records when selecting `latestTps`.
- Bump `RATE_VERSION` to `3` so previously persisted `history-v1` rates recalculate cleanly on open, and fix sidebar panel unit labels (`计时异常` / `等待重算`) and subagent tree state reset across conversation switches.
- Bump version to 0.8.13 across desktop, IDE, and lifecycle packages.

## 0.8.12 — 2026-11-10

- Unlock widget height and width limits: remove hardcoded `580px` height and `640px` max-width locks, allowing the panel to adaptively fill auxiliary sidebar dimensions without whitespace.
- Protect session statistics and subagents layout from vertical clipping: ensure `.card-stage` has a minimum height base and subagents section maintains stable占位 (`flex: none`).
- Support smooth vertical scrolling for compressed window heights, ensuring subagent container and statistics remain fully accessible even in short window views.
- Bump version to 0.8.12 across plugin, desktop, and lifecycle packages.

## 0.8.11 — 2026-11-09

- Preserve subagent detail expansion and tree fold state across 2.2s polling refreshes without auto-collapsing.
- Restore subagent role names from `subagentSpec.role` / `typeName` in trajectory summaries, eliminating raw GUID-only listings.
- Native hierarchical multi-level tree folding for nested subagents with separate tree-toggle (`▼`/`▶`) and performance-detail toggle (`ℹ`) actions.
- Clean up task total tokens display in the inline bottom bar and statistics panel by eliminating misleading `(不完整)` / `(partial)` labels.
- Bump version to 0.8.11 across desktop, IDE, and lifecycle packages.

## 0.8.10 — 2026-11-08

- Relax renderer bridge and client socket timeouts to 45s / 60s for Cloud Remote Agent (Remote Project) sessions, preventing timeout-induced context drops on large histories.
- Tiered tail cold-read windowing: fetch only the most recent 50-step tail window for large remote sessions (> 50 steps), cutting cold load times from > 60s timeouts down to 3–6s while immediately rendering current token usage and model statistics.
- Sparse-array cache and async background backfill: maintain sparse step arrays and lazily page older history turns (0 to N-50) in the background without blocking the UI.
- Stuck RUNNING revalidation guard: actively reconcile stale `RUNNING` session status against `GetConversationMetadata` when step counts have settled or remote agent execution has completed.
- Implement incremental slicing via Connect RPC `initialStepsPageBounds`, fetching only new turns on active remote sessions and cutting active turn update latency to < 1s.
- Support global step index offset mapping in `normalizeRemoteSnapshot` for incremental remote streams.
- Bump version to 0.8.10 across desktop, IDE, and lifecycle packages.

## 0.8.9 — 2026-11-08

- Support Antigravity Cloud Remote Agent (Remote Project) sessions (`v1/default/jetski_remote_agents_3p/...`): normalize step-level `modelUsage`, nanosecond timestamps, response/thinking token durations, and synthesize host-reported context window occupancy from `modelInfo.maxTokens`.
- Automatically quarantine brief tool-only calls in Remote Agent turns using `short-tool-window` classification, preserving overall TPS accuracy while retaining token and cache metrics.
- Fast revalidation for settled compound remote conversations using lightweight `GetConversationMetadata`, avoiding redundant streaming calls when step count has not changed.
- Add duplicate plugin detection and guard in `manage.py` to prevent sibling backup folders (`antigravity-pulse-backup-*`) from hijacking the sidecar owner.
- Bump version to 0.8.9 across desktop, IDE, and lifecycle packages.

---

## Upstream History (v0.8.7 and earlier — AG Pulse contributors)

> Entries below (`v0.8.7 patch` and earlier) originate from the upstream MIT-licensed project [`ATtacK030130/antigrative-dashboard`](https://github.com/ATtacK030130/antigrative-dashboard) by **AG Pulse contributors**. Releases from **v0.8.8+** (`0.8.9` and newer above) are independently maintained and updated in this independent fork (`ShZbz/antigravity-dashboard`).

## 0.8.7 patch — 2026-10-15

- Show measured download bytes and percentage in App updates. Use animated phase feedback for checking, verification, extraction, backup and installation; settle smoothly on completion and follow the host theme. A completed check does not animate backwards into a new download, and only the glyph rotates inside its stable icon surface.
- Keep optional worker progress separate from the verified final result. Bound/allowlist progress events, prevent backwards byte counts and keep unavailable progress consumers from failing an installation.
- Reuse verified disk/host checkpoints for settled histories after collector restarts, displaying saved totals while background checks run. Treat the first temporary read failure as synchronization/retry status. Repeated unresolved reads, unreadable ledgers, missing Token components and persistence failures retain coverage warnings.
- Refresh the existing v0.8.7 App/CLI ZIP, IDE VSIX and SHA-256 assets. Version numbers remain 0.8.7; same-version updates require manual reinstall. The original Git tag/source archive is retained; the refreshed release notes identify the patch source commit.

## 0.8.7 — 2026-10-15

- Integrate [#17](https://github.com/ATtacK030130/antigrative-dashboard/pull/17): discover historical IDs independently from the App/IDE conversation and brain directories, then read usage from the authenticated local API. Host directories and ledgers remain separate; custom IDE storage does not disable discovery.
- Repair prior partial imports using the shared paginated statistics reader, with existing memory/deadline/revision checks. Persist hashed per-account source signatures and completion/retry checkpoints, retry failed archives with backoff, retain queued manual full refreshes and yield short background batches. Installation no longer starts a separate ledger writer; previous statistics/preferences remain intact.
- Accept official SidecarApp SDKs without the optional `close` prototype method while still checking required exports and loopback binding.
- Eliminate long-chat usage-window open/close stalls caused by native whole-document modal inertness changes. Keep a top-layer dialog, backdrop, Escape, nested year menus, keyboard focus containment/return and composer-replacement recovery. Add a synthetic 20,000-element regression.
- Adopt only the manual App update feature proposed in [#16](https://github.com/ATtacK030130/antigrative-dashboard/pull/16). Entry: context details → bottom-right **⋯ → Check for updates**. Checks run only after a click; IDE/CLI and the host application are not update targets.
- Harden updates with exact official asset/version/path identity, required SHA-256 and download size, bounded extraction, link/duplicate-path rejection, coalesced concurrent actions, OS-backed lifecycle locking, durable backup/journals and independent interrupted-update recovery. Slow checks poll asynchronously; a narrowly scoped TLS 1.2 retry retains certificate/hostname validation.
- Preserve the annual heatmap, current model charts and compact controls. The hourly chart, cost estimation, component filters and unrelated layout changes in #16 are not included. CLI behavior is unchanged.
- Publish App/CLI ZIP and IDE VSIX with SHA-256 files. Windows local acceptance and synthetic/browser tests do not establish macOS/Linux signed-in GUI acceptance, future-release startup, physical power-loss or damaged-media recovery. See [usage](docs/USAGE.md) and [update boundaries](docs/UPDATES.md).

## 0.8.6 — refreshed packages 2026-10-15 (initial release 2026-10-14)

- Fix [#12](https://github.com/ATtacK030130/antigrative-dashboard/issues/12): count readable uncached input, cache reads/writes and output independently of cache-rate eligibility. Keep conservative coverage, valid zero-input semantics, safe sums and restart recovery without deleting saved usage.
- Simplify Token/cache cards and the inline strip: remove repeated inequality prefixes, calculation prose and coverage-count paragraphs while retaining measured values and unavailable-value dashes. Detailed limits remain in the README.
- Simplify context cards: keep host occupancy, used/total tokens, sampled model, shared quotas/reset times and bottom language controls. Remove duplicate capacity references, unknown compaction fields and logged-text diagnostic UI. Provider references never replace the host denominator.
- Include reviewed #13 IDE process ownership and validated SDK compatibility, #14 context semantics, and #15 bounded optional transcript collection/rewind identity. Transcript diagnostics remain numeric backend data; unsupported compaction/image event cases have synthetic coverage only.
- Preserve the annual activity heatmap, existing model charts, responsive composer controls, statistics/preferences and CLI accounting. The withdrawn hourly drilldown and calendar selection highlight are not included.
- Rebuild the App/CLI ZIP, IDE VSIX and matching SHA-256 files under the existing v0.8.6 release. Align its tag/source archives with the checked build snapshot. The original version number is unchanged; local-only updater/backfill work under review is excluded.

## 0.8.5 — 2026-10-13

- Replace whole-trajectory polling with independent offset reads for steps and generator metadata (`includeMessages: false`), using summaries, cached immutable prefixes and revalidated mutable tails. Incrementally validate/project returned JSON without retaining prompts, attachments or tool output. Preserve tool-only classification rather than substituting reduced verbosity that loses tool-call markers.
- Remove the provisional 512 MiB whole-response cap for statistical streams. Use an 8 MiB projected-statistics/cache budget, bounded parsing and timeouts; ordinary/error responses remain separately bounded. Local synthetic 0/40/640 MiB and 1K/8K/16K/32K-record experiments underpin the budget and document its limits in [long-conversation collection](docs/LONG_CONVERSATIONS.md).
- Preserve offsets, request deduplication, usage identities and rate/cache/context values; invalidate caches on rewinds, settled edits, account/endpoint changes and manual refresh. Periodically recheck idle tails; failed pages cannot replace complete cached revisions. Real Windows metadata/usage parity and synthetic large-page regressions pass; the reporting user's exact conversation remains untested.

## 0.8.4 — 2026-10-13

- Redesign the App side panel as a persistent dashboard: three metric cards also select detail tabs, compact quota summaries stay visible, the default speed details remain open, and long details scroll within a fixed frame. Pointer departure no longer hides selected information; arrow/Home/End keyboard selection is supported. Shared metrics, preference storage and theme adaptation are retained.
- Version panel scripts and styles together from a content hash and serve uncached resources; align the hosted iframe background with its derived theme despite the SDK's inline body background. Prevent mixing new HTML with cached older code/styles during plugin updates.

- Address [#11](https://github.com/ATtacK030130/antigrative-dashboard/issues/11): serve the sidecar panel as a self-contained classic script instead of loading ESM dependencies from plugin://. Defer the entry script, wait for DOM readiness, guard missing widgets and prevent duplicate initialization. Both the SDK and standalone preview use the same bundle generator.
- Add one asynchronous, hidden and time-bounded PID-filtered Get-NetTCPConnection fallback when Windows netstat has no listener for a candidate or fails. Recognize localized listening states and try the Windows .gemini log location as a fallback, retaining process/port ownership validation and explicit log overrides.
- Add Chromium checks for ordinary and early classic-script loading, opaque sandboxed iframe execution, metrics/cache/context/quota display, language/manual refresh, automatic recovery and duplicate scripts. Windows signed-in plugin:// verification reproduces the old uninitialized module panel and confirms the restarted classic/deferred panel, matching inline metrics, language switching and manual refresh. The reporting user's machine remains a separate acceptance scope.

## 0.8.3 — 2026-10-12

- Separate App RPC/application failures from endpoint loss. Missing historical trajectories, HTTP 4xx/5xx other than credential failures, and malformed responses no longer trigger process discovery. Coalesce concurrent discovery and back off failed cold starts from 3 seconds to a maximum of 30 seconds; transport/credential failures still recover automatically with bounded scans.
- Restore the data binding subscription after Runtime domain resynchronization and release abandoned bridge requests without disabling the widget. The v0.8.2 candidate was blocked by CI before package publication; the completed fix ships in v0.8.3.
- Track top-frame navigation and default execution contexts, including reversed event ordering. If hooks exist without a trusted main context, resynchronize Runtime events on the same socket. Navigation exceptions remove the failed session's preload before reconnecting. Keep remote/iframe contexts excluded.
- Add local HTTP regressions for history errors, cold-start/auth cooldown and backend restarts, plus real Chromium/CDP delayed-composer and interrupted-navigation coverage. The reporting user's exact environment and failure remain unverified; these tests do not establish the cause of every cold-start failure.

- Isolate pending-hover cancellation from fresh pointer entry in the composer-remount browser regression; retain the cold-hover and auto-dismiss assertions.

## 0.8.1 — 2026-10-12

- Address [#9](https://github.com/ATtacK030130/antigrative-dashboard/issues/9) in the App runtime adapter: retain the widget during send/stop/cancel transitions, discover static Teamwork badges without title/span assumptions, and scope visible editors/model controls to their nearest composer owner. Ignore hidden/inert and deeper nested editors; reject ambiguous anchors.
- Recreate the usage controller after a closed-dialog composer teardown, rather than reattaching a strip whose dialog was already disposed. Invalidate pending requests from that mount. Context language choices update usage-entry labels immediately and keep the usage dialog localized. Desktop/IDE browser regressions cover temporary missing composers; English/Chinese Teamwork fixtures cover main/subagent return navigation and clickable localized usage windows after remount.
- Follow the active composer's nearest `data-cascade-id` when nested navigation leaves the route unchanged. Invalid explicit IDs clear conversation statistics rather than inheriting the parent route; late responses remain isolated. Add English/Chinese production-browser regressions for six nesting levels, working controls, DOM-only navigation and ambiguity. Windows signed-in three-level delegation checks cover independent metrics, return navigation and a generating-state screenshot. That host changes the route and renders one composer, so six-level DOM and unchanged-route coverage remain browser fixtures. User acceptance and Linux/macOS GUI checks remain open.
- Prioritize current-request cache-read percentage in the CLI status line, with read tokens as secondary text. Narrow terminals retain context/cache percentages before bars, read counts and state. Keep unknown counter semantics unavailable and expose the reason in allowlisted JSON.
- Calculate percentages only for empirically tested CLI/model counter scopes with zero cache writes; explicitly zero reads with valid nonempty input show 0%. Do not use output, cumulative totals, another request's percentage or desktop history.
- Enable nonzero Gemini 3.8 Flash (High) cache percentages on CLI 1.3.3 after diagnosing a real current-request snapshot with reads greater than input. Earlier previews omitted this model even when reads were available; short artificial Gemini tests returning zero do not establish nonzero-cache support by themselves.
- Do not report busy zero-cache snapshots as completed 0% hits. Thinking/working/tool/initializing with zero reads display `Cache --` without `0 read`; available nonzero reads remain usable while busy, and idle valid zero reads still show 0%. No percentage is borrowed from previous requests. Windows and Linux CLI regressions cover both languages and separate status-line processes.

## 0.8.0 — 2026-10-11

- Make English/Chinese agent installation prompts detect the host and require target confirmation before downloads/configuration changes. Distinguish App, CLI and standalone IDE; the shared ZIP does not mean the App installer should run for CLI users.
- Add local Token usage to the desktop App and standalone IDE: daily/weekly contribution grids, day/week/month model stacks, model filtering, full-count tooltips/tables, and a compact two-column Today / This month cache-card entry. Theme-driven model colors follow custom accent/background changes.
- Keep the usage frame stable across month changes, empty data, missing snapshots, account switches and composer replacement. Use a themed year menu and aligned controls; manual refresh queues behind polling and completes a visible rotation.
- Explain local history import, UTC+8 date boundaries, coverage/billing limits and storage on first opening. Persist acknowledgment independently of language; save failures stay visible and retryable. Local replay controls are excluded from packaged collectors.
- Address [#8](https://github.com/ATtacK030130/antigrative-dashboard/issues/8): pair response tokens with their own stream durations, quarantine inconsistent token/retry/duplicate scopes and suspicious brief tool-only windows, and use a same-model median/MAD baseline for short outliers. Do not cap sustained high throughput or invent generation time. Token/cache/context counts remain available.
- Recalculate legacy saved TPS from complete trajectories, retaining other statistics and protecting full coverage from partial backend responses. An unreliable latest request stays unavailable rather than borrowing an older rate.
- Fix hover cards staying open after closing usage: pointer-restored focus no longer reopens or pins a card; keyboard focus and Escape return remain supported. Desktop/IDE regressions cover the full return-and-hover flow.
- Retain usage in a separate account-scoped `usage-v1` ledger, deduplicated by hashed request identity. No prompts, replies or credentials are stored. Available local history is backfilled; deleting chats does not erase already recorded consumption. Desktop and IDE ledgers stay separate; CLI behavior is unchanged.
- Refresh English/Chinese illustrations from the current production renderer and add activity/model-chart previews. Add usage-window/onboarding coverage to the Windows/Linux/macOS CI and release gates. Signed-in Linux/macOS GUI acceptance remains outstanding.

## 0.7.0 — 2026-10-11

- Add a dedicated VSIX adapter for Google's standalone Antigravity IDE. Keep host-specific DOM/conversation discovery separate from the shared renderer; narrow panes show three icons, wide panes expose values, and native controls retain their space.
- Bind each input to its actual conversation and the IDE main language server, excluding desktop/autocomplete/other-profile sources. New or unrecognized conversations do not inherit another chat's samples.
- Prefer response/message IDs when deduplicating model requests; execution IDs shared by tool follow-ups no longer collapse valid requests or lose cache reads.
- Build fixed templates with DOM operations under existing Trusted Types policies. Avoid unchanged label/style/ARIA writes and max-height measurement oscillation so polling preserves card scroll, focus and open menus.
- Retain theme, language, first-use guide and per-account/conversation aggregate history. Gate extension activation and install helpers to Antigravity IDE; use only fresh health records.
- Add dependency-free VSIX packaging, SHA256 validation and an optional host-bundled-runtime install/launch/uninstall helper. Publish ZIP and IDE VSIX independently with checksums, after three-platform automated gates.
- Include merged PR #7 by @qwqZYLqwq: 250ms cold hover, immediate warm transitions, 120ms leave grace, 350ms warm window, guarded delayed callbacks and 16 browser regressions with deterministic macOS startup timing.
- Windows IDE 2.5.5 has real local acceptance. Linux/macOS IDE GUI acceptance remains open; other editor extensions and named/custom IDE profiles remain unsupported. Existing desktop screenshots are explicitly identified as desktop examples.

## 0.6.4 — 2026-10-10

- Address [#6](https://github.com/ATtacK030130/antigrative-dashboard/issues/6): remove the duplicate toolbar language button; retain explicit English / 简体中文 choices at the bottom of context details. Add a compact bilingual first-use tip beside the context chip so users can find the setting despite the English default. Opening the tip locates and focuses the language choices without stealing focus on initial display.
- Persist guide completion independently of the renderer origin. Closing the tip keeps the current language; successfully choosing either language completes onboarding. Failed saves remain visible and retryable. Show the guide in the main composer only; existing saved language choices are retained.
- Protect native subagent labels and SVG sizes when the sidebar narrows the composer. Reserve their natural width, switch to three icons earlier, release all plugin flex space if the icons cannot fit, and restore full statistics when space returns. Avoid repeated full-layout probes and no-op class mutations during continuous dragging.
- Add first-use, dismissal, explicit language choice, save-failure retry, fresh-origin/backend persistence and native-label/icon geometry regressions.
- Refresh English/Chinese README and release artwork from the v0.6.4 widget, without the duplicate toolbar language button: full and icon layouts, separate subagent statistics, speed/cache details and combined context/quotas with language choices at the bottom. Use one color theme and compact two-column details; read the version from the manifest when regenerating images.
- Allow up to 30 seconds for the CLI shell-transport test on Windows CI, where cold CMD/PowerShell/Node startup exceeded the previous 10-second limit. Keep the exit-code and exact rendered-output assertions, with no automatic test retry. Desktop and CLI runtime behavior is unchanged.

## 0.6.3 — 2026-10-10

- Fix a small position jump when reversing a density transition: capture the currently painted copies before the flex layout changes, and retain source metadata for outgoing labels.
- Make intermediate-frame and reversal assertions deterministic using exact WAAPI times. Tighten reversal continuity to under 1px; keep continuous dragging, rapid switching and cleanup tests on real time.
- Includes the responsive motion and resize performance improvements below. v0.6.2 publication was blocked by the macOS motion gate; its existing tag is retained unchanged.

## 0.6.2 — 2026-10-10 (not published)

- Animate responsive full-statistics / three-icon changes with a 240ms interruptible transition: fade outgoing values, move the existing icon shapes and ease the native model name back into view. Keep icon hit targets active throughout.
- Clip inert motion copies away from native composer actions; immediately cancel on unsafe placement, navigation, reparenting or disposal. Preserve host layout styles and avoid replaying motion on metric polls or scrolling alone.
- Add production-renderer browser coverage for in-flight geometry, rapid reversal, outgoing-label cleanup, native hit targets and system reduced-motion feedback. Run `npm run preview:motion` for an interactive local demonstration.
- Fix resize-drag stutter and trailing motion copies: keep one animation clock per density change, clip the existing ribbon as the composer moves, capture visual pieces only for actual transitions, and avoid probing full layout repeatedly while shrinking. Use 12px of recovery headroom to prevent density chatter; retain the complete default transition.

## 0.6.1 — 2026-10-10

- Refresh immediately on parent/subagent navigation instead of inheriting the old polling clock or waiting for its in-flight request. Guard success, failure and cleanup by navigation generation, and avoid listing every conversation when an exact ID is supplied. Preserve queued manual refresh feedback.
- Add a subagent strip inside the host's stable input box, beside its static identity badge. Display current child throughput, cache and context; label detail cards as current subagent statistics and quotas as account-wide balances.
- Reduce narrow composers to three interactive icons (speed, cache and context), hiding only when those icons cannot fit safely. Keep language switching in the context card and restore full statistics when space returns.
- Fix controls disappearing during message scrolling: clipped or covered message controls are not visible collisions. Continue reserving local composer actions and protecting actually painted floating controls.
- Clear statistics immediately on parent/child navigation and reject late or mismatched conversation responses. Add English/Chinese browser coverage for child request ownership, late responses, quota scope and narrow layouts.
- Fix inline dashboard overlap with Agent Manager / Subagent window controls (issue #5). Require a horizontal action row adjacent to its editable composer; reject app headers, distant toolbars and unsupported layouts.
- Use bounded, shrinking inline sizing without changing the host model branch or raising the strip above neighboring buttons. Clip overflowing chips, compact when space is limited and hide the strip if it still cannot fit or intersects host controls.
- Recheck geometry after resize, scroll, host layout mutations and composer replacement; close open cards when placement becomes unsafe and restore the strip when space returns. Keep detail cards in the browser top layer.
- Add browser regressions for header rejection, English/Chinese widths, real control clicks, absolute-position collisions, recovery and preservation of host styles. This shared renderer fix applies to all desktop platforms; signed-in Linux/macOS GUI acceptance remains separate.

## 0.6.0 — 2026-10-10

- Add a standalone Antigravity CLI statusLine adapter: explicit context occupancy, current cache read tokens, agent state, grouped Gemini/Claude-GPT quotas and reset countdowns.
- Prioritize key values with foreground colors and bold text; show quota numbers and bars in green at ≥70% remaining, yellow at ≥30% and <70%, red below 30%, with a textual low-balance alert.
- Give the shared quota label distinct Claude (#DA7756) and GPT (#F8FAFC) foreground colors; use the default foreground for GPT when a light-background terminal hint is supplied.
- Support English/Chinese, CJK/emoji-aware terminal widths, narrow layouts, optional details and monochrome terminals without forcing the terminal background.
- Add independent install-cli/status-cli/uninstall-cli commands, atomic settings updates, recovery of the prior status line, safe reinstall and user-directory runtime storage that survives CLI binary replacement.
- Fix Windows agy Go/CMD quote transport using a literal-path UTF-8 PowerShell encoded invocation; retain POSIX shell quoting for Linux/macOS.
- Keep Unicode installation paths from failing after a successful install on redirected Windows consoles using legacy encodings.
- Include CLI modules in the portable release package and regression suites for payload validation, color thresholds, widths, language persistence, shell transport and lifecycle restoration.
- Add a real Windows CLI 1.3.2 two-turn conversation screenshot. Signed-in Linux/macOS interactive acceptance remains outstanding.
- Omit CLI tok/s and cache hit ratios because the documented input does not establish streaming duration or the needed cache denominator; missing values remain explicit and no transcripts or new metric history are read or stored.

## 0.5.2 — 2026-10-09

- Follow the host's custom background, card and foreground colors for chips, hover cards and quota menus; derive matching controls and tracks with readable text, and restore fallback colors when host tokens disappear.
- Locate localized composers through editable WAI-ARIA roles, stable model identifiers and the nearest DOM containment boundary, independent of send/record/cancel text (issue #4).
- Scope the model label to the selected composer; reject hidden or ambiguous candidates and reattach safely after composer replacement or reparenting.
- Follow the active Antigravity primary color for context rings and context/quota bars; use whitelisted custom dark/light theme seeds as a live configuration fallback (issue #3).
- Keep small emphasized text and refresh feedback readable under custom colors, and restore the default palette when a custom color is removed or invalid.
- Show manual refresh progress with a spinning icon and localized busy state; coalesce repeated clicks, honor reduced motion and queue a forced refresh behind background polling.
- Keep the selected quota group only in the hover card; remove the extra toolbar label when manually switching away from the current model's quota group.
- Keep quota-group clicks inside the widget so the host composer cannot steal focus and close the card; preserve menu selection, keyboard activation and outside-click dismissal.
- Correct macOS language-server logs to `~/Library/Logs/Antigravity/language_server.log`, retain a profile-path fallback and support an explicit `AG_PULSE_LOG` override (issue #1).
- Filter Windows standalone processes before one native `netstat` snapshot; match listening IPv4/IPv6 sockets to exact PIDs without per-process CIM port queries (issue #2).
- Serialize sidecar ownership claims and retire superseded processes; isolate instance bindings, ignore late responses/injections and keep old shutdown from disposing a newer widget (issue #2).
- Promote inline hover cards to the browser top layer so host jump-to-bottom controls cannot cover details inside composer stacking contexts.
- Save the English/Chinese preference in an atomic, app-independent user configuration file; changing host ports, reloading or restarting no longer loses it.
- Share the preference between the inline widget and side panel, migrate existing browser choices once and protect newer selections from stale startup/polling responses.
- Report failed language writes instead of silently treating browser-only storage as a successful save.
- Gate publication on Windows, Linux and macOS data/lifecycle tests, Chromium theme/localization/preference regressions and official Linux/macOS desktop resource/SDK checks. Browser fixtures do not replace signed-in host GUI acceptance.

## 0.5.1

- Follow the Antigravity light/dark theme for toolbar chips, all hover cards, quota menus and warning states; fall back to the OS in standalone previews.
- Share one palette and theme controller between the injected widget and native SDK panel; react to host classes, background tokens and live theme changes without resetting statistics.

- Crop README screenshots around the controls and cards; show a single color theme to avoid repeated artwork.

## 0.5.0

- Consolidate context, five-hour and weekly quotas into one hover card; keep only TPS, cache and context chips in the toolbar on every platform.
- Isolate the current renderer protocol from older sidecars that survive an app update, preventing stale context schemas from replacing valid occupancy readings.
- Add a Codex-style context occupancy ring and hover card to inline and sidecar views, with used/remaining percentages and used tokens versus capacity.
- Read the host's latest request-start context estimate; never infer model capacity or equate cumulative input with context. Unknown/over-capacity data stays explicit.
- Persist only whitelisted numeric context snapshots per conversation and account; allow occupancy to shrink after compaction and clear values when switching chats.
- Add native Windows/Linux/macOS profile and settings paths, PID-owned port discovery, SDK lookup, custom installation overrides and POSIX install/uninstall scripts.
- Run lifecycle and metric tests on all three OS runners, plus Linux/macOS official desktop resource/embedded-SDK checks. Release publication requires those checks.
- Preserve the plugin-owned reconnecting adapter and app.asar integrity protections. Linux/macOS signed-in GUI verification still requires a real user session.

## 0.4.0

- Replace default app.asar patches with plugin-owned runtime attachment; reconnect after app updates and renderer startup document replacement.
- Rediscover backend credentials and validate that the selected HTTP port belongs to the current standalone process.
- Persist numeric TPS/cache statistics per account and conversation with atomic writes, account isolation, and protection against empty/regressing metadata.
- Restore saved statistics with a timestamp when historical RPC data is unavailable; preserve real zero cache hits.
- Keep conversation collection working when quota/list endpoints fail; report storage failures without discarding live metrics.
- Replace old renderer hooks after plugin code updates and expose integration health in status/panel APIs.
- Add history backfill/restart verification and a documented robustness matrix.
- Default migration/uninstall never overwrites unverified application changes. Legacy loader remains explicit opt-in.

## 0.3.0

- Add a DSH-style Token usage card: total tokens, cache hit rate, uncached input, cache reads, output, and optional cache writes.
- Show compact token totals and cache hit rate next to TPS.
- Calculate cache hits from the local Antigravity normalized counters: cached reads divided by uncached input plus cache reads and writes.
- Make English the default UI language; add persistent English / Simplified Chinese switching for inline and sidecar views.
- Translate quota cards, timers, accessibility labels, and backend error states.
- Add cache counter and language-switch regression tests.

## 0.2.0

- Package Antigrative Dashboard as a standalone MIT-licensed project.
- Add install, enable, disable, status, uninstall and release packaging commands.
- Restore the original application on uninstall using verified archive backups.
- Keep the compact widget beside the model selector and hide unused TPS in new chats.
- Keep quota menus open across polling cycles.
- Show actual Antigravity session throughput and independent model-group quotas.
- Validate support for Windows Antigravity desktop 2.19.1 only.

## 0.1.0

- Initial local collector, sidecar panel, and inline toolbar adapter.
