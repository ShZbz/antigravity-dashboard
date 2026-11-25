import type { App } from '@modelcontextprotocol/ext-apps';
import type {
  AccountsResponse,
  AddAccountRequest,
  AddAccountResponse,
  AddManualUsageRequest,
  DeleteManualUsageRequest,
  HostThemeConfig,
  ManualUsageRecord,
  ManualUsageScopeInput,
  MetricsSnapshot,
  PreferencesSnapshot,
  PreferencesUpdateInput,
  ProjectConversationDetail,
  ProjectDetailRequest,
  ProjectUsageOverview,
  ProjectUsageRequest,
  ReassignConversationRequest,
  ReassignConversationResponse,
  RecordingAccountState,
  RuntimeBridgeApi,
  SetRecordingAccountRequest,
  SwitchAccountRequest,
  SwitchAccountResponse,
  UsageAccountInfo,
  UsageSummarySnapshot,
} from '../../contracts/index.ts';

export type McpUsageActionName =
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

export interface McpInitialSnapshot {
  usage?: UsageSummarySnapshot | null;
  preferences?: PreferencesSnapshot | null;
  theme?: HostThemeConfig | null;
}

export interface McpOpenDashboardResult {
  ok?: boolean;
  initial?: McpInitialSnapshot;
  deferred?: boolean;
  error?: string;
}

export interface McpUsageActionBridge extends RuntimeBridgeApi {
  getSnapshot(input?: { force?: boolean }): Promise<McpInitialSnapshot>;
}

interface ActionEnvelope<T = unknown> {
  ok?: boolean;
  data?: T;
  error?: string;
}

const MAX_IN_FLIGHT_CALLS = 3;

function createConcurrencyQueue(maxInFlight = MAX_IN_FLIGHT_CALLS) {
  let active = 0;
  const waiting: Array<() => void> = [];

  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active >= maxInFlight || waiting.length > 0) {
      await new Promise<void>((resolve) => {
        waiting.push(resolve);
        if (active < maxInFlight && waiting[0] === resolve) {
          waiting.shift();
          resolve();
        }
      });
      while (active >= maxInFlight) {
        await new Promise<void>((resolve) => {
          waiting.unshift(resolve);
        });
      }
    }
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      const next = waiting.shift();
      if (next) next();
    }
  };
}

function readFirstTextBlock(content: unknown): string {
  if (!Array.isArray(content)) return '';
  for (const block of content) {
    if (
      block &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      return (block as { text: string }).text;
    }
  }
  return '';
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Unwraps an MCP `CallToolResult` returned by `open_usage_dashboard` or `pulse_usage_action`.
 */
export function unwrapMcpToolPayload(result: {
  isError?: boolean;
  structuredContent?: unknown;
  content?: unknown;
}): Record<string, unknown> | null {
  const textFallback = readFirstTextBlock(result.content);
  const structured =
    result.structuredContent && typeof result.structuredContent === 'object'
      ? (result.structuredContent as Record<string, unknown>)
      : parseJsonObject(textFallback);

  if (result.isError) {
    const errMsg =
      (structured && typeof structured.error === 'string' && structured.error) ||
      textFallback ||
      'MCP tool call failed';
    throw new Error(errMsg);
  }
  return structured;
}

function unwrapActionEnvelope<T>(result: {
  isError?: boolean;
  structuredContent?: unknown;
  content?: unknown;
}): T {
  const textFallback = readFirstTextBlock(result.content);
  const envelope = unwrapMcpToolPayload(result) as ActionEnvelope<T> | null;
  if (envelope && typeof envelope === 'object' && 'ok' in envelope) {
    if (envelope.ok === false) {
      throw new Error(
        typeof envelope.error === 'string' && envelope.error ? envelope.error : textFallback || 'Action failed',
      );
    }
    if (envelope.ok === true) {
      return envelope.data as T;
    }
  }
  return envelope as unknown as T;
}

function toPayloadRecord(payload: unknown): Record<string, unknown> | undefined {
  if (payload === undefined || payload === null) return undefined;
  if (typeof payload === 'object' && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }
  return undefined;
}

/**
 * Creates a `RuntimeBridgeApi` backed by `app.callServerTool('pulse_usage_action', ...)`
 * with a FIFO concurrency cap of 3 in-flight calls (below Antigravity's 4-call cap).
 */
export function createMcpUsageBridge(app: App): McpUsageActionBridge {
  const enqueue = createConcurrencyQueue(MAX_IN_FLIGHT_CALLS);

  const callAction = async <T>(action: McpUsageActionName, payload?: unknown): Promise<T> => {
    return await enqueue(async () => {
      const normalized = toPayloadRecord(payload);
      const result = await app.callServerTool({
        name: 'pulse_usage_action',
        arguments: normalized ? { action, payload: normalized } : { action },
      });
      return unwrapActionEnvelope<T>(result);
    });
  };

  return {
    getSnapshot: (input) => callAction<McpInitialSnapshot>('get_snapshot', input),
    getMetrics: async (input) => {
      const snap = await callAction<McpInitialSnapshot>('get_snapshot', { force: Boolean(input?.force) });
      return {
        connection: 'live',
        usage: snap.usage ?? null,
        preferences: snap.preferences ?? undefined,
        theme: snap.theme ?? undefined,
        groups: [],
        speed: null,
      } as unknown as MetricsSnapshot;
    },
    updatePlugin: () => Promise.reject(new Error('updatePlugin is not available in MCP usage view')),
    clearTimeline: () => Promise.reject(new Error('clearTimeline is not available in MCP usage view')),
    report: () => {},
    getPreferences: () => callAction<PreferencesSnapshot>('get_preferences'),
    setPreferences: (input: PreferencesUpdateInput) =>
      callAction<PreferencesSnapshot>('set_preferences', input),
    getAccounts: (input?: ManualUsageScopeInput) =>
      callAction<UsageAccountInfo[] | AccountsResponse>('get_accounts', input),
    switchAccount: (input: SwitchAccountRequest) =>
      callAction<SwitchAccountResponse>(
        'switch_account',
        typeof input === 'string' ? { account: input } : input,
      ),
    getRecordingAccount: () => callAction<RecordingAccountState>('get_recording_account'),
    setRecordingAccount: (input: SetRecordingAccountRequest) =>
      callAction<RecordingAccountState>('set_recording_account', input),
    addAccount: (input: AddAccountRequest) => callAction<AddAccountResponse>('add_account', input),
    reassignConversation: (input: ReassignConversationRequest) =>
      callAction<ReassignConversationResponse>('reassign_conversation', input),
    addManualUsage: (input: AddManualUsageRequest) =>
      callAction<ManualUsageRecord | { error: string }>('add_manual_usage', input),
    deleteManualUsage: (input: DeleteManualUsageRequest) =>
      callAction<boolean | { error: string }>(
        'delete_manual_usage',
        typeof input === 'string' ? { id: input } : input,
      ),
    getProjectUsage: (input?: ProjectUsageRequest) =>
      callAction<ProjectUsageOverview | { error: string }>('get_project_overview', input),
    getProjectDetail: (input: ProjectDetailRequest) =>
      callAction<ProjectConversationDetail | { error: string }>('get_project_detail', input),
  };
}
