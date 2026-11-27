import { createHash } from 'node:crypto';
import type { MetricsRequestInput } from '../../contracts/index.ts';
import {
  discoverDevToolsTargets,
  isValidDevToolsTarget,
  type DevToolsTarget,
} from '../../platform/devtools.ts';

export const GUID_RE =
  /^(?:[a-zA-Z0-9_.-]+\/)*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A previous sidecar may outlive a desktop update. Use a distinct protocol
// binding so its older collector cannot answer the current widget's requests.
export const BINDING = '__agPulseRuntimeCallV4';

export function validTarget(target: DevToolsTarget | null | undefined, port: number): boolean {
  return isValidDevToolsTarget(target, port, 'desktop');
}

export function validatedInput(value: unknown): {
  conversationId: string | null;
  force: boolean;
  includeUsage?: boolean;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid metrics request');
  }
  const input = value as MetricsRequestInput;
  if (input.conversationId != null && !GUID_RE.test(input.conversationId)) {
    throw new Error('Invalid conversation ID');
  }
  return {
    conversationId: input.conversationId || null,
    force: input.force === true,
    ...(typeof input.includeUsage === 'boolean' ? { includeUsage: input.includeUsage } : {}),
  };
}

export async function discoverTargets(profile: string): Promise<DevToolsTarget[]> {
  const { targets } = await discoverDevToolsTargets(profile, { mode: 'desktop' });
  return targets;
}

interface BridgeRuntimeHandle {
  binding: string;
  resolve(id: number, result: unknown): void;
  reconnect(): void;
  dispose(): void;
}

interface BridgeWindow extends Window {
  __agPulseRuntimeBridge?: BridgeRuntimeHandle;
  agPulseHost?: Record<string, unknown>;
  agPulseBridge?: Record<string, unknown>;
  [key: string]: unknown;
}

// Only sanitized metrics cross the bridge. No API credential or conversation text is exposed.
function rendererBridge(binding: string): void {
  if (window !== window.top) return;
  const win = window as unknown as BridgeWindow;
  if (win.__agPulseRuntimeBridge && win.agPulseHost) return;
  win.__agPulseRuntimeBridge?.dispose();
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; timer: ReturnType<typeof setTimeout> }
  >();
  let sequence = 0;
  const empty = () => ({
    connection: 'offline',
    error: '等待 Antigrative Dashboard 重新连接',
    speed: null,
    groups: [],
    enabled: false,
  });
  const call = (type: string, input: unknown) =>
    new Promise((resolve) => {
      if (pending.size >= 8) {
        resolve(empty());
        return;
      }
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve(empty());
      }, 45000);
      pending.set(id, { resolve, timer });
      try {
        (win[binding] as (payload: string) => void)(JSON.stringify({ id, type, input }));
      } catch {
        clearTimeout(timer);
        pending.delete(id);
        resolve(empty());
      }
    });
  win.__agPulseRuntimeBridge = {
    binding,
    resolve(id: number, result: unknown) {
      const item = pending.get(id);
      if (!item) return;
      clearTimeout(item.timer);
      pending.delete(id);
      item.resolve(result);
    },
    reconnect() {
      for (const item of pending.values()) {
        clearTimeout(item.timer);
        item.resolve({
          connection: 'offline',
          error: '等待 Antigrative Dashboard 重新连接',
          speed: null,
          groups: [],
        });
      }
      pending.clear();
    },
    dispose() {
      for (const item of pending.values()) {
        clearTimeout(item.timer);
        item.resolve(empty());
      }
      pending.clear();
      delete win.__agPulseRuntimeBridge;
    },
  };
  const hostApi = {
    getMetrics: (input: unknown) => call('metrics', input),
    updatePlugin: (input: unknown) => call('update', input),
    getPreferences: () => call('preferences', {}),
    setPreferences: (input: unknown) => call('preferences', input),
    clearTimeline: (input: unknown) =>
      call('clearTimeline', input && typeof input === 'object' && !Array.isArray(input) ? input : {}),
    report: (input: unknown) => {
      void call('diagnostic', input);
    },
    addManualUsage: (input: unknown) => call('addManualUsage', input),
    deleteManualUsage: (input: unknown) => call('deleteManualUsage', input),
    getAccounts: () => call('getAccounts', {}),
    switchAccount: (input: unknown) => call('switchAccount', input),
    getRecordingAccount: () => call('getRecordingAccount', {}),
    setRecordingAccount: (input: unknown) => call('setRecordingAccount', input),
    addAccount: (input: unknown) => call('addAccount', input),
    reassignConversation: (input: unknown) => call('reassignConversation', input),
    getProjectUsage: (input?: unknown) => call('getProjectUsage', input ?? {}),
    getProjectDetail: (input: unknown) => call('getProjectDetail', input),
  };
  win.agPulseHost = Object.assign(win.agPulseHost || {}, hostApi);
  win.agPulseBridge = Object.assign(win.agPulseBridge || {}, hostApi);
}

/**
 * Wraps a CommonJS module source in an isolated IIFE expression that evaluates
 * to `module.exports` without string-slicing or regex-stripping exports.
 */
export function evaluateCjsFactoryExpression(cjsSource: string, label = 'Widget'): string {
  if (!/(?:^|\r?\n)\s*(?:module\.)?exports\s*=/.test(cjsSource)) {
    throw new Error(`${label} source format changed`);
  }
  return `(function(){const module={exports:{}};const exports=module.exports;(function(module,exports){\n${cjsSource}\n}).call(module.exports,module,exports);return module.exports;})()`;
}

export function bindWindowFactory(globalName: string, cjsSource: string, label?: string): string {
  return `window.${globalName}=${evaluateCjsFactoryExpression(cjsSource, label ?? globalName)};`;
}

export function invokeCjsFactory(cjsSource: string, label?: string): string {
  return `${evaluateCjsFactoryExpression(cjsSource, label)}();`;
}

export function makeEsmExportFromCjs(exportName: string, cjsSource: string, label?: string): string {
  return `export const ${exportName}=${evaluateCjsFactoryExpression(cjsSource, label ?? exportName)};`;
}

export function makeRendererSource(
  i18n: string,
  widget: string,
  theme = '',
  owner: string | null = null,
  generation = 0,
  extraSource = '',
): string {
  const version = createHash('sha256')
    .update(i18n + widget + theme + extraSource + rendererBridge.toString() + JSON.stringify(owner))
    .digest('hex');
  const upgrade =
    'if(window.__agPulseRuntimeVersion!==' +
    JSON.stringify(version) +
    '){window.__agPulseDispose?.();window.__agPulseRuntimeBridge?.dispose();delete window.agPulseHost;window.__agPulseRuntimeVersion=' +
    JSON.stringify(version) +
    ';}';
  const binding = owner ? BINDING + '_' + owner.replaceAll('-', '') : BINDING;
  const rank = JSON.stringify([generation, owner || '']);
  const code =
    upgrade +
    'window.__agPulseRuntimeOwner=' +
    JSON.stringify(owner) +
    ';window.__agPulseRuntimeRank=' +
    rank +
    ';(' +
    rendererBridge.toString() +
    ')(' +
    JSON.stringify(binding) +
    ');' +
    bindWindowFactory('__agPulseI18nFactory', i18n, 'i18n') +
    (theme ? bindWindowFactory('__agPulseThemeFactory', theme, 'theme') : '') +
    extraSource +
    invokeCjsFactory(widget, 'widget');
  // A delayed injection from a superseded instance cannot replace a newer UI.
  return owner
    ? 'if(!window.__agPulseRuntimeRank||window.__agPulseRuntimeRank[0]<' +
        generation +
        '||(window.__agPulseRuntimeRank[0]===' +
        generation +
        '&&window.__agPulseRuntimeRank[1]<=' +
        JSON.stringify(owner) +
        ')){' +
        code +
        '}'
    : code;
}
