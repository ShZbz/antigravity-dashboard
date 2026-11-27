import type { HostThemeConfig } from './ipc.ts';
import type { PreferencesSnapshot } from './preferences.ts';
import type { ModelTimelineSnapshot } from './timeline.ts';
import type { UsageSummarySnapshot } from './usage.ts';

/**
 * Live connection state between the dashboard UI and local Antigravity server.
 */
export type ConnectionStatus = 'live' | 'stale' | 'offline';

/**
 * Reasons a request's token-rate sample may be flagged as unmeasurable or suspect.
 */
export type RateReason =
  | 'token-scope'
  | 'duplicate-scope'
  | 'retry-scope'
  | 'short-tool-window'
  | 'short-outlier'
  | 'nonfinite-rate';

/**
 * Rate classification status for the latest or per-subagent sample.
 */
export type LatestRateStatus = 'ok' | 'missing' | 'unreliable' | 'legacy';

/**
 * Raw cumulative token counters aggregated across generator metadata.
 */
export interface TokenCounts {
  input: number;
  output: number;
  responseOutput: number;
  thinkingOutput: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Cache hit-rate and provider-validated token breakdown.
 */
export interface CacheMetrics {
  inputTokens: number | null;
  cachedTokens: number | null;
  cacheWriteTokens: number | null;
  uncachedTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  measuredRequests: number | null;
  missingRequests: number | null;
  hitRate: number | null;
  complete: boolean;
}

/**
 * Request-level token coverage and totals for a conversation or task.
 */
export interface TokenSummary {
  inputTokens: number | null;
  cachedTokens: number | null;
  cacheWriteTokens: number | null;
  uncachedTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  measuredRequests: number | null;
  inputRequests: number | null;
  outputRequests: number | null;
  missingInputRequests: number | null;
  missingOutputRequests: number | null;
  uncachedRequests: number | null;
  cachedRequests: number | null;
  cacheWriteRequests: number | null;
  outputAvailable?: boolean;
  coverageUnknown?: boolean;
  complete: boolean;
}

/**
 * Host-reported context window occupancy and provider reference metadata.
 */
export interface ContextMetrics {
  usedTokens: number;
  maxTokens: number | null;
  remainingTokens: number | null;
  usedFraction: number | null;
  remainingFraction: number | null;
  capacitySource: 'host-reported' | null;
  providerMaxTokens: number | null;
  providerCapacityLabel: string | null;
  providerCapacitySource: string | null;
  providerCapacityKind: string | null;
  providerCapacityCheckedAt: string | null;
  compressionLimit: number | null;
  compressionFraction: number | null;
  compressionSource: string | null;
  model: string | null;
  sampledAt: string | null;
  source: string;
  estimated: boolean;
}

/**
 * Role assigned to a model bucket inside a conversation or task.
 */
export type ModelRole = 'plan' | 'worker' | 'subagent' | 'model';

/**
 * Per-model token and request totals.
 */
export interface ModelUsageBucket {
  id: string;
  name: string;
  role: ModelRole;
  requests: number;
  inputTokens: number;
  uncachedTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  totalTokens: number;
}

/**
 * Multi-model breakdown for a session or delegated task.
 */
export interface ModelUsageSummary {
  planModel: string | null;
  activeModel: string | null;
  totalTokens: number;
  outputTokens: number;
  totalRequests: number;
  models: ModelUsageBucket[];
}

export type TranscriptStatus = 'loading' | 'ready' | 'partial' | 'unavailable';

export type TranscriptReason =
  | 'reading'
  | 'missing'
  | 'unsafe-path'
  | 'invalid-boundary'
  | 'row-limit'
  | 'invalid-record'
  | 'unmatched-record'
  | 'incomplete-line'
  | 'io-error';

/**
 * Numeric summary estimated from local transcript JSONL logs.
 */
export interface TranscriptStats {
  version: 1;
  status: TranscriptStatus;
  reason: TranscriptReason | null;
  source: 'local-recorded-text';
  estimated: boolean;
  complete: boolean;
  userTokens: number;
  assistantTokens: number;
  toolTokens: number;
  systemTokens: number;
  matchedSteps: number;
  compactionMarkers: number;
  imageSteps: number;
  totalTokens: number;
}

/**
 * Compact context occupancy summary attached to a delegated subagent item.
 */
export interface SubagentContextSummary {
  usedTokens: number;
  maxTokens: number | null;
  usedFraction: number | null;
}

/**
 * Delegated child conversation summary inside `TaskUsageSummary`.
 */
export interface SubagentItem {
  id: string;
  role: string | null;
  parentId: string | null;
  depth: number;
  model: string | null;
  tps: number | null;
  latestTps: number | null;
  latestRateStatus: LatestRateStatus;
  totalTokens: number | null;
  context: SubagentContextSummary | null;
  status: string | null;
  steps: number;
}

export type TaskUsageState = 'ready' | 'partial' | 'loading';

/**
 * Root + delegated subagent token and cache rollup for a task.
 */
export interface TaskUsageSummary {
  tokens: TokenSummary;
  cache: CacheMetrics;
  ownTokens: number | null;
  subagentTokens: number | null;
  subagents: number;
  loadedSubagents: number;
  state: TaskUsageState;
  complete: boolean;
  items?: SubagentItem[];
  modelUsage?: ModelUsageSummary;
  truncated?: boolean;
  error?: string | null;
}

/**
 * Per-conversation speed, token, context, task, and timeline metrics.
 */
export interface SpeedMetrics {
  source: string;
  status: string | null;
  conversationId: string | null;
  planModel: string | null;
  activeModel: string | null;
  modelUsage?: ModelUsageSummary;
  steps: number | null;
  rounds: number | null;
  requests: number | null;
  measuredRequests: number | null;
  missingTiming: number | null;
  excludedTiming: number | null;
  rateWarnings: number | null;
  timingReasons: Record<RateReason, number>;
  rateVersion: number;
  counts: TokenCounts;
  tokens: TokenSummary;
  cache: CacheMetrics;
  tps: number | null;
  latestTps: number | null;
  latestRateStatus: LatestRateStatus;
  rateBasis: 'response' | 'all-output';
  streamingSeconds: number | null;
  modelSeconds: number | null;
  toolSeconds: number | null;
  ttftSeconds: number | null;
  latestShortSample: boolean;
  model: string | null;
  context: ContextMetrics | null;
  complete: boolean;
  transcriptStats?: TranscriptStats | null;
  taskUsage?: TaskUsageSummary | null;
  delegatedConversations?: string[] | null;
  modelTimeline?: ModelTimelineSnapshot | null;
  contextRestored?: boolean;
  transcriptRestoredFromHistory?: boolean;
  restoredFromHistory?: boolean;
  speedRestoredFromHistory?: boolean;
  cacheRestoredFromHistory?: boolean;
  speedSavedAt?: string | null;
  cacheSavedAt?: string | null;
  savedAt?: string | null;
}

export interface QuotaWindowUnavailable {
  available: false;
  reason: string;
}

export interface QuotaWindowAvailable {
  available: true;
  id: string;
  remaining: number | null;
  amount: number | null;
  resetAt: string | null;
  expired: boolean;
  disabled: boolean;
  description: string;
}

/**
 * Quota status for a single `5h` or `weekly` window.
 */
export type QuotaWindow = QuotaWindowAvailable | QuotaWindowUnavailable;

/**
 * Model quota group returned by `quotaMetrics`.
 */
export interface QuotaGroup {
  id: string;
  name: string;
  description: string;
  windows: {
    '5h'?: QuotaWindow;
    weekly?: QuotaWindow;
    [window: string]: QuotaWindow | undefined;
  };
}

export type IntegrationHealthState =
  | 'waiting'
  | 'waiting-for-composer'
  | 'mounted'
  | 'disabled'
  | 'reconnecting';

/**
 * Runtime CDP/IDE injection status reported by `RuntimeUi`.
 */
export interface IntegrationHealth {
  state: IntegrationHealthState;
  mode: 'runtime';
  message: string;
  windows: number;
  checkedAt?: string;
  hostVersion?: string | null;
  activePortPresent?: boolean;
  debugLaunchEnabled?: boolean;
  debugLaunchConfigured?: boolean;
}

/**
 * Lightweight conversation entry returned in `MetricsSnapshot.conversations`.
 */
export interface ConversationSummary {
  id: string;
  title: string;
  modifiedAt: string;
  status: string;
  stepCount: number;
  lastUserInputStepIndex?: number;
}

/**
 * Lightweight today/month token totals attached to compact polling snapshots.
 */
export interface UsageTotalsSnapshot {
  todayTokens: number;
  monthTokens: number;
}

/**
 * Top-level payload served by `/api/metrics`, `ag-pulse:metrics`, and `RuntimeUi`.
 */
export interface MetricsSnapshot {
  connection: ConnectionStatus;
  error: string | null;
  sessionError?: string | null;
  serverTime: string;
  quotaUpdatedAt?: string | null;
  groups: QuotaGroup[];
  speed: SpeedMetrics | null;
  conversations?: ConversationSummary[];
  persistenceError?: string | null;
  source?: string;
  enabled?: boolean;
  usage?: UsageSummarySnapshot | null;
  usageTotals?: UsageTotalsSnapshot | null;
  preferences?: PreferencesSnapshot;
  theme?: HostThemeConfig;
  integration?: IntegrationHealth;
}
