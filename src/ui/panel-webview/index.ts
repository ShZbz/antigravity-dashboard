import type { PreferencesSnapshot, RuntimeBridgeApi } from '../../contracts/index.ts';
import { resolveFontScale } from '../../contracts/preferences.ts';
import { setAttr, setHidden, setMarkup, setText } from '../../shared/dom.ts';
import createDashboardI18n from '../i18n/index.ts';
import { FONT_CONTROL_CSS } from '../shared/font-popover.ts';
import createAgPulseTheme from '../theme/index.ts';
import type { UsageDashboardHandle, UsageDashboardOptions } from '../usage-modal/types.ts';
import { createCardSwitcher, createDomLookup, setExpandedState, syncPinBottom } from './dom-motion.ts';
import { bindModelMixEvents, renderModelMix } from './model-mix.ts';
import { createPanelController } from './polling.ts';
import { renderQuotaAndSpeedSections, updateCountdowns } from './quota-section.ts';
import { createSettingsPopover } from './settings-popover.ts';
import { bindSubagentEvents, renderSubagentsSection } from './subagent-tree.ts';
import { focusTimelineNodeByStep, renderTimeline, showSwimlaneTip } from './swimlane-timeline.ts';
import { formatClock } from './timeline-helpers.ts';
import type { PanelDomContext, PanelState, PanelWindow } from './types.ts';

function initPanel(): void {
  const panelWin = window as PanelWindow;
  if (!document.querySelector('.widget') || panelWin.__agPulsePanelInstalled) return;
  panelWin.__agPulsePanelInstalled = true;

  const localGet = (key: string): string | null => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  };
  const localSet = (key: string, value: string): void => {
    try {
      localStorage.setItem(key, value);
    } catch {
      // ignore storage errors in constrained webviews
    }
  };

  const applySidebarFontScale = (scale: unknown): void => {
    const resolved = String(resolveFontScale(scale));
    if (document.documentElement.style.getPropertyValue('--pulse-sidebar-font-scale') !== resolved) {
      document.documentElement.style.setProperty('--pulse-sidebar-font-scale', resolved);
    }
  };
  // Apply initial font scale and static popover stylesheet BEFORE attaching the theme
  // MutationObserver so cold start avoids an extra style/head recalc pass.
  applySidebarFontScale(localGet('ag-pulse-sidebar-font-scale'));
  if (!document.getElementById('ag-pulse-font-popover-style')) {
    const styleEl = document.createElement('style');
    styleEl.id = 'ag-pulse-font-popover-style';
    styleEl.textContent = FONT_CONTROL_CSS;
    document.head.append(styleEl);
  }

  const theme = createAgPulseTheme();
  let themeController = theme.attach(document.documentElement);

  const language = createDashboardI18n(localGet('ag-pulse-language'));
  const t = language.t;
  const host = panelWin.sidecar;
  if (!host) document.body.classList.add('standalone');

  const state: PanelState = {
    snapshot: null,
    selectedGroup: localGet('ag-pulse-group'),
    group: null,
    pending: false,
    timer: null,
    serverOffset: 0,
    lastExpiredRefresh: 0,
    selectedCard: 'speed',
    lastQuotaSig: null,
    refreshRequest: null,
    manualRequest: null,
    syncingFromRefresh: false,
    lastThemeKey: null,
    lastLocalizedKey: null,
    mixMetric: 'total',
    mixScope: 'session',
    mixScopeManual: false,
    mixActiveId: null,
    mixHoverId: null,
    lastMixSig: null,
    mixDisplayModels: [],
    timelineEnabled: false,
    timelineEpoch: 0,
    timelineBusy: false,
    timelineNoticeKey: null,
    timelineNoticeIsError: false,
    lastTimelineSig: null,
    lastTimelineRender: [],
    lastTimelineClearAt: 0,
    pinnedSwimlaneIdx: -1,
    lastTaskId: null,
    lastSubagentsSig: null,
    treeState: new Map(),
    detailState: new Set(),
    timelineToggled: new Map(),
  };

  let ctx!: PanelDomContext;
  let controller!: ReturnType<typeof createPanelController>;
  let localUsage: UsageDashboardHandle | null = null;
  let usageThemeController: ReturnType<typeof theme.attach> | null = null;
  type UsageDashboardFactory = (options: UsageDashboardOptions) => UsageDashboardHandle;
  type PanelWindowWithUsage = PanelWindow & {
    __agPulseUsageFactory?: UsageDashboardFactory;
  };
  let usageFactoryPromise: Promise<UsageDashboardFactory> | null = null;
  let pageDisposed = false;

  const resolveUsageUiUrl = (): string => {
    const version = document.querySelector('meta[name="ag-pulse-panel-assets"]')?.getAttribute('content');
    return version ? `/usage-ui.js?v=${encodeURIComponent(version)}` : '/usage-ui.js';
  };

  const loadUsageFactory = (): Promise<UsageDashboardFactory> => {
    const winWithUsage = panelWin as PanelWindowWithUsage;
    if (typeof winWithUsage.__agPulseUsageFactory === 'function') {
      return Promise.resolve(winWithUsage.__agPulseUsageFactory);
    }
    if (usageFactoryPromise) return usageFactoryPromise;

    usageFactoryPromise = new Promise<UsageDashboardFactory>((resolve, reject) => {
      const existing = document.querySelector<HTMLScriptElement>('script[data-ag-pulse-usage-ui="1"]');
      const attachTarget = document.head || document.documentElement || document.body;
      if (!attachTarget) {
        reject(new Error('Document unavailable for usage dashboard script'));
        return;
      }
      const script = existing || document.createElement('script');
      let settled = false;
      const cleanup = (): void => {
        script.removeEventListener('load', onLoad);
        script.removeEventListener('error', onError);
      };
      const onLoad = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        const factory = winWithUsage.__agPulseUsageFactory;
        if (typeof factory === 'function') {
          resolve(factory);
        } else {
          script.remove();
          reject(new Error('Usage dashboard factory did not initialize'));
        }
      };
      const onError = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        script.remove();
        reject(new Error('Failed to load /usage-ui.js'));
      };
      script.addEventListener('load', onLoad);
      script.addEventListener('error', onError);
      if (!existing) {
        script.dataset.agPulseUsageUi = '1';
        script.async = true;
        script.src = resolveUsageUiUrl();
        attachTarget.append(script);
      }
    }).catch((err) => {
      usageFactoryPromise = null;
      throw err;
    });

    return usageFactoryPromise;
  };

  const render = (): void => {
    const snapshot = state.snapshot;
    if (!snapshot) return;
    const speed = snapshot.speed;

    renderQuotaAndSpeedSections(ctx, snapshot);

    const activeConvId = speed?.modelTimeline?.cascadeId || speed?.conversationId || snapshot.conversationId || null;
    if (activeConvId && activeConvId !== state.lastTaskId) {
      state.treeState.clear();
      state.detailState.clear();
      state.timelineToggled.clear();
      state.mixScopeManual = false;
      state.mixActiveId = null;
      state.mixHoverId = null;
      state.lastTaskId = activeConvId;
      state.lastSubagentsSig = null;
      state.lastMixSig = null;
      state.lastTimelineSig = null;
    }

    renderModelMix(ctx, speed);
    renderSubagentsSection(ctx, snapshot);
    renderTimeline(ctx, speed);

    setHidden(ctx.$('cache-note'), true);
    const dot = ctx.$('connection-dot');
    const dotClass = `connection-dot ${snapshot.connection}`;
    if (dot && dot.className !== dotClass) dot.className = dotClass;
    setAttr(dot, 'title', t(snapshot.connection === 'live' ? 'live' : snapshot.connection === 'stale' ? 'stale' : 'offline'));

    const timestamp = snapshot.quotaUpdatedAt ? formatClock(ctx, snapshot.quotaUpdatedAt) : null;
    const healthNote = ctx.$('health-note');
    setText(
      healthNote,
      language.errorMessage(snapshot.error || snapshot.sessionError) ||
        (timestamp ? t('health', { time: timestamp }) : t('firstUpdate')),
    );
    healthNote?.classList.toggle('warning', snapshot.connection !== 'live' || Boolean(snapshot.sessionError));

    const integration = snapshot.integration;
    const activePortPresent = Boolean(integration?.activePortPresent);
    const debugEnabled =
      integration?.debugLaunchEnabled ??
      (snapshot.preferences && !('error' in snapshot.preferences) ? snapshot.preferences.debugLaunchEnabled : false);
    let integrationMsg = '';
    if (integration && !['mounted', 'disabled'].includes(integration.state)) {
      if (activePortPresent) {
        integrationMsg =
          language.language === 'zh-CN'
            ? '内嵌栏正在自动重连；此面板仍可查看统计。'
            : 'Inline widget is reconnecting automatically; statistics remain available in this panel.';
      } else if (debugEnabled) {
        integrationMsg = t('integrationRestartHint');
      }
    }
    setText(ctx.$('integration-note'), integrationMsg);
    handleUpdateCountdowns();
  };

  const handleUpdateCountdowns = (forceDom = false): void => {
    updateCountdowns(
      ctx,
      () => {
        setTimeout(() => void controller.refresh(true), 0);
      },
      { forceDom },
    );
  };

  ctx = {
    state,
    language,
    preferences: null as never,
    themeController,
    setThemeController: (next) => {
      themeController = next;
      ctx.themeController = next;
    },
    setPreferences: (next) => { ctx.preferences = next; },
    host,
    $: createDomLookup(),
    localGet,
    localSet,
  };

  controller = createPanelController(ctx, {
    render,
    updateCountdowns: () => handleUpdateCountdowns(),
    isUsageOpen: () => Boolean(localUsage?.isOpen),
    onTheme: (hostTheme) => {
      usageThemeController?.setHostTheme(hostTheme ?? null);
    },
    onUsage: (usage) => {
      if (localUsage?.isOpen) localUsage.update(usage);
    },
  });
  ctx.preferences = controller.connectPreferences();

  const showCard = createCardSwitcher(ctx);
  bindSubagentEvents(ctx);
  bindModelMixEvents(ctx, render);

  const quotaPill = ctx.$('quota-rings-pill');
  const quotaPopover = ctx.$('quota-popover');
  let quotaCloseTimer: ReturnType<typeof setTimeout> | null = null;
  let quotaResizeRaf: number | null = null;
  let quotaPinned = false;
  const positionQuotaPopoverFallback = (): void => {
    if (!quotaPill || !quotaPopover || CSS.supports('position-area', 'block-end')) return;
    const r = quotaPill.getBoundingClientRect();
    const pw = quotaPopover.offsetWidth || 256;
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const left = Math.max(8, Math.min(vw - pw - 8, r.right - pw));
    quotaPopover.style.left = `${Math.round(left)}px`;
    quotaPopover.style.top = `${Math.round(r.bottom + 6)}px`;
  };
  const isQuotaOpen = (): boolean => Boolean(quotaPopover?.matches(':popover-open')) || quotaPill?.getAttribute('aria-expanded') === 'true';
  const openQuotaPopover = (): void => {
    if (!quotaPill || !quotaPopover) return;
    if (quotaCloseTimer) { clearTimeout(quotaCloseTimer); quotaCloseTimer = null; }
    handleUpdateCountdowns(true);
    if (!quotaPopover.matches(':popover-open')) {
      quotaPopover.style.display = '';
      try { quotaPopover.showPopover(); } catch { quotaPopover.style.display = 'block'; }
    }
    positionQuotaPopoverFallback();
    setAttr(quotaPill, 'aria-expanded', 'true');
  };
  const closeQuotaPopoverNow = (): void => {
    quotaPinned = false;
    if (quotaCloseTimer) { clearTimeout(quotaCloseTimer); quotaCloseTimer = null; }
    if (quotaResizeRaf !== null) { cancelAnimationFrame(quotaResizeRaf); quotaResizeRaf = null; }
    if (quotaPopover && typeof quotaPopover.hidePopover === 'function') {
      if (quotaPopover.matches(':popover-open')) {
        try { quotaPopover.hidePopover(); } catch { quotaPopover.style.display = 'none'; }
      }
    } else if (quotaPopover) {
      quotaPopover.style.display = 'none';
    }
    setAttr(quotaPill, 'aria-expanded', 'false');
  };
  const scheduleCloseQuotaPopover = (): void => {
    if (quotaPinned) return;
    if (quotaCloseTimer) clearTimeout(quotaCloseTimer);
    quotaCloseTimer = setTimeout(closeQuotaPopoverNow, 120);
  };
  quotaPill?.addEventListener('pointerenter', openQuotaPopover);
  quotaPill?.addEventListener('pointerleave', scheduleCloseQuotaPopover);
  quotaPill?.addEventListener('focus', openQuotaPopover);
  quotaPill?.addEventListener('blur', scheduleCloseQuotaPopover);
  quotaPill?.addEventListener('click', (event) => {
    event.stopPropagation();
    if (quotaPinned && isQuotaOpen()) {
      closeQuotaPopoverNow();
    } else {
      quotaPinned = true;
      openQuotaPopover();
    }
  });
  quotaPopover?.addEventListener('pointerenter', () => {
    if (quotaCloseTimer) { clearTimeout(quotaCloseTimer); quotaCloseTimer = null; }
  });
  quotaPopover?.addEventListener('pointerleave', scheduleCloseQuotaPopover);
  const onDocQuotaPointerDown = (event: PointerEvent): void => {
    if (!isQuotaOpen() || !quotaPill || !quotaPopover) return;
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
    if (path.includes(quotaPopover) || path.includes(quotaPill)) return;
    closeQuotaPopoverNow();
  };
  const onDocQuotaKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && isQuotaOpen()) {
      closeQuotaPopoverNow();
      quotaPill?.focus();
    }
  };
  const onQuotaResize = (): void => {
    if (!isQuotaOpen() || quotaResizeRaf !== null) return;
    quotaResizeRaf = requestAnimationFrame(() => {
      quotaResizeRaf = null;
      if (isQuotaOpen()) positionQuotaPopoverFallback();
    });
  };
  document.addEventListener('pointerdown', onDocQuotaPointerDown, true);
  document.addEventListener('keydown', onDocQuotaKeyDown, true);
  window.addEventListener('resize', onQuotaResize, { passive: true });

  ctx.$('timeline-enable-btn')?.addEventListener('click', () => { void controller.setTimelineEnabled(true); });
  ctx.$('timeline-disable-btn')?.addEventListener('click', () => {
    state.pinnedSwimlaneIdx = -1;
    void controller.setTimelineEnabled(false);
  });
  ctx.$('timeline-clear-btn')?.addEventListener('click', () => {
    state.pinnedSwimlaneIdx = -1;
    void controller.clearTimelineData();
  });

  const swimlanesEl = ctx.$('timeline-swimlanes');
  swimlanesEl?.addEventListener('pointerover', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const seg = target?.closest<HTMLElement>('.timeline-seg[data-seg-idx]');
    if (seg) showSwimlaneTip(ctx, Number(seg.dataset.segIdx));
  });
  swimlanesEl?.addEventListener('pointerleave', () => showSwimlaneTip(ctx, state.pinnedSwimlaneIdx));
  swimlanesEl?.addEventListener('focusin', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const seg = target?.closest<HTMLElement>('.timeline-seg[data-seg-idx]');
    if (seg) showSwimlaneTip(ctx, Number(seg.dataset.segIdx));
  });
  swimlanesEl?.addEventListener('focusout', (event) => {
    if (!swimlanesEl.contains(event.relatedTarget as Node | null)) showSwimlaneTip(ctx, state.pinnedSwimlaneIdx);
  });
  swimlanesEl?.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const segEl = target?.closest<HTMLElement>('.timeline-seg[data-seg-idx]');
    if (!segEl) return;
    const idx = Number(segEl.dataset.segIdx);
    state.pinnedSwimlaneIdx = state.pinnedSwimlaneIdx === idx ? -1 : idx;
    showSwimlaneTip(ctx, state.pinnedSwimlaneIdx >= 0 ? state.pinnedSwimlaneIdx : idx);
    const segData = state.lastTimelineRender[idx];
    if (segData?.stepStart != null) focusTimelineNodeByStep(ctx, segData.stepStart);
  });
  ctx.$('timeline-tree')?.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const row = target?.closest<HTMLElement>('.timeline-node-row');
    const nodeEl = row?.closest<HTMLElement>('.timeline-node');
    const btn = row?.querySelector<HTMLElement>(':scope > .timeline-toggle-btn');
    const kids = nodeEl?.querySelector<HTMLElement>(':scope > .timeline-children');
    if (!btn || !kids || !nodeEl?.dataset.nodeId) return;
    const expanded = btn.getAttribute('aria-expanded') !== 'true';
    state.timelineToggled.set(nodeEl.dataset.nodeId, !expanded);
    setAttr(btn, 'aria-expanded', String(expanded));
    setExpandedState(kids, expanded, true);
  });

  ctx.$('refresh-button')?.addEventListener('click', controller.refreshManually);
  const settingsTrigger = ctx.$<HTMLButtonElement>('settings-button');
  if (settingsTrigger) {
    ctx.settingsPopover = createSettingsPopover({
      trigger: settingsTrigger,
      mountRoot: document.body,
      language,
      initialPreferences: { sidebarFontScale: resolveFontScale(localGet('ag-pulse-sidebar-font-scale')) },
      onFontChange: async (update, next) => {
        applySidebarFontScale(next.sidebarFontScale);
        controller.syncFontScaleCache(next.sidebarFontScale);
        localSet('ag-pulse-sidebar-font-scale', String(next.sidebarFontScale));
        try {
          const saved = await controller.savePreferences(update);
          if (saved && !('error' in saved)) {
            ctx.settingsPopover?.syncPreferences(saved);
            localUsage?.syncPreferences?.(saved);
            applySidebarFontScale(saved.sidebarFontScale);
            const resolved = resolveFontScale(saved.sidebarFontScale);
            controller.syncFontScaleCache(resolved);
            localSet('ag-pulse-sidebar-font-scale', String(resolved));
          }
        } catch {
          // Keep optimistic preview if offline/standalone.
        }
      },
      onSelectLanguage: async (lang) => {
        await ctx.preferences.choose(lang);
        ctx.settingsPopover?.syncLanguage(language.language, ctx.preferences.error);
        ctx.settingsPopover?.localize();
      },
      onToggleDebugLaunch: async (nextEnabled) => {
        ctx.settingsPopover?.syncDebugLaunch({ busy: true, error: null });
        try {
          const result = await controller.apiJson<{
            enabled?: boolean;
            configured?: boolean;
            activePortPresent?: boolean;
            platform?: string | null;
            preferences?: PreferencesSnapshot;
          }>('/api/debug-launch', { enabled: nextEnabled });
          const finalEnabled = result.enabled ?? nextEnabled;
          if (result.preferences && !('error' in result.preferences)) {
            ctx.preferences.sync(result.preferences);
            ctx.settingsPopover?.syncPreferences(result.preferences);
            if (state.snapshot) state.snapshot.preferences = result.preferences;
          }
          if (state.snapshot?.integration) {
            state.snapshot.integration.debugLaunchEnabled = finalEnabled;
            state.snapshot.integration.debugLaunchConfigured = Boolean(result.configured);
            state.snapshot.integration.activePortPresent = Boolean(result.activePortPresent);
          }
          ctx.settingsPopover?.syncDebugLaunch({
            enabled: finalEnabled,
            configured: Boolean(result.configured),
            activePortPresent: Boolean(result.activePortPresent),
            platform: result.platform ?? null,
            busy: false,
            error: null,
          });
          if (state.snapshot) render();
          void controller.refresh(false);
        } catch (err) {
          ctx.settingsPopover?.syncDebugLaunch({
            busy: false,
            error: err instanceof Error ? err.message : t('debugLaunchFailed'),
          });
        }
      },
      onRefreshDebugLaunch: async () => {
        try {
          const [statusRes, accRes] = await Promise.allSettled([
            controller.apiJson<{
              enabled?: boolean;
              configured?: boolean;
              activePortPresent?: boolean;
              platform?: string | null;
            }>('/api/debug-launch'),
            controller.apiJson<{
              active?: string | null;
              selected?: string | null;
              localMode?: boolean;
              accounts?: unknown;
            }>('/api/usage/recording-account'),
          ]);
          if (statusRes.status === 'fulfilled') {
            const status = statusRes.value;
            ctx.settingsPopover?.syncDebugLaunch({
              ...(typeof status.enabled === 'boolean' ? { enabled: status.enabled } : {}),
              ...(typeof status.configured === 'boolean' ? { configured: status.configured } : {}),
              ...(typeof status.activePortPresent === 'boolean' ? { activePortPresent: status.activePortPresent } : {}),
              platform: status.platform ?? null,
              error: null,
            });
          }
          if (accRes.status === 'fulfilled') {
            const acc = accRes.value;
            const list = Array.isArray(acc.accounts)
              ? acc.accounts
              : (acc.accounts as { accounts?: unknown[] } | null)?.accounts || [];
            ctx.settingsPopover?.syncRecordingAccount({
              active: acc.active ?? null,
              selected: acc.selected ?? null,
              localMode: Boolean(acc.localMode),
              accounts: list as never[],
              busy: false,
              error: null,
            });
          }
        } catch {
          // Non-fatal in standalone/offline mode.
        }
      },
      onSelectRecordingAccount: async (scope) => {
        ctx.settingsPopover?.syncRecordingAccount({ busy: true, error: null, notice: null });
        try {
          const acc = await controller.apiJson<{
            active?: string | null;
            selected?: string | null;
            localMode?: boolean;
            accounts?: unknown;
          }>('/api/usage/recording-account', { scope });
          const list = Array.isArray(acc.accounts)
            ? acc.accounts
            : (acc.accounts as { accounts?: unknown[] } | null)?.accounts || [];
          ctx.settingsPopover?.syncRecordingAccount({
            active: acc.active ?? null,
            selected: acc.selected ?? null,
            localMode: Boolean(acc.localMode),
            accounts: list as never[],
            busy: false,
            error: null,
            notice: t('recordingAccountSaved'),
          });
          await controller.refresh(true, { includeUsage: Boolean(localUsage?.isOpen) });
        } catch (err) {
          ctx.settingsPopover?.syncRecordingAccount({
            busy: false,
            error: err instanceof Error ? err.message : t('recordingAccountFailed'),
          });
        }
      },
      onAddRecordingAccount: async (identifier) => {
        ctx.settingsPopover?.syncRecordingAccount({ busy: true, error: null, notice: null });
        try {
          const res = await controller.apiJson<{
            active?: string | null;
            selected?: string | null;
            accounts?: unknown;
          }>('/api/usage/accounts/add', { identifier, activate: true });
          const list = Array.isArray(res.accounts)
            ? res.accounts
            : (res.accounts as { accounts?: unknown[] } | null)?.accounts || [];
          ctx.settingsPopover?.syncRecordingAccount({
            active: res.active ?? null,
            selected: res.selected ?? null,
            accounts: list as never[],
            busy: false,
            error: null,
            notice: t('recordingAccountSaved'),
          });
          await controller.refresh(true, { includeUsage: Boolean(localUsage?.isOpen) });
        } catch (err) {
          ctx.settingsPopover?.syncRecordingAccount({
            busy: false,
            error: err instanceof Error ? err.message : t('recordingAccountFailed'),
          });
        }
      },
    });
  }

  const ensureLocalUsage = (createUsageDashboard: UsageDashboardFactory): UsageDashboardHandle => {
    if (localUsage) return localUsage;
    const usageHost = ctx.$('panel-usage-host') || document.body;
    const shadow = usageHost.shadowRoot || usageHost.attachShadow({ mode: 'open' });
    usageThemeController = theme.attach(usageHost);
    usageThemeController.setHostTheme(state.snapshot?.theme ?? null);
    const usageBridge: Partial<RuntimeBridgeApi> = {
      getPreferences: () => controller.apiJson('/api/preferences'),
      setPreferences: (input) => controller.apiJson('/api/preferences', input),
      getAccounts: () => controller.apiJson('/api/usage/accounts', {}),
      switchAccount: (input) => controller.apiJson('/api/usage/switch-account', input),
      getRecordingAccount: () => controller.apiJson('/api/usage/recording-account'),
      setRecordingAccount: (input) => controller.apiJson('/api/usage/recording-account', input),
      addAccount: (input) => controller.apiJson('/api/usage/accounts/add', input),
      reassignConversation: (input) => controller.apiJson('/api/usage/reassign-conversation', input),
      addManualUsage: (input) => controller.apiJson('/api/usage/manual/add', input),
      deleteManualUsage: (input) => controller.apiJson('/api/usage/manual/delete', input),
      getProjectUsage: (input) => controller.apiJson('/api/usage/project-overview', input),
      getProjectDetail: (input) => controller.apiJson('/api/usage/project-detail', input),
    };
    const currentPrefs =
      state.snapshot?.preferences && !('error' in state.snapshot.preferences)
        ? state.snapshot.preferences
        : undefined;
    localUsage = createUsageDashboard({
      root: shadow,
      language,
      setMarkup,
      hostLabel: 'Antigravity',
      bridge: usageBridge,
      initialPreferences: currentPrefs,
      guideDismissed: Boolean(currentPrefs?.usageGuideDismissed),
      onDismissGuide: async () => {
        const saved = await controller.savePreferences({ usageGuideDismissed: true });
        if (saved && !('error' in saved)) {
          ctx.preferences.sync(saved);
          localUsage?.syncGuideDismissed();
        }
      },
      onLanguage: async (next) => {
        await ctx.preferences.choose(next);
        if (state.snapshot?.usage) localUsage?.update(state.snapshot.usage);
      },
      onRefresh: async () => {
        await controller.refresh(true, { includeUsage: true });
        if (state.snapshot?.usage) localUsage?.update(state.snapshot.usage);
      },
      onPreferencesSaved: (saved) => {
        ctx.preferences.sync(saved);
        ctx.settingsPopover?.syncPreferences(saved);
        if ('sidebarFontScale' in saved) {
          const scale = resolveFontScale(saved.sidebarFontScale);
          applySidebarFontScale(scale);
          controller.syncFontScaleCache(scale);
          localSet('ag-pulse-sidebar-font-scale', String(scale));
        }
      },
    });
    return localUsage;
  };

  let countdownTimer: ReturnType<typeof setInterval> | null = null;
  const startCountdownTimer = (): void => {
    if (countdownTimer !== null || document.hidden) return;
    countdownTimer = setInterval(() => handleUpdateCountdowns(false), 1000);
  };
  const stopCountdownTimer = (): void => {
    if (countdownTimer !== null) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  };

  const openUsageBtn = ctx.$<HTMLButtonElement>('open-usage-button');
  openUsageBtn?.addEventListener('click', () => {
    if (openUsageBtn.disabled) return;
    openUsageBtn.disabled = true;
    void (async () => {
      try {
        try {
          const res = await controller.apiJson<{ openedInHost?: boolean }>('/api/usage/open', {});
          if (res?.openedInHost) return;
        } catch {
          // Fall back to embedded local usage modal when host CDP modal is unavailable.
        }
        const [usageFactory] = await Promise.all([
          loadUsageFactory(),
          state.snapshot?.usage ? Promise.resolve() : controller.refresh(true, { includeUsage: true }),
        ]);
        if (pageDisposed || !state.snapshot?.usage) return;
        const dashboard = ensureLocalUsage(usageFactory);
        dashboard.open(state.snapshot.usage, openUsageBtn);
      } catch (err) {
        const note = ctx.$('health-note');
        if (note) {
          setText(note, err instanceof Error ? err.message : t('panelUnavailable'));
          note.classList.add('warning');
        }
      } finally {
        openUsageBtn.disabled = false;
      }
    })();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopCountdownTimer();
    } else {
      startCountdownTimer();
      handleUpdateCountdowns(false);
      void controller.refresh();
    }
  });
  window.addEventListener('pagehide', () => {
    pageDisposed = true;
    closeQuotaPopoverNow();
    stopCountdownTimer();
    controller.stopTimers();
    document.removeEventListener('pointerdown', onDocQuotaPointerDown, true);
    document.removeEventListener('keydown', onDocQuotaKeyDown, true);
    window.removeEventListener('resize', onQuotaResize);
    ctx.settingsPopover?.dispose();
    localUsage?.dispose();
    localUsage = null;
    usageThemeController?.dispose();
    usageThemeController = null;
    ctx.themeController.dispose();
    ctx.preferences.dispose();
  });
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    pageDisposed = false;
    ctx.setThemeController(theme.attach(document.documentElement));
    ctx.setPreferences(controller.connectPreferences());
    document.addEventListener('pointerdown', onDocQuotaPointerDown, true);
    document.addEventListener('keydown', onDocQuotaKeyDown, true);
    window.addEventListener('resize', onQuotaResize, { passive: true });
    startCountdownTimer();
    controller.resumeTimers();
    void controller.refresh();
  });

  startCountdownTimer();
  controller.localize();
  showCard('speed');
  syncPinBottom(ctx);
  void controller.refresh();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initPanel, { once: true });
else initPanel();
