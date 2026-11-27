// On-demand MCP tools and action dispatcher backed by Antigrative Dashboard's shared local stores.
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import type {
  AddAccountRequest,
  AddManualUsageRequest,
  DeleteManualUsageRequest,
  HostThemeConfig,
  ManualUsageInput,
  PreferencesSnapshot,
  PreferencesUpdateInput,
  QuotaGroup,
  QuotaWindow,
  ReassignConversationRequest,
  SetRecordingAccountRequest,
  SpeedMetrics,
  SwitchAccountRequest,
  UsageAccountInfo,
  UsageBucketCounts,
  UsageSummarySnapshot,
} from '../contracts/index.ts';
import type { PlatformPaths } from '../platform/paths.ts';
import type { PreferencesStore } from '../platform/preferences-store.ts';
import { compact, countdown, count, percent, rate, resetDate } from '../shared/format.ts';
import type { DesktopUsage, DesktopUsageStore, UsageLedger } from '../telemetry/ledger/index.ts';
import type { MetricsStore } from '../telemetry/store/index.ts';
import type { McpCallToolResult, McpToolDefinition } from './protocol.ts';

export const USAGE_APP_RESOURCE_URI = 'ui://antigravity-pulse/usage.html';
export const USAGE_APP_MIME_TYPE = 'text/html;profile=mcp-app';
export const INITIAL_PAYLOAD_MAX_BYTES = 768 * 1024;
export const DEFAULT_IDLE_DISPOSE_MS = 90_000;

type PathsModule = typeof import('../platform/paths.ts');
type PreferencesModule = typeof import('../platform/preferences-store.ts');
type LedgerModule = typeof import('../telemetry/ledger/index.ts');
type LocalConversationsModule = typeof import('../telemetry/reader/local-conversations.ts');
type StoreModule = typeof import('../telemetry/store/index.ts');
type HostThemeModule = typeof import('../ui/theme/host-theme.ts');
type NativeBridgeModule = typeof import('../platform/native-bridge.ts');

let pathsModPromise: Promise<PathsModule> | null = null;
let prefsModPromise: Promise<PreferencesModule> | null = null;
let ledgerModPromise: Promise<LedgerModule> | null = null;
let localConvModPromise: Promise<LocalConversationsModule> | null = null;
let storeModPromise: Promise<StoreModule> | null = null;
let themeModPromise: Promise<HostThemeModule> | null = null;
let nativeBridgeModPromise: Promise<NativeBridgeModule> | null = null;

function loadPathsModule(): Promise<PathsModule> {
  return (pathsModPromise ??= import('../platform/paths.ts'));
}
function loadPreferencesModule(): Promise<PreferencesModule> {
  return (prefsModPromise ??= import('../platform/preferences-store.ts'));
}
function loadLedgerModule(): Promise<LedgerModule> {
  return (ledgerModPromise ??= import('../telemetry/ledger/index.ts'));
}
function loadLocalConversationsModule(): Promise<LocalConversationsModule> {
  return (localConvModPromise ??= import('../telemetry/reader/local-conversations.ts'));
}
function loadStoreModule(): Promise<StoreModule> {
  return (storeModPromise ??= import('../telemetry/store/index.ts'));
}
function loadThemeModule(): Promise<HostThemeModule> {
  return (themeModPromise ??= import('../ui/theme/host-theme.ts'));
}
function loadNativeBridgeModule(): Promise<NativeBridgeModule> {
  return (nativeBridgeModPromise ??= import('../platform/native-bridge.ts'));
}

const SCOPE_HASH = /^[a-f0-9]{64}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type UsageActionName =
  | 'get_snapshot'
  | 'get_accounts'
  | 'switch_account'
  | 'get_recording_account'
  | 'set_recording_account'
  | 'add_account'
  | 'reassign_conversation'
  | 'add_manual_usage'
  | 'delete_manual_usage'
  | 'get_project_overview'
  | 'get_project_detail'
  | 'get_preferences'
  | 'set_preferences';

export interface PulseMcpBackendOptions {
  paths?: PlatformPaths;
  ledger?: UsageLedger;
  preferences?: PreferencesStore;
  store?: MetricsStore;
  usage?: DesktopUsage;
  readTheme?: () => Promise<HostThemeConfig>;
  profileDir?: string;
  now?: () => number;
  idleDisposeMs?: number | null;
}

export interface PulseMcpBackend {
  callTool(name: string, args: Record<string, unknown>): Promise<McpCallToolResult>;
  dispose(): void;
}

export const PULSE_MCP_TOOLS: readonly McpToolDefinition[] = [
  {
    name: 'open_usage_dashboard',
    title: 'Token Usage',
    description:
      'Open the interactive full-page Token Usage dashboard showing token activity heatmaps, daily/weekly/monthly charts, model/user/project breakdowns, and account management.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          description: "Optional account scope hash or 'all' (defaults to current view scope).",
        },
        force: {
          type: 'boolean',
          description: 'Force a fresh reload from disk before returning.',
        },
      },
      additionalProperties: false,
    },
    _meta: {
      ui: { resourceUri: USAGE_APP_RESOURCE_URI },
      'com.google.antigravity/ui': {
        entrypoints: [{ type: 'global', title: 'Token Usage' }],
      },
    },
  },
  {
    name: 'query_usage_stats',
    title: 'Query Usage Stats',
    description:
      'Read-only query of recorded token usage totals and breakdown by period (today, week, month, custom) and dimension (model, user, project).',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        period: {
          type: 'string',
          enum: ['today', 'week', 'month', 'custom'],
          description: "Aggregation period (default: 'month').",
        },
        from: {
          type: 'string',
          description: 'Optional start date YYYY-MM-DD (used with custom period or to override start).',
        },
        to: {
          type: 'string',
          description: 'Optional end date YYYY-MM-DD (used with custom period or to override end).',
        },
        dimension: {
          type: 'string',
          enum: ['model', 'user', 'project'],
          description: "Breakdown dimension (default: 'model').",
        },
        scope: {
          type: 'string',
          description: "Optional account scope hash or 'all' (default: current view scope).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_quota_and_session',
    title: 'Quota & Active Session',
    description:
      'Read-only query of current 5h/weekly model quotas, reset countdowns, and active session throughput (TPS), cache hit rate, and context window usage.',
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: {
          type: 'string',
          description: 'Optional conversation UUID to inspect (defaults to latest active session).',
        },
        force: {
          type: 'boolean',
          description: 'Force refresh against the local Antigravity server when available.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'pulse_usage_action',
    title: 'Pulse Usage Action',
    description:
      'Internal app-only multiplexed endpoint for the Token Usage MCP App UI (snapshots, accounts, manual entries, project drilldowns, and preferences).',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: [
            'get_snapshot',
            'get_accounts',
            'switch_account',
            'get_recording_account',
            'set_recording_account',
            'add_account',
            'reassign_conversation',
            'add_manual_usage',
            'delete_manual_usage',
            'get_project_overview',
            'get_project_detail',
            'get_preferences',
            'set_preferences',
          ],
          description: 'UI action identifier.',
        },
        payload: {
          type: 'object',
          description: 'Optional action-specific parameters.',
        },
      },
      additionalProperties: false,
    },
    _meta: {
      ui: { visibility: ['app'] },
    },
  },
];

export function createLocalIdentityResolver(
  ledger: UsageLedger,
  profileKey: string,
  isVertex = false,
): (recentConversationIds: readonly string[]) => Promise<string | null> {
  return async (recentConversationIds: readonly string[]): Promise<string | null> => {
    const [explicitSelected, meta, ownership, dirs] = await Promise.all([
      ledger.getActiveLocalAccount().catch(() => null),
      ledger.accountsMeta().catch(() => ({} as Record<string, { primary?: boolean; updatedAt?: unknown }>)),
      ledger.ownership().catch(() => ({} as Record<string, string>)),
      ledger.scopeDirectories().catch(() => [] as string[]),
    ]);
    if (explicitSelected && SCOPE_HASH.test(explicitSelected)) return explicitSelected;
    const known = new Set<string>([
      ...Object.keys(meta).filter((k) => SCOPE_HASH.test(k)),
      ...dirs.filter((k) => SCOPE_HASH.test(k)),
    ]);
    for (const cid of recentConversationIds) {
      const owner = ownership[String(cid || '').toLowerCase()];
      if (owner && SCOPE_HASH.test(owner) && (known.size === 0 || known.has(owner))) return owner;
    }
    const metaEntries = Object.entries(meta).filter(([k]) => SCOPE_HASH.test(k));
    const primary = metaEntries.find(([, info]) => info?.primary === true);
    if (primary) return primary[0];
    const newest = [...metaEntries].sort((a, b) => {
      const ta = typeof a[1]?.updatedAt === 'string' ? Date.parse(a[1].updatedAt) || 0 : 0;
      const tb = typeof b[1]?.updatedAt === 'string' ? Date.parse(b[1].updatedAt) || 0 : 0;
      return tb - ta;
    })[0];
    if (newest) return newest[0];
    const firstDir = dirs.find((k) => SCOPE_HASH.test(k));
    if (firstDir) return firstDir;
    const prefix = isVertex ? 'vertex:' : 'local:';
    return createHash('sha256').update(`${prefix}${profileKey}`).digest('hex');
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toPlainAccounts(accounts: readonly UsageAccountInfo[]): UsageAccountInfo[] {
  return accounts.map((acc) => ({
    id: acc.id,
    name: acc.name,
    email: acc.email ?? acc.name,
    ...(acc.primary !== undefined ? { primary: acc.primary } : {}),
    active: acc.active,
  }));
}

function addBucket(target: UsageBucketCounts, add: UsageBucketCounts): void {
  target.uncached += add.uncached;
  target.cacheRead += add.cacheRead;
  target.cacheWrite += add.cacheWrite;
  target.output += add.output;
  target.total += add.total;
  target.requests += add.requests;
}

function emptyBucket(): UsageBucketCounts {
  return { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0, requests: 0 };
}

function resolveDateRange(
  today: string,
  period: 'today' | 'week' | 'month' | 'custom',
  weekStartFn: (date: string) => string,
  fromArg?: string,
  toArg?: string,
): { from: string; to: string } {
  if (fromArg && !ISO_DATE.test(fromArg)) throw new Error(`Invalid 'from' date (expected YYYY-MM-DD): ${fromArg}`);
  if (toArg && !ISO_DATE.test(toArg)) throw new Error(`Invalid 'to' date (expected YYYY-MM-DD): ${toArg}`);
  let from = fromArg || today;
  let to = toArg || today;
  if (!fromArg) {
    if (period === 'today') from = today;
    else if (period === 'week') from = weekStartFn(today);
    else if (period === 'month') from = `${today.slice(0, 7)}-01`;
  }
  if (from > to) throw new Error(`Invalid date range: 'from' (${from}) is after 'to' (${to})`);
  return { from, to };
}

function formatQuotaWindow(win: QuotaWindow | undefined, nowMs: number): string {
  if (!win) return '—';
  if (!win.available) return win.reason || 'Unavailable';
  const rem = percent(win.remaining);
  const reset = win.resetAt ? `${countdown(win.resetAt, nowMs, true, 'en')} (${resetDate(win.resetAt, 'en')})` : '—';
  return `${rem} · reset ${reset}`;
}

function formatQuotaMarkdown(
  connection: string,
  source: string | null,
  error: string | null,
  groups: readonly QuotaGroup[],
  speed: SpeedMetrics | null,
  nowMs: number,
): string {
  const lines: string[] = [
    `## Quota & Active Session`,
    `- **Connection**: \`${connection}\`${source ? ` (${source})` : ''}`,
  ];
  if (error) lines.push(`- **Notice**: ${error}`);
  if (groups.length > 0) {
    lines.push('', '| Model Group | 5h Quota | Weekly Quota |', '| :--- | :--- | :--- |');
    for (const g of groups) {
      lines.push(`| ${g.name} | ${formatQuotaWindow(g.windows['5h'], nowMs)} | ${formatQuotaWindow(g.windows.weekly, nowMs)} |`);
    }
  } else {
    lines.push('- **Quotas**: No live quota groups available.');
  }
  if (speed) {
    const model = speed.activeModel || speed.model || speed.planModel || '—';
    const ctx = speed.context
      ? `${compact(speed.context.usedTokens)}${speed.context.maxTokens ? ` / ${compact(speed.context.maxTokens)} (${percent(speed.context.usedFraction)})` : ''}`
      : '—';
    lines.push(
      '',
      '### Active Session',
      `- **Conversation**: \`${speed.conversationId || '—'}\` (${speed.status || 'unknown'})`,
      `- **Model**: ${model}`,
      `- **Throughput**: avg ${rate(speed.tps)} tok/s · latest ${rate(speed.latestTps)} tok/s`,
      `- **Tokens**: total ${compact(speed.tokens?.totalTokens)} · cache hit ${percent(speed.cache?.hitRate)}`,
      `- **Context**: ${ctx}`,
    );
  }
  return lines.join('\n');
}

function okAction(summary: string, data: unknown): McpCallToolResult {
  return {
    content: [{ type: 'text', text: summary }],
    structuredContent: { ok: true, data },
  };
}

function errAction(error: unknown): McpCallToolResult {
  const msg = errorMessage(error) || 'Action failed';
  return {
    isError: true,
    content: [{ type: 'text', text: msg }],
    structuredContent: { ok: false, error: msg },
  };
}

export function createPulseMcpBackend(options: PulseMcpBackendOptions = {}): PulseMcpBackend {
  const nowFn = options.now ?? Date.now;
  const idleDisposeMs =
    options.idleDisposeMs === undefined
      ? DEFAULT_IDLE_DISPOSE_MS
      : options.idleDisposeMs === null
        ? 0
        : Number.isFinite(options.idleDisposeMs) && options.idleDisposeMs > 0
          ? options.idleDisposeMs
          : 0;
  const allDoublesInjected = Boolean(options.ledger && options.store && options.usage);

  let pathsCache: PlatformPaths | null = options.paths ?? null;
  let ledgerCache: UsageLedger | null = options.ledger ?? null;
  let prefsCache: PreferencesStore | null = options.preferences ?? null;
  let storeCache: MetricsStore | null = options.store ?? null;
  let usageCache: DesktopUsage | null = options.usage ?? null;
  let identityResolver: ((recent: readonly string[]) => Promise<string | null>) | null = null;
  let nativeBridgeMod: NativeBridgeModule | null = null;

  let disposed = false;
  let hasActivatedBackend = false;
  let inFlightCalls = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let teardownPromise: Promise<void> | null = null;

  const currentViewScope = (): string =>
    usageCache?.viewScope ?? options.usage?.viewScope ?? 'all';

  const usageStoreAdapter: DesktopUsageStore & {
    localFallbackActive?: boolean;
    rawSummaries?: Record<string, unknown> | null;
    setLocalIdentity?: (next: string | null) => boolean;
  } = {
    get identity() {
      return storeCache?.identity ?? null;
    },
    get epoch() {
      return storeCache?.epoch ?? 0;
    },
    get usagePersistenceError() {
      return storeCache?.usagePersistenceError === true;
    },
    get localFallbackActive() {
      return Boolean(storeCache?.localFallbackActive);
    },
    get rawSummaries() {
      return storeCache?.rawSummaries ?? null;
    },
    async listConversations(includeArchive?: boolean) {
      return storeCache ? storeCache.listConversations(includeArchive) : [];
    },
    setLocalIdentity(next: string | null) {
      return storeCache ? storeCache.setLocalIdentity(next) : false;
    },
  };

  const getPaths = async (): Promise<PlatformPaths> => {
    if (!pathsCache) {
      if (options.paths) {
        pathsCache = options.paths;
      } else {
        const { platformPaths } = await loadPathsModule();
        pathsCache = platformPaths();
      }
    }
    return pathsCache;
  };
  const getLedger = async (): Promise<UsageLedger> => {
    if (!ledgerCache) {
      if (options.ledger) {
        ledgerCache = options.ledger;
      } else {
        const [{ UsageLedger }, p] = await Promise.all([loadLedgerModule(), getPaths()]);
        ledgerCache = new UsageLedger(join(p.data, 'usage-v1'));
      }
    }
    return ledgerCache;
  };
  const getPrefs = async (): Promise<PreferencesStore> => {
    if (!prefsCache) {
      if (options.preferences) {
        prefsCache = options.preferences;
      } else {
        const [{ PreferencesStore }, p] = await Promise.all([loadPreferencesModule(), getPaths()]);
        const file =
          process.env.AG_PULSE_PREFERENCES_FILE ||
          join(dirname(p.settings), 'preferences.json');
        prefsCache = new PreferencesStore({ file });
      }
    }
    return prefsCache;
  };
  const getIdentityResolver = async () => {
    if (!identityResolver) {
      const [ledger, p] = await Promise.all([getLedger(), getPaths()]);
      identityResolver = createLocalIdentityResolver(ledger, p.profile, p.isIsolatedVertex);
    }
    return identityResolver;
  };
  const getStore = async (): Promise<MetricsStore> => {
    if (!storeCache) {
      if (options.store) {
        storeCache = options.store;
      } else {
        const [{ MetricsStore }, p, resolveLocalIdentity] = await Promise.all([
          loadStoreModule(),
          getPaths(),
          getIdentityResolver(),
        ]);
        storeCache = new MetricsStore(undefined, {
          dataDir: p.data,
          owns: () => true,
          resolveLocalIdentity,
        });
      }
    }
    return storeCache;
  };
  const getUsage = async (): Promise<DesktopUsage> => {
    if (!usageCache) {
      const injectedUsage = options.usage as (DesktopUsage & { disposed?: boolean }) | undefined;
      if (injectedUsage && !injectedUsage.disposed) {
        usageCache = injectedUsage;
      } else {
        const [{ DesktopUsage }, { defaultConversationsDir }, ledger, p] = await Promise.all([
          loadLedgerModule(),
          loadLocalConversationsModule(),
          getLedger(),
          getPaths(),
        ]);
        // owns: () => false guarantees zero background sync loops or continuation timers.
        usageCache = new DesktopUsage(usageStoreAdapter, ledger, {
          host: 'app',
          conversationsDir: defaultConversationsDir('app', p.home),
          owns: () => false,
          now: nowFn,
        });
      }
    }
    return usageCache;
  };
  const getProfileDir = async (): Promise<string> => {
    if (options.profileDir !== undefined) return options.profileDir;
    const [{ defaultConversationsDir }, p] = await Promise.all([
      loadLocalConversationsModule(),
      getPaths(),
    ]);
    return dirname(defaultConversationsDir('app', p.home));
  };
  const getTheme = async (): Promise<HostThemeConfig> => {
    if (options.readTheme) return options.readTheme();
    const [{ readHostTheme }, p] = await Promise.all([loadThemeModule(), getPaths()]);
    return readHostTheme({ file: p.pluginConfig });
  };

  const buildUsageSnapshot = async (force = false): Promise<UsageSummarySnapshot | null> => {
    const [ledger, usage] = await Promise.all([getLedger(), getUsage()]);
    const store = storeCache;
    if (force) ledger.cache = null;
    const scope = usage.viewScope || 'all';
    const [raw, accountsRaw, activeLocal] = await Promise.all([
      ledger.summary(scope, nowFn()),
      ledger.getAccounts(scope),
      ledger.getActiveLocalAccount().catch(() => null),
    ]);
    if (!raw) return null;
    const accounts = toPlainAccounts(accountsRaw);
    const storeIdentity = store?.identity || null;
    const recordingAccount = storeIdentity || activeLocal || null;
    const firstReal = accounts.find((a) => a.id !== 'all')?.id;
    const activeAccount =
      storeIdentity || activeLocal || (scope !== 'all' ? scope : firstReal) || scope;
    return {
      ...raw,
      viewScope: scope,
      activeAccount,
      recordingAccount,
      localAccountMode: Boolean(store?.localFallbackActive),
      accounts,
      syncing: false,
      status: 'ready',
      missingConversations: 0,
      confirmedMissingConversations: 0,
      retryingConversations: 0,
      persistenceError: store?.usagePersistenceError === true,
    };
  };

  const buildFullSnapshot = async (force = false): Promise<{
    usage: UsageSummarySnapshot | null;
    preferences: PreferencesSnapshot;
    theme: HostThemeConfig;
  }> => {
    const prefs = await getPrefs();
    const [usageSnap, preferences, theme] = await Promise.all([
      buildUsageSnapshot(force),
      prefs.snapshot(),
      getTheme(),
    ]);
    return { usage: usageSnap, preferences, theme };
  };

  const resolveScopeForWrite = async (rawScope: unknown): Promise<string> => {
    if (typeof rawScope === 'string' && rawScope.trim() && rawScope !== 'all') {
      return rawScope.trim();
    }
    const store = storeCache;
    if (store?.identity && SCOPE_HASH.test(store.identity)) return store.identity;
    const resolveLocalIdentity = await getIdentityResolver();
    const resolved = await resolveLocalIdentity([]);
    if (resolved && SCOPE_HASH.test(resolved)) return resolved;
    throw new Error('Invalid usage scope');
  };

  const handleOpenDashboard = async (args: Record<string, unknown>): Promise<McpCallToolResult> => {
    if (typeof args.scope === 'string' && args.scope.trim()) {
      const usage = await getUsage();
      await usage.switchAccount(args.scope.trim());
    }
    const initial = await buildFullSnapshot(args.force === true);
    const u = initial.usage;
    const summaryText = u
      ? `Token Usage Dashboard ready (scope: ${u.viewScope}, total: ${compact(u.totalTokens)} tokens across ${count(u.requests)} requests; today: ${compact(u.todayTokens)}, week: ${compact(u.weekTokens)}, month: ${compact(u.monthTokens)}).`
      : 'Token Usage Dashboard ready (no recorded usage yet).';
    const initialBytes = Buffer.byteLength(JSON.stringify(initial), 'utf8');
    if (initialBytes > INITIAL_PAYLOAD_MAX_BYTES) {
      return {
        content: [{ type: 'text', text: summaryText }],
        structuredContent: { ok: true, deferred: true },
      };
    }
    return {
      content: [{ type: 'text', text: summaryText }],
      structuredContent: { ok: true, initial, deferred: false },
    };
  };

  const handleQueryStats = async (args: Record<string, unknown>): Promise<McpCallToolResult> => {
    const periodRaw = typeof args.period === 'string' ? args.period : 'month';
    if (periodRaw !== 'today' && periodRaw !== 'week' && periodRaw !== 'month' && periodRaw !== 'custom') {
      throw new Error(`Invalid period: ${periodRaw}`);
    }
    const dimRaw = typeof args.dimension === 'string' ? args.dimension : 'model';
    if (dimRaw !== 'model' && dimRaw !== 'user' && dimRaw !== 'project') {
      throw new Error(`Invalid dimension: ${dimRaw}`);
    }
    const scope = typeof args.scope === 'string' && args.scope.trim() ? args.scope.trim() : currentViewScope();
    if (scope !== 'all' && !SCOPE_HASH.test(scope)) throw new Error('Invalid account scope');

    const [ledger, ledgerMod] = await Promise.all([getLedger(), loadLedgerModule()]);
    const summary = await ledger.summary(scope, nowFn());
    const today = summary?.today || ledgerMod.dateKey(nowFn(), ledger.timeZone);
    const { from, to } = resolveDateRange(
      today,
      periodRaw,
      ledgerMod.weekStart,
      typeof args.from === 'string' ? args.from : undefined,
      typeof args.to === 'string' ? args.to : undefined,
    );

    if (dimRaw === 'project') {
      const overview = await ledgerMod.queryProjectUsageOverview({
        ledger,
        store: storeCache ?? undefined,
        profileDir: await getProfileDir(),
        scope,
        from,
        to,
      });
      const totals = emptyBucket();
      for (const p of overview.projects) addBucket(totals, p);
      const breakdown = overview.projects.map((p) => ({
        key: p.projectKey,
        label: p.name,
        kind: p.kind,
        conversationCount: p.conversationCount,
        uncached: p.uncached,
        cacheRead: p.cacheRead,
        cacheWrite: p.cacheWrite,
        output: p.output,
        total: p.total,
        requests: p.requests,
        share: totals.total > 0 ? p.total / totals.total : 0,
      }));
      const lines = [
        `## Token Usage by Project (${from} .. ${to})`,
        `- **Scope**: \`${scope}\` · **Total**: ${compact(totals.total)} (${count(totals.total)}) · **Requests**: ${count(totals.requests)}`,
      ];
      if (breakdown.length > 0) {
        lines.push('', '| Project | Kind | Sessions | Total | Share | Requests |', '| :--- | :--- | ---: | ---: | ---: | ---: |');
        for (const r of breakdown.slice(0, 20)) {
          lines.push(`| ${r.label} | ${r.kind} | ${r.conversationCount} | ${compact(r.total)} | ${percent(r.share)} | ${count(r.requests)} |`);
        }
      } else {
        lines.push('', '_No usage recorded in this range._');
      }
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: {
          ok: true,
          period: periodRaw,
          from,
          to,
          dimension: dimRaw,
          scope,
          totals,
          breakdown,
          updatedAt: overview.updatedAt,
        },
      };
    }

    const totals = emptyBucket();
    const map = new Map<string, UsageBucketCounts & { label: string }>();
    for (const day of summary?.days || []) {
      if (day.date < from || day.date > to) continue;
      const sourceBuckets = dimRaw === 'model' ? day.models : day.users;
      for (const [key, bucket] of Object.entries(sourceBuckets || {})) {
        addBucket(totals, bucket);
        let acc = map.get(key);
        if (!acc) {
          const label =
            dimRaw === 'user'
              ? summary?.userMeta?.[key]?.email || summary?.userMeta?.[key]?.name || ('name' in bucket ? String(bucket.name) : key)
              : key;
          acc = { ...emptyBucket(), label };
          map.set(key, acc);
        }
        addBucket(acc, bucket);
      }
    }
    const breakdown = [...map.entries()]
      .map(([key, b]) => ({
        key,
        label: b.label,
        uncached: b.uncached,
        cacheRead: b.cacheRead,
        cacheWrite: b.cacheWrite,
        output: b.output,
        total: b.total,
        requests: b.requests,
        share: totals.total > 0 ? b.total / totals.total : 0,
      }))
      .sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));
    const inputTotal = totals.uncached + totals.cacheRead + totals.cacheWrite;
    const cacheHitRate = inputTotal > 0 ? totals.cacheRead / inputTotal : null;
    const heading = dimRaw === 'model' ? 'Model' : 'User';
    const lines = [
      `## Token Usage by ${heading} (${from} .. ${to})`,
      `- **Scope**: \`${scope}\` · **Total**: ${compact(totals.total)} (${count(totals.total)}) · **Requests**: ${count(totals.requests)} · **Cache Hit**: ${percent(cacheHitRate)}`,
    ];
    if (breakdown.length > 0) {
      lines.push('', `| ${heading} | Total | Uncached | Cache Read | Output | Requests | Share |`, '| :--- | ---: | ---: | ---: | ---: | ---: | ---: |');
      for (const r of breakdown.slice(0, 20)) {
        lines.push(`| ${r.label} | ${compact(r.total)} | ${compact(r.uncached)} | ${compact(r.cacheRead)} | ${compact(r.output)} | ${count(r.requests)} | ${percent(r.share)} |`);
      }
    } else {
      lines.push('', '_No usage recorded in this range._');
    }
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: {
        ok: true,
        period: periodRaw,
        from,
        to,
        dimension: dimRaw,
        scope,
        totals: { ...totals, cacheHitRate },
        breakdown,
        summaryTotals: summary
          ? {
              todayTokens: summary.todayTokens,
              weekTokens: summary.weekTokens,
              monthTokens: summary.monthTokens,
              totalTokens: summary.totalTokens,
              requests: summary.requests,
            }
          : null,
        updatedAt: summary?.updatedAt || new Date(nowFn()).toISOString(),
      },
    };
  };

  const handleQuotaAndSession = async (args: Record<string, unknown>): Promise<McpCallToolResult> => {
    const conversationId = typeof args.conversationId === 'string' && args.conversationId.trim() ? args.conversationId.trim() : null;
    const force = args.force === true;
    const store = await getStore();
    const snap = await store.snapshot({ conversationId, force });
    const markdown = formatQuotaMarkdown(
      snap.connection,
      snap.source ?? null,
      snap.error ?? null,
      snap.groups,
      snap.speed,
      nowFn(),
    );
    return {
      content: [{ type: 'text', text: markdown }],
      structuredContent: {
        connection: snap.connection,
        source: snap.source ?? null,
        error: snap.error ?? null,
        sessionError: snap.sessionError ?? null,
        quotaUpdatedAt: snap.quotaUpdatedAt ?? null,
        serverTime: snap.serverTime,
        groups: snap.groups,
        speed: snap.speed,
      },
    };
  };

  const handleUsageAction = async (args: Record<string, unknown>): Promise<McpCallToolResult> => {
    const action = typeof args.action === 'string' ? args.action.trim() : '';
    const payload = isRecord(args.payload) ? args.payload : {};
    try {
      switch (action as UsageActionName) {
        case 'get_snapshot': {
          const data = await buildFullSnapshot(payload.force === true);
          return okAction('Loaded usage snapshot.', data);
        }
        case 'get_accounts': {
          const usage = await getUsage();
          const res = await usage.getAccounts();
          const data = {
            active: res.active ?? usage.viewScope ?? 'all',
            activeAccount: res.activeAccount ?? res.active ?? 'all',
            accounts: toPlainAccounts(res),
          };
          return okAction(`Loaded ${data.accounts.length} accounts.`, data);
        }
        case 'switch_account': {
          const usage = await getUsage();
          const data = await usage.switchAccount(payload as SwitchAccountRequest);
          return okAction(`Switched view scope to ${data.active}.`, data);
        }
        case 'get_recording_account': {
          const usage = await getUsage();
          const state = await usage.getRecordingAccountState();
          return okAction('Loaded recording account state.', {
            ...state,
            accounts: toPlainAccounts(state.accounts),
          });
        }
        case 'set_recording_account': {
          const usage = await getUsage();
          const state = await usage.setRecordingAccount(payload as SetRecordingAccountRequest);
          return okAction('Updated recording account.', {
            ...state,
            accounts: toPlainAccounts(state.accounts),
          });
        }
        case 'add_account': {
          const usage = await getUsage();
          const res = await usage.addLocalAccount(payload as AddAccountRequest);
          return okAction(`Added account ${res.account.name}.`, {
            ...res,
            accounts: toPlainAccounts(res.accounts),
          });
        }
        case 'reassign_conversation': {
          const usage = await getUsage();
          const res = await usage.reassignConversation(payload as unknown as ReassignConversationRequest);
          return okAction(`Reassigned ${res.reassigned} conversation(s).`, res);
        }
        case 'add_manual_usage': {
          const req = payload as AddManualUsageRequest;
          const scope = await resolveScopeForWrite(req.scope);
          const usage = await getUsage();
          const entry = await usage.addManualUsage(scope, (req.data || req) as ManualUsageInput);
          return okAction(`Recorded manual usage entry ${entry.id}.`, entry);
        }
        case 'delete_manual_usage': {
          const req = payload as unknown as DeleteManualUsageRequest;
          const id = typeof req === 'string' ? req : typeof req?.id === 'string' ? req.id : '';
          const rawScope = typeof req === 'object' && req !== null ? req.scope : '';
          const usage = await getUsage();
          let deleted = false;
          if (typeof rawScope === 'string' && SCOPE_HASH.test(rawScope)) {
            deleted = await usage.deleteManualUsage(rawScope, id);
          } else if (!rawScope || rawScope === 'all') {
            const ledger = await getLedger();
            const dirs = await ledger.scopeDirectories();
            for (const dir of dirs) {
              if (await usage.deleteManualUsage(dir, id)) {
                deleted = true;
                break;
              }
            }
          } else {
            deleted = await usage.deleteManualUsage(rawScope, id);
          }
          return okAction(deleted ? `Deleted manual usage entry ${id}.` : `Manual usage entry ${id} not found.`, deleted);
        }
        case 'get_project_overview': {
          const [ledgerMod, ledger, profileDir] = await Promise.all([
            loadLedgerModule(),
            getLedger(),
            getProfileDir(),
          ]);
          const data = await ledgerMod.queryProjectUsageOverview({
            ledger,
            store: storeCache ?? undefined,
            profileDir,
            scope: typeof payload.scope === 'string' ? payload.scope : currentViewScope(),
            from: typeof payload.from === 'string' ? payload.from : undefined,
            to: typeof payload.to === 'string' ? payload.to : undefined,
            timeZone: typeof payload.timeZone === 'string' ? payload.timeZone : undefined,
          });
          return okAction(`Loaded ${data.projects.length} project(s).`, data);
        }
        case 'get_project_detail': {
          const projectKey = typeof payload.projectKey === 'string' ? payload.projectKey.trim() : '';
          if (!projectKey) throw new Error('projectKey is required');
          const [ledgerMod, ledger, profileDir] = await Promise.all([
            loadLedgerModule(),
            getLedger(),
            getProfileDir(),
          ]);
          const data = await ledgerMod.queryProjectConversationDetail({
            ledger,
            store: storeCache ?? undefined,
            profileDir,
            projectKey,
            scope: typeof payload.scope === 'string' ? payload.scope : currentViewScope(),
            from: typeof payload.from === 'string' ? payload.from : undefined,
            to: typeof payload.to === 'string' ? payload.to : undefined,
            timeZone: typeof payload.timeZone === 'string' ? payload.timeZone : undefined,
          });
          return okAction(`Loaded ${data.conversations.length} conversation(s) for ${data.projectName}.`, data);
        }
        case 'get_preferences': {
          const prefs = await getPrefs();
          const data = await prefs.snapshot();
          return okAction('Loaded preferences.', data);
        }
        case 'set_preferences': {
          const prefs = await getPrefs();
          const saved = await prefs.set(payload as PreferencesUpdateInput);
          storeCache?.setModelTimelineEnabled(saved.modelTimelineEnabled === true);
          return okAction('Saved preferences.', saved);
        }
        default:
          throw new Error(`Unknown pulse_usage_action: ${action || '(empty)'}`);
      }
    } catch (error) {
      return errAction(error);
    }
  };

  const clearIdleTimer = (): void => {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  const disposeInMemoryCaches = (): void => {
    try {
      usageCache?.dispose?.();
    } catch {}
    usageCache = null;

    try {
      storeCache?.dispose?.();
    } catch {}
    storeCache = null;

    if (ledgerCache) {
      try {
        ledgerCache.cache = null;
        ledgerCache.fileIndex?.clear?.();
        ledgerCache.metaCache = null;
        ledgerCache.ownershipCache = null;
        ledgerCache.dirtyRelPaths?.clear?.();
        ledgerCache.projectDirtyRelPaths?.clear?.();
        ledgerCache.keyVersions?.clear?.();
      } catch {}
    }
    ledgerCache = null;
    prefsCache = null;
    pathsCache = null;
    identityResolver = null;
  };

  const releaseNativeCachesSafe = async (): Promise<void> => {
    try {
      const mod = nativeBridgeMod ?? (await loadNativeBridgeModule());
      nativeBridgeMod = mod;
      (mod as { releaseNativeCaches?: (mode: 'soft' | 'full') => unknown }).releaseNativeCaches?.('full');
    } catch {
      // Native addon may be disabled or unavailable.
    }
  };

  const runIdleTeardown = (): Promise<void> => {
    if (teardownPromise) return teardownPromise;
    disposeInMemoryCaches();
    if (nativeBridgeMod || !allDoublesInjected) {
      teardownPromise = releaseNativeCachesSafe().finally(() => {
        teardownPromise = null;
      });
      return teardownPromise;
    }
    return Promise.resolve();
  };

  const scheduleIdleTeardown = (): void => {
    clearIdleTimer();
    if (disposed || idleDisposeMs <= 0 || inFlightCalls > 0) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (disposed || inFlightCalls > 0) return;
      void runIdleTeardown();
    }, idleDisposeMs);
    (idleTimer as unknown as { unref?: () => void }).unref?.();
  };

  return {
    async callTool(name: string, args: Record<string, unknown>): Promise<McpCallToolResult> {
      if (disposed) {
        return errAction(new Error('MCP backend is disposed'));
      }
      hasActivatedBackend = true;
      inFlightCalls += 1;
      clearIdleTimer();
      if (!nativeBridgeMod && !allDoublesInjected) {
        void loadNativeBridgeModule()
          .then((mod) => {
            nativeBridgeMod = mod;
          })
          .catch(() => {});
      }
      if (teardownPromise) {
        await teardownPromise;
      }
      try {
        if (name === 'open_usage_dashboard') return await handleOpenDashboard(args);
        if (name === 'query_usage_stats') return await handleQueryStats(args);
        if (name === 'get_quota_and_session') return await handleQuotaAndSession(args);
        if (name === 'pulse_usage_action') return await handleUsageAction(args);
        return errAction(new Error(`Unknown tool: ${name}`));
      } catch (error) {
        return errAction(error);
      } finally {
        inFlightCalls = Math.max(0, inFlightCalls - 1);
        if (!disposed && inFlightCalls === 0) {
          scheduleIdleTeardown();
        }
      }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      clearIdleTimer();
      disposeInMemoryCaches();
      if (nativeBridgeMod) {
        try {
          (nativeBridgeMod as { releaseNativeCaches?: (mode: 'soft' | 'full') => unknown }).releaseNativeCaches?.('full');
        } catch {}
      } else if (hasActivatedBackend && !allDoublesInjected) {
        void releaseNativeCachesSafe();
      }
    },
  };
}
