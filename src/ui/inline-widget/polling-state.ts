import type {
  ClearTimelineRequest,
  ClearTimelineResult,
  DiagnosticReportInput,
  PreferencesSnapshot,
  PreferencesUpdateInput,
  QuotaGroup,
  RuntimeBridgeApi,
  UpdatePluginRequest,
  UpdatePluginState,
} from '../../contracts/index.ts';
import { setText } from '../../shared/dom.ts';
import type { WidgetLanguage, WidgetMetricsSnapshot } from './types.ts';

interface ManualRefreshState {
  promise: Promise<void>;
}

export interface PollingCallbacks {
  getConversationId: () => string | null;
  getRoot: () => ShadowRoot | null;
  getNode: () => HTMLElement | null;
  getLanguage: () => WidgetLanguage;
  isUsageOpen?: () => boolean;
  onConversationReset: () => void;
  onRender: () => void;
  onHide: () => void;
  onPreferencesSync: (prefs: PreferencesSnapshot) => void;
  onThemeSync: (theme: WidgetMetricsSnapshot['theme']) => void;
}

export class WidgetPollingState {
  data: WidgetMetricsSnapshot | null = null;
  lastConversation: string | null = null;
  private pending = false;
  private pendingForce = false;
  private refreshRequest: Promise<void> | null = null;
  private queuedForceRequest: Promise<void> | null = null;
  private manualRequest: ManualRefreshState | null = null;
  private usageFetchRequest: Promise<WidgetMetricsSnapshot['usage'] | null> | null = null;
  private requestEpoch = 0;
  private refreshSeq = 0;
  private lastFetch = 0;
  private lastExpiredRefresh = 0;
  private disposed = false;
  private readonly host: RuntimeBridgeApi;
  private readonly callbacks: PollingCallbacks;

  constructor(host: RuntimeBridgeApi, callbacks: PollingCallbacks) {
    this.host = host;
    this.callbacks = callbacks;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  report(stage: DiagnosticReportInput['stage'], details: Omit<DiagnosticReportInput, 'stage'> = {}): void {
    this.host.report?.({ stage, ...details });
  }

  getPreferences(): Promise<PreferencesSnapshot> {
    return this.host.getPreferences();
  }

  setPreferences(input: PreferencesUpdateInput): Promise<PreferencesSnapshot> {
    return this.host.setPreferences(input);
  }

  clearTimeline(input?: ClearTimelineRequest): Promise<ClearTimelineResult> {
    return this.host.clearTimeline(input);
  }

  updatePlugin(input: UpdatePluginRequest): Promise<UpdatePluginState> {
    return this.host.updatePlugin(input);
  }

  invalidateEpoch(): void {
    this.requestEpoch++;
    this.refreshSeq++;
    this.pending = false;
    this.pendingForce = false;
    this.refreshRequest = null;
    this.queuedForceRequest = null;
    this.manualRequest = null;
    this.usageFetchRequest = null;
    this.lastFetch = 0;
  }

  dispose(): void {
    this.disposed = true;
    this.invalidateEpoch();
  }

  private setRefreshBusy(busy: boolean): void {
    const root = this.callbacks.getRoot();
    const t = this.callbacks.getLanguage().t;
    for (const button of root?.querySelectorAll<HTMLElement>('.refresh') ?? []) {
      button.setAttribute('aria-busy', String(busy));
      button.setAttribute('aria-disabled', String(busy));
      button.dataset.i18nAria = busy ? 'refreshing' : 'refresh';
      button.title = t(button.dataset.i18nAria);
      button.setAttribute('aria-label', button.title);
    }
  }

  syncConversation(): boolean {
    const id = this.callbacks.getConversationId();
    if (id === this.lastConversation) return false;
    this.lastConversation = id;
    this.requestEpoch++;
    this.refreshSeq++;
    this.pending = false;
    this.pendingForce = false;
    this.refreshRequest = null;
    this.queuedForceRequest = null;
    this.lastFetch = 0;
    this.callbacks.onConversationReset();
    this.manualRequest = null;
    this.usageFetchRequest = null;
    this.setRefreshBusy(false);
    this.data = { connection: 'offline', error: null, serverTime: '', groups: [], speed: null };
    this.callbacks.onHide();
    // Navigation has its own refresh budget. A request from the old composer
    // must neither block the new route nor reset its polling clock on arrival.
    queueMicrotask(() => {
      if (!this.disposed) void this.refresh();
    });
    return true;
  }

  refresh(force = false): Promise<void> | undefined {
    if (this.disposed) return undefined;
    if (this.syncConversation()) this.callbacks.onRender();
    if (this.pending && this.refreshRequest) {
      if (!force || this.pendingForce) return this.refreshRequest;
      if (this.queuedForceRequest) return this.queuedForceRequest;
      const queuedEpoch = this.requestEpoch;
      const nextForced = this.refreshRequest
        .catch(() => {})
        .then(() => {
          this.queuedForceRequest = null;
          if (this.disposed || queuedEpoch !== this.requestEpoch) return;
          return this.refresh(true);
        });
      this.queuedForceRequest = nextForced;
      return nextForced;
    }
    const node = this.callbacks.getNode();
    if (!node?.isConnected) return undefined;

    const conversation = this.callbacks.getConversationId();
    const epoch = this.requestEpoch;
    const seq = ++this.refreshSeq;
    const current = (): boolean =>
      !this.disposed &&
      epoch === this.requestEpoch &&
      seq === this.refreshSeq &&
      conversation === this.callbacks.getConversationId() &&
      conversation === this.lastConversation &&
      Boolean(this.callbacks.getNode()?.isConnected);

    this.pending = true;
    this.pendingForce = force;
    this.lastFetch = Date.now();
    const includeUsage = Boolean(this.callbacks.isUsageOpen?.());
    const reqPromise = (async () => {
      try {
        const result = (await this.host.getMetrics({
          conversationId: conversation,
          force,
          includeUsage,
        })) as WidgetMetricsSnapshot;
        if (!current()) return;
        const activeNode = this.callbacks.getNode();
        if (activeNode) {
          activeNode.style.visibility = result.enabled === false ? 'hidden' : '';
        }
        if (result.enabled === false) {
          this.callbacks.onHide();
          return;
        }
        if (!conversation || (result.speed && result.speed.conversationId !== conversation)) {
          result.speed = null;
        }
        if (result.usage === undefined && this.callbacks.isUsageOpen?.() && this.data?.usage !== undefined) {
          result.usage = this.data.usage;
        }
        this.data = result;
        if (result.preferences) {
          this.callbacks.onPreferencesSync(result.preferences);
        }
        if (Object.hasOwn(result, 'theme')) {
          this.callbacks.onThemeSync(result.theme);
        }
        this.callbacks.onRender();
      } catch {
        if (current() && this.data) {
          this.data.connection = 'stale';
          this.data.error = this.callbacks.getLanguage().t('reconnecting');
          this.callbacks.onRender();
        }
      } finally {
        if (epoch === this.requestEpoch && seq === this.refreshSeq) {
          this.pending = false;
          this.pendingForce = false;
          this.refreshRequest = null;
        }
      }
    })();
    this.refreshRequest = reqPromise;
    return reqPromise;
  }

  fetchUsage(): Promise<WidgetMetricsSnapshot['usage'] | null> {
    if (this.disposed) return Promise.resolve(null);
    if (this.data?.usage) return Promise.resolve(this.data.usage);
    const node = this.callbacks.getNode();
    if (!node?.isConnected) return Promise.resolve(null);
    if (this.usageFetchRequest) return this.usageFetchRequest;

    const conversation = this.callbacks.getConversationId();
    const epoch = this.requestEpoch;
    let req: Promise<WidgetMetricsSnapshot['usage'] | null> | null = null;
    req = (async () => {
      try {
        const result = (await this.host.getMetrics({
          conversationId: conversation,
          force: false,
          includeUsage: true,
        })) as WidgetMetricsSnapshot;
        if (
          this.disposed ||
          epoch !== this.requestEpoch ||
          conversation !== this.callbacks.getConversationId() ||
          !this.callbacks.getNode()?.isConnected
        ) {
          return null;
        }
        if (this.data) {
          if (result.usage !== undefined) {
            this.data.usage = result.usage;
          }
        } else {
          if (!conversation || (result.speed && result.speed.conversationId !== conversation)) {
            result.speed = null;
          }
          this.data = result;
        }
        return result.usage ?? null;
      } catch {
        return null;
      } finally {
        if (this.usageFetchRequest === req) {
          this.usageFetchRequest = null;
        }
      }
    })();
    this.usageFetchRequest = req;
    return req;
  }

  refreshManually(onBeforeRefresh: () => void): Promise<void> {
    if (this.manualRequest) return this.manualRequest.promise;
    onBeforeRefresh();
    this.setRefreshBusy(true);
    const started = performance.now();
    const epoch = this.requestEpoch;
    const request: ManualRefreshState = {
      promise: Promise.resolve(),
    };
    this.manualRequest = request;
    request.promise = (async () => {
      try {
        if (!this.disposed && epoch === this.requestEpoch) await this.refresh(true);
      } finally {
        // A fast cached response still needs visible press feedback. This does
        // not delay data updates; only the indicator has a 250ms minimum.
        const remaining = 250 - (performance.now() - started);
        if (remaining > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, remaining));
        }
        if (this.manualRequest === request) {
          this.setRefreshBusy(false);
          this.manualRequest = null;
        }
      }
    })();
    return request.promise;
  }

  tick(group: QuotaGroup | null | undefined): void {
    const root = this.callbacks.getRoot();
    if (!root) return;
    const language = this.callbacks.getLanguage();
    for (const [windowKey, name] of [
      ['5h', 'five'],
      ['weekly', 'week'],
    ] as const) {
      const b = group?.windows?.[windowKey];
      const resetAt = b?.available ? b.resetAt : null;
      setText(root.getElementById(`${name}-timer`), language.countdown(resetAt, Date.now(), true));
      setText(root.getElementById(`${name}-countdown`), language.countdown(resetAt));
      if (resetAt && Date.parse(resetAt) <= Date.now() && Date.now() - this.lastExpiredRefresh > 30000) {
        this.lastExpiredRefresh = Date.now();
        void this.refresh(true);
      }
    }
  }

  pollIfDue(): void {
    if (
      this.callbacks.getConversationId() !== this.lastConversation ||
      Date.now() - this.lastFetch > (document.hidden ? 10000 : 2200)
    ) {
      void this.refresh();
    }
  }
}
