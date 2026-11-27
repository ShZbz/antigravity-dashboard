import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IntegrationHealth, IntegrationHealthState } from '../../contracts/index.ts';
import { platformPaths } from '../../platform/paths.ts';
import { CdpConnection } from './cdp-connection.ts';
import { handleCdpEvent } from './event-handler.ts';
import { BINDING, discoverTargets } from './renderer-bridge.ts';
import {
  attachTargetSession,
  detachTargetSession,
  verifyTargetSession,
  type SessionLifecycleContext,
} from './session-lifecycle.ts';
import type {
  CdpConnectionOptions,
  CdpEventMessage,
  DevToolsTarget,
  RuntimeSessionConnection,
  RuntimeUiOptions,
} from './types.ts';

export class RuntimeUi {
  snapshot: RuntimeUiOptions['snapshot'];
  source: string;
  profile: string;
  dataDir?: string;
  enabled: () => boolean | Promise<boolean>;
  discover: (profile: string) => Promise<DevToolsTarget[]>;
  connect: (url: string, options: CdpConnectionOptions) => RuntimeSessionConnection;
  interval: number;
  sessions: Map<string, RuntimeSessionConnection>;
  running: boolean;
  stopping: boolean;
  busy: boolean;
  timer?: ReturnType<typeof setInterval> | { unref?: () => void };
  targetOrigin: (target: DevToolsTarget) => string;
  health: IntegrationHealth;
  preferences: RuntimeUiOptions['preferences'];
  updater: RuntimeUiOptions['updater'];
  owner: string | null;
  owns: () => boolean | Promise<boolean>;
  binding: string;
  addManualUsage: RuntimeUiOptions['addManualUsage'];
  deleteManualUsage: RuntimeUiOptions['deleteManualUsage'];
  getAccounts: RuntimeUiOptions['getAccounts'];
  switchAccount: RuntimeUiOptions['switchAccount'];
  getRecordingAccount: RuntimeUiOptions['getRecordingAccount'];
  setRecordingAccount: RuntimeUiOptions['setRecordingAccount'];
  addAccount: RuntimeUiOptions['addAccount'];
  reassignConversation: RuntimeUiOptions['reassignConversation'];
  getProjectUsage: RuntimeUiOptions['getProjectUsage'];
  getProjectDetail: RuntimeUiOptions['getProjectDetail'];
  clearTimeline: RuntimeUiOptions['clearTimeline'];
  now: () => number;
  healthWriteThrottleMs: number;
  private lastHealthWriteKey: string | null = null;
  private lastHealthWriteAt = 0;

  constructor({
    snapshot,
    source = '',
    profile = platformPaths().profile,
    dataDir,
    preferences,
    updater = null,
    owner = null,
    owns = async () => true,
    enabled = async () => true,
    discover = discoverTargets,
    targetOrigin = (target) => new URL(target.url ?? '').origin,
    connect = (url, options) => new CdpConnection(url, options),
    interval = 3000,
    now = Date.now,
    healthWriteThrottleMs = 60_000,
    addManualUsage = null,
    deleteManualUsage = null,
    getAccounts = null,
    switchAccount = null,
    getRecordingAccount = null,
    setRecordingAccount = null,
    addAccount = null,
    reassignConversation = null,
    getProjectUsage = null,
    getProjectDetail = null,
    clearTimeline = null,
  }: RuntimeUiOptions & { now?: () => number; healthWriteThrottleMs?: number } = {}) {
    this.snapshot = snapshot;
    this.source = source;
    this.profile = profile;
    this.dataDir = dataDir;
    this.enabled = enabled;
    this.discover = discover;
    this.connect = connect;
    this.interval = interval;
    this.now = now;
    this.healthWriteThrottleMs = healthWriteThrottleMs;
    this.sessions = new Map();
    this.running = false;
    this.stopping = false;
    this.busy = false;
    this.targetOrigin = targetOrigin;
    this.health = {
      state: 'waiting',
      mode: 'runtime',
      message: 'Waiting for the app renderer',
      windows: 0,
    };
    this.preferences = preferences;
    this.updater = updater;
    this.owner = owner;
    this.owns = owns;
    this.binding = owner ? BINDING + '_' + owner.replaceAll('-', '') : BINDING;
    this.addManualUsage = addManualUsage;
    this.deleteManualUsage = deleteManualUsage;
    this.getAccounts = getAccounts;
    this.switchAccount = switchAccount;
    this.getRecordingAccount = getRecordingAccount;
    this.setRecordingAccount = setRecordingAccount;
    this.addAccount = addAccount;
    this.reassignConversation = reassignConversation;
    this.getProjectUsage = getProjectUsage;
    this.getProjectDetail = getProjectDetail;
    this.clearTimeline = clearTimeline;
  }

  private lifecycleContext(): SessionLifecycleContext {
    return {
      source: this.source,
      owner: this.owner,
      binding: this.binding,
      stopping: this.stopping,
      owns: this.owns,
      targetOrigin: this.targetOrigin,
      connect: this.connect,
      onEvent: (connection, message) => {
        void this.event(connection, message as CdpEventMessage);
      },
      rendererGuard: (expression) => this.rendererGuard(expression),
    };
  }

  async setHealth(state: IntegrationHealthState, message: string, forceWrite = false): Promise<void> {
    const now = this.now();
    this.health = {
      state,
      mode: 'runtime',
      message,
      windows: this.sessions.size,
      checkedAt: new Date(now).toISOString(),
    };
    if (!this.dataDir || !(await this.owns())) return;
    const writeKey = JSON.stringify([
      this.health.state,
      this.health.mode,
      this.health.message,
      this.health.windows,
      this.health.activePortPresent ?? null,
      this.health.debugLaunchEnabled ?? null,
      this.health.debugLaunchConfigured ?? null,
    ]);
    const changed = writeKey !== this.lastHealthWriteKey;
    const elapsed = now - this.lastHealthWriteAt >= this.healthWriteThrottleMs;
    if (!forceWrite && !changed && !elapsed) return;
    try {
      await mkdir(this.dataDir, { recursive: true });
      await writeFile(join(this.dataDir, 'integration-state.json'), JSON.stringify(this.health));
      this.lastHealthWriteKey = writeKey;
      this.lastHealthWriteAt = now;
    } catch {
      // Read-only state reporting must not crash collection.
    }
  }

  async event(connection: RuntimeSessionConnection, message: CdpEventMessage): Promise<void> {
    await handleCdpEvent(this, connection, message);
  }

  rendererGuard(expression: string): string {
    return this.owner
      ? 'if(window.__agPulseRuntimeOwner===' + JSON.stringify(this.owner) + '){' + expression + '}'
      : expression;
  }

  async attach(target: DevToolsTarget): Promise<RuntimeSessionConnection> {
    return attachTargetSession(this.lifecycleContext(), target);
  }

  async tick(): Promise<void> {
    if (this.busy || this.stopping) return;
    this.busy = true;
    try {
      if (!(await this.owns())) {
        await this.detachAll();
        return;
      }
      if (!(await this.enabled())) {
        await this.detachAll();
        await this.setHealth('disabled', 'Dashboard is disabled');
        return;
      }
      const targets = await this.discover(this.profile);
      const active = new Set(targets.map((t) => t.webSocketDebuggerUrl).filter(Boolean));
      if (this.stopping || !(await this.owns())) return;
      for (const [url, connection] of this.sessions) {
        if (!active.has(url) || connection.closed) {
          connection.close();
          this.sessions.delete(url);
        }
      }
      for (const target of targets) {
        const wsUrl = target.webSocketDebuggerUrl;
        if (!wsUrl) continue;
        const connection = this.sessions.get(wsUrl);
        if (connection && connection.origin !== this.targetOrigin(target)) {
          connection.close();
          this.sessions.delete(wsUrl);
        }
      }
      for (const target of targets) {
        const wsUrl = target.webSocketDebuggerUrl;
        if (wsUrl && !this.sessions.has(wsUrl)) {
          this.sessions.set(wsUrl, await this.attach(target));
        }
      }
      if (this.stopping || !(await this.owns())) {
        await this.detachAll();
        return;
      }
      const ctx = this.lifecycleContext();
      for (const [url, connection] of this.sessions) {
        try {
          if (!(await verifyTargetSession(ctx, connection))) break;
        } catch {
          // Navigation failures must not accumulate a preload on each retry.
          try {
            if (connection.script) {
              await connection.command('Page.removeScriptToEvaluateOnNewDocument', {
                identifier: connection.script,
              });
            }
          } catch {
            // Ignore cleanup errors.
          }
          connection.close();
          this.sessions.delete(url);
        }
      }
      await this.setHealth(
        [...this.sessions.values()].some((c) => c.mounted)
          ? 'mounted'
          : this.sessions.size
            ? 'waiting-for-composer'
            : 'waiting',
        this.sessions.size
          ? 'Renderer connected; waiting for a conversation composer if needed'
          : 'Waiting for the app renderer',
      );
    } catch {
      if (this.stopping) return;
      await this.setHealth(
        'reconnecting',
        'Inline connection unavailable; the side panel remains available. Retrying automatically.',
      );
    } finally {
      this.busy = false;
    }
  }

  async openUsageModal(): Promise<boolean> {
    if (this.stopping || !(await this.owns()) || !(await this.enabled())) return false;
    for (const connection of this.sessions.values()) {
      if (connection.closed || !connection.mounted) continue;
      try {
        const res = (await connection.command('Runtime.evaluate', {
          returnByValue: true,
          expression: this.rendererGuard('Boolean(window.__agPulseOpenUsage?.())'),
        })) as { exceptionDetails?: unknown; result?: { value?: unknown } };
        if (!res.exceptionDetails && res.result?.value === true) return true;
      } catch {
        // Try next mounted window.
      }
    }
    return false;
  }

  async detachAll(): Promise<void> {
    const ctx = this.lifecycleContext();
    for (const connection of this.sessions.values()) {
      await detachTargetSession(ctx, connection);
    }
    this.sessions.clear();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    void this.tick();
    const timer = setInterval(() => {
      void this.tick();
    }, this.interval) as unknown as { unref?: () => void };
    timer.unref?.();
    this.timer = timer;
  }

  async stop(): Promise<void> {
    this.running = false;
    this.stopping = true;
    if (this.timer) clearInterval(this.timer as number);
    await this.detachAll();
    await this.setHealth(this.health.state, this.health.message, true);
  }
}
