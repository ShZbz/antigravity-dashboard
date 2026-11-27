import type { QuotaGroup, RuntimeBridgeApi } from '../../contracts/index.ts';
import { resolveFontScale } from '../../contracts/preferences.ts';
import { setMarkup as sharedSetMarkup } from '../../shared/dom.ts';
import { CardInteractionController } from './card-interactions.ts';
import {
  localizeWidgetTree,
  parkUsageModalNode,
  prepareComposerMatch,
  reattachWidgetNode,
} from './cards.ts';
import {
  captureNative,
  findComposer,
  nativeComfortable,
  openHostSidebar,
  reserveNativeSpace,
  resolveConversationId,
} from './composer-probe.ts';
import { DensityMotionController } from './density-motion.ts';
import {
  connectWidgetPreferences,
  LanguageGuideController,
  localGet,
  localSet,
  observeComposerElements,
} from './language-guide.ts';
import { bindHostLifecycleListeners, mountWidgetShadowDom, renderWidgetTree } from './mount-dom.ts';
import { WidgetPollingState } from './polling-state.ts';
import type {
  ComposerMatch,
  UpdateMenuHandle,
  UsageDashboardHandle,
  WidgetThemeController,
  WidgetWindow,
} from './types.ts';

declare const __agPulseSelf: (() => void) | undefined;

export default function installAgPulseInlineWidget(): void {
  const win = window as WidgetWindow;
  if (win.__agPulseInlineInstalled) return;
  if (!document.documentElement) {
    const retry = typeof __agPulseSelf === 'function' ? __agPulseSelf : installAgPulseInlineWidget;
    document.addEventListener('DOMContentLoaded', retry, { once: true });
    return;
  }
  const rawHost = win.agPulseHost;
  if (!rawHost || !win.__agPulseI18nFactory || !win.__agPulseThemeFactory) return;
  const bridgeHost: RuntimeBridgeApi = rawHost;

  const language = win.__agPulseI18nFactory(localGet('ag-pulse-language'));
  const theme = win.__agPulseThemeFactory();
  const surface = win.__agPulseSurface;
  const setMarkup = (element: Element | ShadowRoot, markup: string): void => {
    if (surface?.setMarkup) surface.setMarkup(element, markup);
    else sharedSetMarkup(element, markup);
  };
  win.__agPulseInlineInstalled = true;

  let node: HTMLElement | null = null;
  let root: ShadowRoot | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let themeController: WidgetThemeController | null = null;
  let chosen = localGet('ag-pulse-group');
  let group: QuotaGroup | undefined;
  let composer: ComposerMatch | null = null;
  let layoutFrame: number | null = null;
  let usageDashboard: UsageDashboardHandle | null = null;
  let updateMenu: UpdateMenuHandle | null = null;
  let pendingUsageOpen: Promise<void> | null = null;
  let inlineFontScale = resolveFontScale(localGet('ag-pulse-inline-font-scale'));
  const applyInlineFontScale = (scale: unknown): void => {
    inlineFontScale = resolveFontScale(scale);
    localSet('ag-pulse-inline-font-scale', String(inlineFontScale));
    node?.style.setProperty('--pulse-inline-font-scale', String(inlineFontScale));
  };
  const density = new DensityMotionController();

  const guide = new LanguageGuideController({
    getRoot: () => root,
    getNode: () => node,
    getComposer: () => composer,
    getCardName: () => cards.cardName,
    isDisposed: () => polling.isDisposed,
    onSyncUsageGuide: () => usageDashboard?.syncGuideDismissed(),
    onSavePreferences: (input) => polling.setPreferences(input),
    onSyncPreferences: (value) => preferences.sync(value),
  });

  const cards = new CardInteractionController({
    getRoot: () => root,
    getNode: () => node,
    getComposer: () => composer,
    getConversationId: () => resolveConversationId(composer, surface),
    isDisposed: () => polling.isDisposed,
    isUsageOpen: () => Boolean(usageDashboard?.isOpen),
    guide,
    onChooseLanguage: (choice) => preferences.choose(choice),
    onRefreshManually: () => polling.refreshManually(() => cards.closeGroup()),
    onOpenSidebar: () => openHostSidebar(composer, resolveConversationId(composer, surface), bridgeHost),
  });

  const polling = new WidgetPollingState(bridgeHost, {
    getConversationId: () => resolveConversationId(composer, surface),
    getRoot: () => root,
    getNode: () => node,
    getLanguage: () => language,
    isUsageOpen: () => Boolean(usageDashboard?.isOpen),
    onConversationReset: () => density.reset(node),
    onRender: () => render(),
    onHide: () => cards.hide(),
    onPreferencesSync: (prefs) => {
      guide.sync(prefs);
      preferences.sync(prefs);
      guide.guideReady = !preferences.error;
      if (prefs && 'inlineFontScale' in prefs) {
        applyInlineFontScale(prefs.inlineFontScale);
      }
      if (prefs) usageDashboard?.syncPreferences?.(prefs);
    },
    onThemeSync: (hostTheme) => themeController?.setHostTheme(hostTheme),
  });
  polling.report('boot', { hostFound: true });

  const preferences = connectWidgetPreferences({
    language,
    guide,
    getPreferences: () => polling.getPreferences(),
    setPreferences: (input) => polling.setPreferences(input),
    onApplied: () => {
      if (root) {
        localize();
        render();
        polling.tick(group);
        cards.position();
      }
    },
    onReady: () => scheduleLayout(),
  });

  function localize(): void {
    if (root && node) localizeWidgetTree(root, node, language, preferences, updateMenu, () => guide.update());
  }

  function fit(): void {
    if (!node || !root || !composer) return;
    const activeNode = node;
    const activeComposer = composer;
    density.fit({
      node: activeNode,
      root,
      composer: activeComposer,
      language,
      lastConversation: polling.lastConversation,
      isUsageOpen: Boolean(usageDashboard?.isOpen),
      reserveNativeSpace: () => reserveNativeSpace(activeNode, activeComposer),
      nativeComfortable: () => nativeComfortable(activeComposer),
      hide: () => cards.hide(),
      position: () => cards.position(),
      updateGuide: () => guide.update(),
    });
  }

  function scheduleLayout(): void {
    if (layoutFrame !== null) return;
    layoutFrame = requestAnimationFrame(() => {
      layoutFrame = null;
      mount();
      fit();
      cards.position();
    });
  }

  function observeComposer(): void {
    resizeObserver = observeComposerElements(resizeObserver, scheduleLayout, node, composer);
  }

  function unmountWidget(): void {
    density.reset(node);
    composer = null;
    resizeObserver?.disconnect();
    pendingUsageOpen = null;
    if (!node) return;
    cards.hide();
    usageDashboard?.dispose();
    updateMenu?.dispose();
    themeController?.dispose();
    node.remove();
    usageDashboard = null;
    updateMenu = null;
    themeController = null;
    node = null;
    root = null;
    // A disposed dialog cannot be reused with its old strip/listeners.
    // Invalidate this mount's pending requests and rebuild on discovery.
    polling.invalidateEpoch();
  }

  function openUsage(trigger: Element | null): boolean {
    if (!usageDashboard || polling.isDisposed || !node?.isConnected) return false;
    cards.hide();
    if (polling.data?.usage) {
      usageDashboard.open(polling.data.usage, trigger);
      return true;
    }
    if (pendingUsageOpen) return true;
    const activeNode = node;
    const activeDashboard = usageDashboard;
    const activeConversation = polling.lastConversation;
    let req: Promise<void> | null = null;
    req = polling
      .fetchUsage()
      .then((usage) => {
        if (
          polling.isDisposed ||
          !activeNode.isConnected ||
          node !== activeNode ||
          usageDashboard !== activeDashboard ||
          polling.lastConversation !== activeConversation ||
          !usage
        ) {
          return;
        }
        cards.hide();
        activeDashboard.open(usage, trigger);
      })
      .catch(() => {
        // Non-fatal; next click or poll can retry.
      })
      .finally(() => {
        if (pendingUsageOpen === req) {
          pendingUsageOpen = null;
        }
      });
    pendingUsageOpen = req;
    return true;
  }

  function mount(): void {
    // Account usage does not belong to a composer lifecycle. Keep its frame
    // during reflows and park the host if the app replaces the input subtree.
    if (parkUsageModalNode(node, usageDashboard)) return;

    const found = findComposer(composer, surface);
    if (!found) { unmountWidget(); return; }
    composer = prepareComposerMatch(
      found, composer, (f) => captureNative(f, surface), surface ? (f) => surface.nativeReserve(f) : undefined,
    );
    if (polling.syncConversation()) render();

    const { row, branch } = found;
    if (node) node.dataset.scope = found.kind;
    if (node?.isConnected && node.parentElement === row && node.previousElementSibling === branch) return;
    if (node) {
      themeController = reattachWidgetNode({
        node, found, theme, themeController, hostTheme: polling.data?.theme,
        resetDensity: () => density.reset(node), hideCards: () => cards.hide(),
        observeComposer, fit, position: () => cards.position(),
      });
      return;
    }

    resizeObserver?.disconnect();
    const mounted = mountWidgetShadowDom({
      win, found, theme, language, surface, bridgeHost, setMarkup, cards, guide, polling,
      onChooseLanguage: (next) => preferences.choose(next),
      onFontScaleChange: (prefs) => {
        if ('inlineFontScale' in prefs) applyInlineFontScale(prefs.inlineFontScale);
        guide.sync(prefs);
        preferences.sync(prefs);
      },
      onObserveComposer: observeComposer,
      onOpenUsage: openUsage,
    });
    ({ node, root, themeController, updateMenu, usageDashboard } = mounted);
    applyInlineFontScale(inlineFontScale);
    localize();
    render();
    void polling.refresh();
  }

  function render(): void {
    if (!root) return;
    const nextGroup = renderWidgetTree({
      root, polling, usageDashboard, cards, chosen, composer, surface, language,
      onSelectGroup: (groupId, trigger) => {
        chosen = groupId;
        localSet('ag-pulse-group', chosen);
        cards.closeGroup();
        render();
        trigger?.focus({ preventScroll: true });
      },
      onAfterRender: (activeGroup) => { polling.tick(activeGroup); fit(); cards.position(); },
    });
    if (nextGroup !== undefined) group = nextGroup;
  }

  const isGuideVisible = (): boolean => {
    const tip = root?.getElementById('language-guide') as HTMLElement | null;
    return Boolean(tip && !tip.hidden);
  };
  const unbindHost = bindHostLifecycleListeners({
    getNode: () => node,
    shouldTrackScroll: () => cards.cardName !== null || isGuideVisible(),
    scheduleLayout,
    hideCards: () => cards.hide(),
  });
  const runHeartbeat = (): void => {
    if (document.hidden) return;
    mount();
    fit();
    polling.tick(group);
    cards.position();
    polling.pollIfDue();
  };
  const onVisibilityChange = (): void => {
    if (!document.hidden) runHeartbeat();
  };
  document.addEventListener('visibilitychange', onVisibilityChange);
  const timerId = setInterval(runHeartbeat, 1000);

  win.__agPulseOpenUsage = () => openUsage(null);

  win.__agPulseDispose = () => {
    pendingUsageOpen = null;
    polling.dispose();
    density.dispose(node);
    clearInterval(timerId);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    cards.disposeTimers();
    if (layoutFrame !== null) cancelAnimationFrame(layoutFrame);
    unbindHost();
    resizeObserver?.disconnect();
    themeController?.dispose();
    preferences.dispose();
    cards.hide();
    usageDashboard?.dispose();
    updateMenu?.dispose();
    node?.remove();
    document.removeEventListener('DOMContentLoaded', mount);
    node = null;
    root = null;
    composer = null;
    win.__agPulseInlineInstalled = false;
    delete win.__agPulseOpenUsage;
    delete win.__agPulseDispose;
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
}
