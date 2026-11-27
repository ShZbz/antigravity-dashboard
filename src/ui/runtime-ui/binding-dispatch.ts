import { join } from 'node:path';
import type {
  AddAccountRequest,
  AddManualUsageRequest,
  ClearTimelineRequest,
  ClearTimelineResult,
  DeleteManualUsageRequest,
  DiagnosticReportInput,
  DiagnosticStage,
  ManualUsageInput,
  MetricsSnapshot,
  PreferencesUpdateInput,
  ProjectDetailRequest,
  ProjectUsageRequest,
  ReassignConversationRequest,
  SetRecordingAccountRequest,
  SwitchAccountRequest,
  UpdatePluginRequest,
} from '../../contracts/index.ts';
import { PREFERENCE_KEYS, validateFontScaleInput } from '../../contracts/preferences.ts';
import { platformPaths } from '../../platform/paths.ts';
import { GUID_RE, validatedInput } from './renderer-bridge.ts';
import type { RuntimeSessionConnection, RuntimeUiOptions } from './types.ts';

const ALLOWED_PREFERENCE_KEYS = new Set<string>(PREFERENCE_KEYS);
const DIAGNOSTIC_STAGES = new Set<DiagnosticStage>(['boot', 'mounted', 'mount-error']);
const USAGE_OPERATIONS = new Set([
  'addManualUsage',
  'deleteManualUsage',
  'getAccounts',
  'switchAccount',
  'getRecordingAccount',
  'setRecordingAccount',
  'addAccount',
  'reassignConversation',
  'getProjectUsage',
  'getProjectDetail',
  'clearTimeline',
]);

export function offlineSnapshot(message: string): MetricsSnapshot {
  return {
    connection: 'offline',
    error: message,
    speed: null,
    groups: [],
    serverTime: new Date().toISOString(),
  };
}

export interface BindingPayload {
  id: number;
  type: string;
  input?: unknown;
}

export interface RuntimeDispatchHost {
  snapshot?: RuntimeUiOptions['snapshot'];
  dataDir?: string;
  preferences?: RuntimeUiOptions['preferences'];
  updater?: RuntimeUiOptions['updater'];
  enabled: () => boolean | Promise<boolean>;
  addManualUsage?: RuntimeUiOptions['addManualUsage'];
  deleteManualUsage?: RuntimeUiOptions['deleteManualUsage'];
  getAccounts?: RuntimeUiOptions['getAccounts'];
  switchAccount?: RuntimeUiOptions['switchAccount'];
  getRecordingAccount?: RuntimeUiOptions['getRecordingAccount'];
  setRecordingAccount?: RuntimeUiOptions['setRecordingAccount'];
  addAccount?: RuntimeUiOptions['addAccount'];
  reassignConversation?: RuntimeUiOptions['reassignConversation'];
  getProjectUsage?: RuntimeUiOptions['getProjectUsage'];
  getProjectDetail?: RuntimeUiOptions['getProjectDetail'];
  clearTimeline?: RuntimeUiOptions['clearTimeline'];
}

const MAX_BRIDGE_RESULT_BYTES = 1048576;

function exceedsBridgeLimit(jsonText: string): boolean {
  if (jsonText.length > MAX_BRIDGE_RESULT_BYTES) return true;
  if (jsonText.length <= Math.floor(MAX_BRIDGE_RESULT_BYTES / 3)) return false;
  return Buffer.byteLength(jsonText, 'utf8') > MAX_BRIDGE_RESULT_BYTES;
}

export async function dispatchBindingCall(
  host: RuntimeDispatchHost,
  connection: RuntimeSessionConnection,
  input: BindingPayload,
): Promise<{ handled: boolean; result?: unknown; serializedResult?: string }> {
  let result: unknown = {};
  if (input.type === 'metrics') {
    if (await host.enabled()) {
      result = host.snapshot ? await host.snapshot(validatedInput(input.input)) : {};
    } else {
      result = { ...offlineSnapshot('Antigrative Dashboard 已停用'), enabled: false };
    }
  } else if (input.type === 'update' && host.updater) {
    if (!(await host.enabled())) throw Error('Plugin disabled');
    result = await host.updater.request(input.input as UpdatePluginRequest);
  } else if (input.type === 'preferences' && host.preferences) {
    const value = input.input as Record<string, unknown> | null | undefined;
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).some((key) => !ALLOWED_PREFERENCE_KEYS.has(key))
    ) {
      throw new Error('Invalid preferences request');
    }
    if (
      Object.hasOwn(value, 'modelTimelineEnabled') &&
      typeof value.modelTimelineEnabled !== 'boolean'
    ) {
      throw new Error('Invalid timeline preference');
    }
    if (
      Object.hasOwn(value, 'debugLaunchEnabled') &&
      typeof value.debugLaunchEnabled !== 'boolean'
    ) {
      throw new Error('Invalid debug launch preference');
    }
    validateFontScaleInput(value);
    result = Object.keys(value).length
      ? await host.preferences.set(value as PreferencesUpdateInput)
      : await host.preferences.get();
  } else if (
    input.type === 'diagnostic' &&
    DIAGNOSTIC_STAGES.has((input.input as Partial<DiagnosticReportInput> | undefined)?.stage as DiagnosticStage)
  ) {
    const diag = input.input as DiagnosticReportInput;
    if (diag.stage === 'mounted' && diag.editorFound && diag.composerFound) {
      connection.mounted = true;
    }
  } else if (input.type === 'addManualUsage') {
    if (!(await host.enabled())) throw Error('Plugin disabled');
    if (typeof host.addManualUsage === 'function') {
      result = await host.addManualUsage(
        input.input as AddManualUsageRequest & { data?: ManualUsageInput },
      );
    } else {
      const { UsageLedger } = await import('../../telemetry/ledger/index.ts');
      const ledger = new UsageLedger(join(host.dataDir || platformPaths().data, 'usage-v1'));
      const raw = (input.input ?? {}) as AddManualUsageRequest;
      const scope = raw.scope || raw.account || raw.accountKey || '';
      const data = raw.data || raw;
      result = await ledger.addManualUsage(scope, data);
    }
  } else if (input.type === 'deleteManualUsage') {
    if (!(await host.enabled())) throw Error('Plugin disabled');
    if (typeof host.deleteManualUsage === 'function') {
      result = await host.deleteManualUsage(input.input as DeleteManualUsageRequest);
    } else {
      const { UsageLedger } = await import('../../telemetry/ledger/index.ts');
      const ledger = new UsageLedger(join(host.dataDir || platformPaths().data, 'usage-v1'));
      const raw = input.input as DeleteManualUsageRequest | undefined;
      const scope =
        typeof raw === 'object' && raw !== null ? raw.scope || raw.account || raw.accountKey || '' : '';
      const id =
        typeof raw === 'string'
          ? raw
          : typeof raw === 'object' && raw !== null
            ? raw.id || ''
            : '';
      result = await ledger.deleteManualUsage(scope, id);
    }
  } else if (input.type === 'getAccounts') {
    if (!(await host.enabled())) throw Error('Plugin disabled');
    if (typeof host.getAccounts === 'function') {
      result = await host.getAccounts(input.input);
    } else {
      const { UsageLedger } = await import('../../telemetry/ledger/index.ts');
      const ledger = new UsageLedger(join(host.dataDir || platformPaths().data, 'usage-v1'));
      const raw = (input.input ?? {}) as { active?: string | null; scope?: string | null };
      result = await ledger.getAccounts(raw.active || raw.scope || null);
    }
  } else if (input.type === 'switchAccount') {
    if (!(await host.enabled())) throw Error('Plugin disabled');
    if (typeof host.switchAccount === 'function') {
      result = await host.switchAccount(input.input as SwitchAccountRequest);
    } else {
      const raw = input.input as SwitchAccountRequest | undefined;
      const account = typeof raw === 'string' ? raw : raw?.account || raw?.id;
      result = { success: true, active: account, activeAccount: account };
    }
  } else if (input.type === 'getRecordingAccount') {
    if (!(await host.enabled())) throw Error('Plugin disabled');
    if (typeof host.getRecordingAccount === 'function') {
      result = await host.getRecordingAccount();
    } else {
      const { UsageLedger } = await import('../../telemetry/ledger/index.ts');
      const ledger = new UsageLedger(join(host.dataDir || platformPaths().data, 'usage-v1'));
      const [selected, accounts] = await Promise.all([
        ledger.getActiveLocalAccount(),
        ledger.getAccounts(null),
      ]);
      result = { active: selected, selected, localMode: true, accounts };
    }
  } else if (input.type === 'setRecordingAccount') {
    if (!(await host.enabled())) throw Error('Plugin disabled');
    if (typeof host.setRecordingAccount === 'function') {
      result = await host.setRecordingAccount(input.input as SetRecordingAccountRequest);
    } else {
      const { UsageLedger } = await import('../../telemetry/ledger/index.ts');
      const ledger = new UsageLedger(join(host.dataDir || platformPaths().data, 'usage-v1'));
      const raw = (input.input ?? {}) as SetRecordingAccountRequest;
      const scope = raw.scope ?? raw.account ?? raw.id ?? null;
      const saved = await ledger.setActiveLocalAccount(scope === 'auto' || scope === '' ? null : scope);
      const accounts = await ledger.getAccounts(saved);
      result = { active: saved, selected: saved, localMode: true, accounts };
    }
  } else if (input.type === 'addAccount') {
    if (!(await host.enabled())) throw Error('Plugin disabled');
    if (typeof host.addAccount === 'function') {
      result = await host.addAccount(input.input as AddAccountRequest);
    } else {
      const { UsageLedger } = await import('../../telemetry/ledger/index.ts');
      const ledger = new UsageLedger(join(host.dataDir || platformPaths().data, 'usage-v1'));
      const created = await ledger.createLocalAccount((input.input ?? {}) as AddAccountRequest);
      const accounts = await ledger.getAccounts(created.id);
      result = { success: true, account: created, active: created.id, selected: created.id, accounts };
    }
  } else if (input.type === 'reassignConversation') {
    if (!(await host.enabled())) throw Error('Plugin disabled');
    const req = (input.input ?? {}) as ReassignConversationRequest;
    if (typeof host.reassignConversation === 'function') {
      result = await host.reassignConversation(req);
    } else {
      const { UsageLedger } = await import('../../telemetry/ledger/index.ts');
      const ledger = new UsageLedger(join(host.dataDir || platformPaths().data, 'usage-v1'));
      const ids = [
        ...(Array.isArray(req.conversationIds) ? req.conversationIds : []),
        ...(typeof req.conversationId === 'string' ? [req.conversationId] : []),
      ];
      const out = await ledger.reassignConversationOwnership(ids, req.targetScope || '');
      result = { success: true, ...out };
    }
  } else if (input.type === 'getProjectUsage') {
    if (!(await host.enabled())) throw Error('Plugin disabled');
    const req = (input.input && typeof input.input === 'object' && !Array.isArray(input.input)
      ? input.input
      : {}) as ProjectUsageRequest;
    if (typeof host.getProjectUsage === 'function') {
      result = await host.getProjectUsage(req);
    } else {
      const { UsageLedger, queryProjectUsageOverview } = await import('../../telemetry/ledger/index.ts');
      const ledger = new UsageLedger(join(host.dataDir || platformPaths().data, 'usage-v1'));
      result = await queryProjectUsageOverview({ ledger, scope: req.scope ?? null, from: req.from, to: req.to });
    }
  } else if (input.type === 'getProjectDetail') {
    if (!(await host.enabled())) throw Error('Plugin disabled');
    const req = (input.input && typeof input.input === 'object' && !Array.isArray(input.input)
      ? input.input
      : {}) as Partial<ProjectDetailRequest>;
    if (!req.projectKey || typeof req.projectKey !== 'string') {
      throw new Error('Invalid projectKey');
    }
    if (typeof host.getProjectDetail === 'function') {
      result = await host.getProjectDetail(req as ProjectDetailRequest);
    } else {
      const { UsageLedger, queryProjectConversationDetail } = await import('../../telemetry/ledger/index.ts');
      const ledger = new UsageLedger(join(host.dataDir || platformPaths().data, 'usage-v1'));
      result = await queryProjectConversationDetail({
        ledger,
        projectKey: req.projectKey,
        scope: req.scope ?? null,
        from: req.from,
        to: req.to,
      });
    }
  } else if (input.type === 'clearTimeline') {
    if (!(await host.enabled())) throw Error('Plugin disabled');
    const value = (input.input ?? {}) as ClearTimelineRequest;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Invalid clear timeline request');
    }
    if (value.conversationId != null && !GUID_RE.test(value.conversationId)) {
      throw new Error('Invalid conversation ID');
    }
    const cleanInput: ClearTimelineRequest = value.conversationId
      ? { conversationId: value.conversationId }
      : {};
    if (typeof host.clearTimeline === 'function') {
      result = await host.clearTimeline(cleanInput);
    } else if (host.dataDir) {
      const { TimelineStore } = await import('../../telemetry/timeline/store.ts');
      const timelineStore = new TimelineStore(join(host.dataDir, 'timeline-v1'));
      result = await timelineStore.clearAll(null);
    } else {
      result = { cleared: false } satisfies ClearTimelineResult;
    }
  } else {
    return { handled: false };
  }

  let serializedResult = JSON.stringify(result) ?? 'null';
  if (exceedsBridgeLimit(serializedResult)) {
    result = offlineSnapshot('Metrics response too large');
    serializedResult = JSON.stringify(result);
  }
  return { handled: true, result, serializedResult };
}

export function formatBindingError(type: string, error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (type === 'preferences') {
    return {
      error:
        message === 'Invalid timeline preference' || message === 'Invalid font scale preference'
          ? message
          : 'Language preference could not be saved or read',
    };
  }
  if (USAGE_OPERATIONS.has(type)) {
    return { error: message || 'Operation failed' };
  }
  return offlineSnapshot('等待 Antigrative Dashboard 重新连接');
}
