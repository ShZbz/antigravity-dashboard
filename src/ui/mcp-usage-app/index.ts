import { App } from '@modelcontextprotocol/ext-apps';
import type {
  HostThemeConfig,
  LanguageCode,
  PreferencesSnapshot,
  UsageSummarySnapshot,
} from '../../contracts/index.ts';
import { setMarkup } from '../../shared/dom.ts';
import createDashboardI18n from '../i18n/index.ts';
import createUsageDashboard, { type UsageDashboardHandle } from '../usage-modal/index.ts';
import {
  createMcpUsageBridge,
  unwrapMcpToolPayload,
  type McpInitialSnapshot,
  type McpOpenDashboardResult,
} from './bridge.ts';
import { createMcpThemeBridge } from './theme-bridge.ts';

function detectLocaleLanguage(locale?: string | null): LanguageCode {
  const candidate = (locale || (typeof navigator !== 'undefined' ? navigator.language : '') || '').toLowerCase();
  return candidate.startsWith('zh') ? 'zh-CN' : 'en';
}

function ensureHostElement(): HTMLElement {
  const existing = document.getElementById('mcp-usage-root');
  if (existing) {
    existing.style.width = '100%';
    existing.style.height = '100%';
    existing.style.display = 'block';
    return existing;
  }
  const host = document.createElement('div');
  host.id = 'mcp-usage-root';
  host.style.width = '100%';
  host.style.height = '100%';
  host.style.display = 'block';
  document.body.append(host);
  return host;
}

const STATUS_STYLE = `
.mcp-usage-status{display:grid;place-items:center;height:100%;padding:24px;box-sizing:border-box;background:var(--pulse-background,#1c1d1f);color:var(--pulse-muted,#adb2ba);font:13px/1.5 var(--pulse-font,system-ui,-apple-system,sans-serif);text-align:center}
.mcp-usage-status[hidden]{display:none}
.mcp-usage-status-card{display:flex;flex-direction:column;align-items:center;gap:12px;max-width:420px}
.mcp-usage-status-msg{color:var(--pulse-foreground,#e1e3e7)}
.mcp-usage-retry{padding:6px 14px;border-radius:8px;border:1px solid var(--pulse-border,#41454d);background:var(--pulse-control,#383b3f);color:var(--pulse-foreground,#e1e3e7);font:inherit;cursor:pointer}
.mcp-usage-retry:hover{background:var(--pulse-hover,#292b2e)}
`.trim();

function initMcpUsageApp(): void {
  const hostEl = ensureHostElement();
  const shadowRoot = hostEl.shadowRoot || hostEl.attachShadow({ mode: 'open' });
  const themeBridge = createMcpThemeBridge(hostEl, shadowRoot);

  const statusStyle = document.createElement('style');
  statusStyle.textContent = STATUS_STYLE;
  const statusWrap = document.createElement('div');
  statusWrap.className = 'mcp-usage-status';
  const statusCard = document.createElement('div');
  statusCard.className = 'mcp-usage-status-card';
  const statusMsg = document.createElement('div');
  statusMsg.className = 'mcp-usage-status-msg';
  const retryBtn = document.createElement('button');
  retryBtn.type = 'button';
  retryBtn.className = 'mcp-usage-retry';
  retryBtn.hidden = true;
  statusCard.append(statusMsg, retryBtn);
  statusWrap.append(statusCard);
  shadowRoot.append(statusStyle, statusWrap);

  const i18n = createDashboardI18n(detectLocaleLanguage());
  const app = new App({ name: 'Antigrative Dashboard', version: '0.12.8' }, {});
  const bridge = createMcpUsageBridge(app);

  let dashboard: UsageDashboardHandle | null = null;
  let currentUsage: UsageSummarySnapshot | null = null;
  let currentPrefs: PreferencesSnapshot | null = null;
  let explicitLanguageSet = false;
  let sawToolInput = false;
  let snapshotPromise: Promise<void> | null = null;
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

  const w = (zh: string, en: string): string => (i18n.language === 'zh-CN' ? zh : en);

  const renderStatus = (mode: 'loading' | 'empty' | 'error', detail?: string): void => {
    if (dashboard) {
      statusWrap.hidden = true;
      return;
    }
    statusWrap.hidden = false;
    if (mode === 'loading') {
      statusMsg.textContent = w('正在加载 Token 用量统计…', 'Loading token usage dashboard…');
      retryBtn.hidden = true;
    } else if (mode === 'empty') {
      statusMsg.textContent = w('暂未收到用量数据，请重试。', 'No usage snapshot available yet.');
      retryBtn.textContent = w('重新加载', 'Retry');
      retryBtn.hidden = false;
    } else {
      statusMsg.textContent = detail || w('加载用量数据失败，请重试。', 'Failed to load usage dashboard.');
      retryBtn.textContent = w('重新加载', 'Retry');
      retryBtn.hidden = false;
    }
  };

  const syncPreferences = (prefs?: PreferencesSnapshot | null, hostLocale?: string | null): void => {
    if (!prefs || 'error' in prefs) return;
    currentPrefs = prefs;
    if (prefs.language === 'zh-CN' || prefs.language === 'en') {
      i18n.setLanguage(prefs.language);
    } else if (!explicitLanguageSet && hostLocale) {
      i18n.setLanguage(detectLocaleLanguage(hostLocale));
    }
    if (dashboard) {
      dashboard.syncPreferences?.(prefs);
      if (prefs.usageGuideDismissed) {
        dashboard.syncGuideDismissed();
      }
    }
  };

  const applySnapshot = (payload: McpInitialSnapshot): void => {
    if (payload.theme !== undefined) {
      themeBridge.setHostTheme((payload.theme ?? null) as HostThemeConfig | null);
    }
    if (payload.preferences) {
      syncPreferences(payload.preferences, app.getHostContext()?.locale);
    }
    if (!payload.usage) {
      if (!dashboard) renderStatus('empty');
      return;
    }

    currentUsage = payload.usage;
    statusWrap.hidden = true;
    if (!dashboard) {
      const validPrefs = currentPrefs && !('error' in currentPrefs) ? currentPrefs : undefined;
      dashboard = createUsageDashboard({
        root: shadowRoot,
        language: i18n,
        setMarkup,
        displayMode: 'fullpage',
        hostLabel: 'Antigravity',
        bridge,
        initialPreferences: validPrefs,
        guideDismissed: Boolean(validPrefs?.usageGuideDismissed),
        onDismissGuide: async () => {
          const saved = await bridge.setPreferences({ usageGuideDismissed: true });
          if ('error' in saved) throw new Error(saved.error);
          syncPreferences(saved, app.getHostContext()?.locale);
        },
        onLanguage: async (next) => {
          explicitLanguageSet = true;
          i18n.setLanguage(next);
          if (currentUsage) dashboard?.update(currentUsage);
          try {
            const saved = await bridge.setPreferences({ language: next });
            if (!('error' in saved)) syncPreferences(saved, app.getHostContext()?.locale);
          } catch {
            // Keep responsive local language switch if preference write fails transiently.
          }
        },
        onRefresh: async () => {
          const snap = await bridge.getSnapshot({ force: true });
          if (snap.theme !== undefined) themeBridge.setHostTheme(snap.theme ?? null);
          if (snap.preferences) syncPreferences(snap.preferences, app.getHostContext()?.locale);
          if (snap.usage) {
            currentUsage = snap.usage;
            dashboard?.update(snap.usage);
          }
        },
        onPreferencesSaved: (saved) => {
          syncPreferences(saved, app.getHostContext()?.locale);
        },
      });
      dashboard.open(currentUsage, null);
    } else {
      dashboard.update(currentUsage);
    }
  };

  const loadSnapshot = (force = false): Promise<void> => {
    if (snapshotPromise && !force) return snapshotPromise;
    if (!dashboard) renderStatus('loading');
    const pending = bridge
      .getSnapshot(force ? { force: true } : undefined)
      .then((snap) => {
        applySnapshot(snap);
      })
      .catch((err) => {
        if (!dashboard) {
          const msg = err instanceof Error ? err.message : String(err || '');
          renderStatus('error', msg);
        }
      })
      .finally(() => {
        if (snapshotPromise === pending) snapshotPromise = null;
      });
    snapshotPromise = pending;
    return pending;
  };

  retryBtn.addEventListener('click', () => {
    void loadSnapshot(true);
  });

  const clearFallbackTimer = (): void => {
    if (fallbackTimer !== null) {
      clearTimeout(fallbackTimer);
      fallbackTimer = null;
    }
  };

  // Register all MCP App handlers BEFORE app.connect() so initial notifications are never missed.
  app.ontoolinput = () => {
    sawToolInput = true;
    if (!dashboard) renderStatus('loading');
  };

  app.ontoolresult = (result) => {
    clearFallbackTimer();
    try {
      const payload = unwrapMcpToolPayload(result) as McpOpenDashboardResult | null;
      if (payload && payload.ok === false) {
        if (!dashboard) renderStatus('error', payload.error);
        return;
      }
      if (payload?.initial) {
        applySnapshot(payload.initial);
      }
      if (payload?.deferred || !payload?.initial?.usage) {
        void loadSnapshot(false);
      }
    } catch (err) {
      if (!dashboard) {
        renderStatus('error', err instanceof Error ? err.message : String(err || ''));
      }
    }
  };

  app.ontoolcancelled = (params) => {
    clearFallbackTimer();
    if (!dashboard) {
      renderStatus('error', params?.reason || w('加载已取消。', 'Dashboard load cancelled.'));
    }
  };

  app.onhostcontextchanged = (ctx) => {
    themeBridge.applyHostContext(ctx);
    const hasSavedLang =
      currentPrefs && !('error' in currentPrefs) && (currentPrefs.language === 'zh-CN' || currentPrefs.language === 'en');
    if (ctx.locale && !hasSavedLang && !explicitLanguageSet) {
      const nextLang = detectLocaleLanguage(ctx.locale);
      if (nextLang !== i18n.language) {
        i18n.setLanguage(nextLang);
        if (currentUsage) dashboard?.update(currentUsage);
      }
    }
  };

  window.addEventListener('pagehide', () => {
    clearFallbackTimer();
    dashboard?.dispose();
    dashboard = null;
    themeBridge.dispose();
  });

  renderStatus('loading');

  void app
    .connect()
    .then(() => {
      const hostCtx = app.getHostContext();
      themeBridge.applyHostContext(hostCtx);
      const hasSavedLang =
        currentPrefs && !('error' in currentPrefs) && (currentPrefs.language === 'zh-CN' || currentPrefs.language === 'en');
      if (hostCtx?.locale && !hasSavedLang && !explicitLanguageSet) {
        i18n.setLanguage(detectLocaleLanguage(hostCtx.locale));
      }
      if (!currentUsage && !snapshotPromise) {
        fallbackTimer = setTimeout(() => {
          fallbackTimer = null;
          if (!currentUsage && !snapshotPromise) {
            void loadSnapshot(false);
          }
        }, sawToolInput ? 1500 : 250);
      }
    })
    .catch((err) => {
      clearFallbackTimer();
      if (!dashboard) {
        renderStatus('error', err instanceof Error ? err.message : String(err || ''));
      }
    });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initMcpUsageApp, { once: true });
} else {
  initMcpUsageApp();
}
