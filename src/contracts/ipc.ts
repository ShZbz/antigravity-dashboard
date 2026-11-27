import type { MetricsSnapshot } from './metrics.ts';
import type { PreferencesSnapshot, PreferencesUpdateInput } from './preferences.ts';
import type { ClearTimelineResult } from './timeline.ts';
import type {
  ManualUsageInput,
  ManualUsageRecord,
  ProjectConversationDetail,
  ProjectUsageOverview,
  UsageAccountInfo,
} from './usage.ts';

/**
 * Host application theme preference mode.
 */
export type HostThemeMode = 'dark' | 'light' | 'system';

/**
 * Sanitized hex color seeds read from host customization settings.
 */
export interface HostThemeSeed {
  primary?: string;
  background?: string;
  foregroundOverride?: string;
}

/**
 * Normalized host theme payload forwarded to the renderer.
 */
export interface HostThemeConfig {
  mode?: HostThemeMode;
  dark?: HostThemeSeed;
  light?: HostThemeSeed;
}

/**
 * Request types handled by the CDP `RuntimeUi` renderer binding.
 */
export type BridgeCallType =
  | 'metrics'
  | 'update'
  | 'preferences'
  | 'clearTimeline'
  | 'diagnostic'
  | 'addManualUsage'
  | 'deleteManualUsage'
  | 'getAccounts'
  | 'switchAccount'
  | 'getRecordingAccount'
  | 'setRecordingAccount'
  | 'addAccount'
  | 'reassignConversation'
  | 'getProjectUsage'
  | 'getProjectDetail';

/**
 * Input payload for `getMetrics` / `ag-pulse:metrics`.
 */
export interface MetricsRequestInput {
  conversationId?: string | null;
  force?: boolean;
  includeUsage?: boolean;
}

export type DiagnosticStage = 'boot' | 'mounted' | 'mount-error';

/**
 * Input payload for `report` / `ag-pulse:diagnostic`.
 */
export interface DiagnosticReportInput {
  stage: DiagnosticStage;
  hostFound?: boolean;
  editorFound?: boolean;
  composerFound?: boolean;
}

/**
 * Scope selector fields accepted by manual usage and account IPC endpoints.
 */
export interface ManualUsageScopeInput {
  scope?: string;
  account?: string;
  accountKey?: string;
  active?: string | null;
}

/**
 * Request payload for `addManualUsage` / `ag-pulse:add-manual-usage`.
 */
export interface AddManualUsageRequest extends ManualUsageScopeInput, ManualUsageInput {
  data?: ManualUsageInput;
}

export interface DeleteManualUsagePayload extends ManualUsageScopeInput {
  id: string | null;
}

/**
 * Request payload for `deleteManualUsage` / `ag-pulse:delete-manual-usage`.
 */
export type DeleteManualUsageRequest = DeleteManualUsagePayload | string;

export interface SwitchAccountPayload extends ManualUsageScopeInput {
  id?: string;
}

/**
 * Request payload for `switchAccount` / `ag-pulse:switch-account`.
 */
export type SwitchAccountRequest = SwitchAccountPayload | string;

/**
 * Request payload for `clearTimeline`.
 */
export interface ClearTimelineRequest {
  conversationId?: string | null;
}

export interface ProjectUsageRequest {
  scope?: string | null;
  from?: string;
  to?: string;
  timeZone?: string;
}

export interface ProjectDetailRequest {
  projectKey: string;
  scope?: string | null;
  from?: string;
  to?: string;
  timeZone?: string;
}

export type UpdateAction = 'check' | 'status' | 'apply' | 'reload';

export interface UpdatePluginRequest {
  action: UpdateAction;
  version?: string;
}

export type UpdateProgressPhase =
  | 'check'
  | 'download'
  | 'verify'
  | 'extract'
  | 'backup'
  | 'install'
  | 'recover'
  | 'complete';

export interface UpdateProgress {
  phase: UpdateProgressPhase;
  received?: number;
  total?: number;
}

export type UpdateLifecycleState =
  | 'idle'
  | 'checking'
  | 'current'
  | 'available'
  | 'installing'
  | 'installed'
  | 'reloading'
  | 'error';

export interface UpdatePluginState {
  state: UpdateLifecycleState;
  host: 'app';
  currentVersion: string | null;
  latestVersion?: string;
  notes?: string;
  error?: string;
  progress?: UpdateProgress;
}

export interface AccountsResponse {
  active?: string | null;
  activeAccount?: string | null;
  accounts: UsageAccountInfo[];
  error?: string;
}

export interface SwitchAccountResponse {
  success?: boolean;
  active?: string;
  activeAccount?: string;
  error?: string;
}

export interface RecordingAccountState {
  active: string | null;
  selected: string | null;
  localMode: boolean;
  accounts: UsageAccountInfo[];
  error?: string;
}

export interface SetRecordingAccountRequest {
  scope?: string | null;
  account?: string | null;
  id?: string | null;
}

export interface AddAccountRequest {
  email?: string;
  name?: string;
  identifier?: string;
  activate?: boolean;
}

export interface AddAccountResponse {
  success?: boolean;
  account?: UsageAccountInfo;
  active?: string | null;
  selected?: string | null;
  accounts?: UsageAccountInfo[];
  error?: string;
}

export interface ReassignConversationRequest {
  conversationId?: string;
  conversationIds?: string[];
  targetScope: string;
}

export interface ReassignConversationResponse {
  success?: boolean;
  reassigned?: number;
  targetScope?: string;
  conversationIds?: string[];
  error?: string;
}

export interface OpenSidebarInput {
  sidecarId: string;
  uri: string;
}

/**
 * Renderer bridge interface exposed on `window.agPulseHost` / `window.agPulseBridge`.
 */
export interface RuntimeBridgeApi {
  getMetrics(input?: MetricsRequestInput): Promise<MetricsSnapshot>;
  updatePlugin(input: UpdatePluginRequest): Promise<UpdatePluginState>;
  getPreferences(): Promise<PreferencesSnapshot>;
  setPreferences(input: PreferencesUpdateInput): Promise<PreferencesSnapshot>;
  clearTimeline(input?: ClearTimelineRequest): Promise<ClearTimelineResult>;
  report(input: DiagnosticReportInput): void;
  addManualUsage(input: AddManualUsageRequest): Promise<ManualUsageRecord | { error: string }>;
  deleteManualUsage(input: DeleteManualUsageRequest): Promise<boolean | { error: string }>;
  getAccounts(input?: ManualUsageScopeInput): Promise<UsageAccountInfo[] | AccountsResponse>;
  switchAccount(input: SwitchAccountRequest): Promise<SwitchAccountResponse>;
  getRecordingAccount?(): Promise<RecordingAccountState>;
  setRecordingAccount?(input: SetRecordingAccountRequest): Promise<RecordingAccountState>;
  addAccount?(input: AddAccountRequest): Promise<AddAccountResponse>;
  reassignConversation?(input: ReassignConversationRequest): Promise<ReassignConversationResponse>;
  getProjectUsage?(input?: ProjectUsageRequest): Promise<ProjectUsageOverview | { error: string }>;
  getProjectDetail?(input: ProjectDetailRequest): Promise<ProjectConversationDetail | { error: string }>;
  openSidebar?(input: OpenSidebarInput): Promise<unknown> | void;
}

/**
 * Electron `ipcMain` channels registered by `compat/ipc-host.cjs`.
 */
export type ElectronIpcChannel =
  | 'ag-pulse:metrics'
  | 'ag-pulse:preferences'
  | 'ag-pulse:diagnostic'
  | 'ag-pulse:add-manual-usage'
  | 'ag-pulse:addManualUsage'
  | 'ag-pulse:delete-manual-usage'
  | 'ag-pulse:deleteManualUsage'
  | 'ag-pulse:get-accounts'
  | 'ag-pulse:getAccounts'
  | 'ag-pulse:switch-account'
  | 'ag-pulse:switchAccount';
