import type { LanguageCode, PreferencesSnapshot, QuotaGroup, RuntimeBridgeApi } from '../../contracts/index.ts';
import { setAttr, setText } from '../../shared/dom.ts';
import { compact } from '../../shared/format.ts';
import type { CardInteractionController } from './card-interactions.ts';
import { buildWidgetShellMarkup, toggleHidden } from './cards.ts';
import { WIDGET_CONTAINER_ID } from './composer-probe.ts';
import inlineCss from './inline.css';
import type { LanguageGuideController } from './language-guide.ts';
import { renderGroupSelector, renderModelDonut, renderQuotaSection, selectQuotaGroup } from './model-donut.ts';
import type { WidgetPollingState } from './polling-state.ts';
import { renderSpeedContextCacheCards } from './speed-card.ts';
import type {
  ComposerMatch,
  UpdateMenuHandle,
  UsageDashboardHandle,
  WidgetLanguage,
  WidgetSurface,
  WidgetThemeController,
  WidgetThemeFactory,
  WidgetWindow,
} from './types.ts';

export interface MountShadowDomOptions {
  win: WidgetWindow;
  found: ComposerMatch;
  theme: WidgetThemeFactory;
  language: WidgetLanguage;
  surface: WidgetSurface | undefined;
  bridgeHost: RuntimeBridgeApi;
  setMarkup: (element: Element | ShadowRoot, markup: string) => void;
  cards: CardInteractionController;
  guide: LanguageGuideController;
  polling: WidgetPollingState;
  onChooseLanguage: (next: LanguageCode) => Promise<void>;
  onFontScaleChange?: (prefs: PreferencesSnapshot) => void;
  onObserveComposer: () => void;
  onOpenUsage?: (trigger: Element | null) => boolean | void;
}

export interface MountedShadowHandles {
  node: HTMLElement;
  root: ShadowRoot;
  themeController: WidgetThemeController;
  updateMenu: UpdateMenuHandle | null;
  usageDashboard: UsageDashboardHandle | null;
}

export function mountWidgetShadowDom(options: MountShadowDomOptions): MountedShadowHandles {
  const {
    win,
    found,
    theme,
    language,
    surface,
    bridgeHost,
    setMarkup,
    cards,
    guide,
    polling,
    onChooseLanguage,
    onFontScaleChange,
    onObserveComposer,
  } = options;

  const node = document.createElement('div');
  node.id = WIDGET_CONTAINER_ID;
  node.dataset.scope = found.kind;
  node.style.cssText =
    'display:flex;align-items:center;flex:0 1 auto;min-width:0;max-width:min(100%,var(--pulse-native-room,100%));height:28px;margin:0 5px;position:relative;';
  const root = node.attachShadow({ mode: 'open' });
  setMarkup(root, buildWidgetShellMarkup(theme.shadowCss(), inlineCss, language));
  found.row.insertBefore(node, found.branch.nextSibling);

  for (const card of root.querySelectorAll('.card')) {
    const note = document.createElement('p');
    note.className = 'scope-note';
    note.dataset.i18n = 'subagentStats';
    card.querySelector('.heading')?.after(note);
  }

  const languageRow = document.createElement('div');
  languageRow.className = 'card-language';
  setMarkup(
    languageRow,
    '<span>Language / 语言</span><div class="language-options" role="group" aria-label="Language / 语言"><button type="button" class="language-button" id="card-language-en" data-language-choice="en">English</button><button type="button" class="language-button" id="card-language-zh" data-language-choice="zh-CN">简体中文</button></div>',
  );
  root.getElementById('context-card')?.append(languageRow);

  let updateMenu: UpdateMenuHandle | null = null;
  if (win.__agPulseUpdateFactory && typeof bridgeHost.updatePlugin === 'function') {
    updateMenu = win.__agPulseUpdateFactory({
      root,
      row: languageRow,
      language,
      setMarkup,
      request: (input) => polling.updatePlugin(input),
      onOpen: () => cards.hide(),
    });
  }

  const saveNote = document.createElement('p');
  saveNote.className = 'footnote';
  saveNote.id = 'language-save-note';
  languageRow.after(saveNote);

  const guideEl = document.createElement('section');
  guideEl.className = 'language-guide';
  guideEl.id = 'language-guide';
  guideEl.hidden = true;
  guideEl.setAttribute('role', 'region');
  guideEl.setAttribute('aria-label', 'Language / 语言');
  setMarkup(
    guideEl,
    '<div class="guide-heading"><strong>Language <span>/ 语言</span></strong><button type="button" id="guide-close" aria-label="Dismiss language tip / 关闭语言提示" title="Dismiss / 关闭">×</button></div><button type="button" id="guide-open"><span><span>Switch in context details</span><span lang="zh-CN">在上下文详情中切换语言</span></span><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h9M8 4l4 4-4 4"/></svg></button><p class="footnote" id="guide-save-note"></p>',
  );
  root.append(guideEl);

  // Escape ancestor stacking/paint contexts; ordinary z-index cannot do this.
  if (typeof HTMLElement.prototype.showPopover === 'function') {
    for (const card of root.querySelectorAll('.card')) card.setAttribute('popover', 'manual');
  }
  if (typeof guideEl.showPopover === 'function') guideEl.setAttribute('popover', 'manual');

  const themeController = theme.attach(node, { embedded: true });
  polling.report('mounted', { editorFound: true, composerFound: true });
  onObserveComposer();
  cards.bindShadowInteractions(root, node);

  let usageDashboard: UsageDashboardHandle | null = null;
  if (win.__agPulseUsageFactory) {
    const section = document.createElement('div');
    section.id = 'usage-entry';
    section.hidden = true;
    setMarkup(
      section,
      '<dl class="usage-summary"><div><dt id="usage-today-label"></dt><dd><strong id="usage-today"></strong><span class="usage-unit">Token</span></dd></div><div><dt id="usage-month-label"></dt><dd><strong id="usage-month"></strong><span class="usage-unit">Token</span></dd></div></dl><button type="button" id="open-usage"><span id="usage-open-label"></span><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h10M9 4l4 4-4 4"/></svg></button>',
    );
    root.getElementById('cache-card')?.append(section);
    usageDashboard = win.__agPulseUsageFactory({
      root,
      language,
      setMarkup,
      hostLabel: surface?.usageHostLabel || 'Antigravity',
      guideDismissed: guide.usageGuideDismissed,
      initialPreferences: polling.data?.preferences ?? null,
      onPreferencesSaved: onFontScaleChange,
      onDismissGuide: async () => {
        const saved = await polling.setPreferences({ usageGuideDismissed: true });
        if (!('usageGuideDismissed' in saved) || saved.usageGuideDismissed !== true) {
          throw new Error('Usage guide could not be saved');
        }
        guide.sync(saved);
      },
      onLanguage: onChooseLanguage,
      onRefresh: () => polling.refreshManually(() => cards.closeGroup()),
    });
    root.getElementById('open-usage')?.addEventListener('click', () => {
      const trigger = root.querySelector('[data-card=cache]') ?? null;
      if (options.onOpenUsage) {
        options.onOpenUsage(trigger);
        return;
      }
      cards.hide();
      usageDashboard?.open(polling.data?.usage, trigger);
    });
  }

  return { node, root, themeController, updateMenu, usageDashboard };
}

export function renderWidgetTree(params: {
  root: ShadowRoot;
  polling: WidgetPollingState;
  usageDashboard: UsageDashboardHandle | null;
  cards: CardInteractionController;
  chosen: string | null;
  composer: ComposerMatch | null;
  surface: WidgetSurface | undefined;
  language: WidgetLanguage;
  onSelectGroup: (groupId: string, trigger: HTMLElement | null) => void;
  onAfterRender: (group: QuotaGroup | undefined) => void;
}): QuotaGroup | undefined {
  const { root, polling, usageDashboard, cards, chosen, composer, surface, language } = params;
  const data = polling.data;
  if (!data) return undefined;
  polling.syncConversation();

  if (usageDashboard) {
    const usageSummary = data.usage ?? data.usageTotals;
    toggleHidden(root.getElementById('usage-entry'), !usageSummary);
    setText(root.getElementById('usage-today'), compact(usageSummary?.todayTokens));
    setText(root.getElementById('usage-month'), compact(usageSummary?.monthTokens));
    usageDashboard.update(data.usage);
  }
  if (cards.hasOpenGroupMenu) return undefined;

  const groups = data.groups || [];
  const activeGroup = selectQuotaGroup(groups, chosen, composer, data);
  renderGroupSelector(root, groups, activeGroup, language, params.onSelectGroup);

  renderSpeedContextCacheCards({
    root,
    data,
    composer,
    lastConversation: polling.lastConversation,
    surface,
    language,
  });

  const muModels = Array.isArray(data.speed?.modelUsage?.models) ? data.speed.modelUsage.models : [];
  renderModelDonut(root, muModels, language);
  renderQuotaSection(root, activeGroup, data, composer, language);

  const dot = root.getElementById('dot');
  setAttr(dot, 'class', `dot ${data.connection}`);
  setAttr(
    dot,
    'title',
    language.t(data.connection === 'live' ? 'live' : data.connection === 'stale' ? 'stale' : 'offline'),
  );
  params.onAfterRender(activeGroup);
  return activeGroup;
}

const LAYOUT_RELEVANT_SELECTOR =
  'button,[role="button"],a[href],input,select,[contenteditable="true"],[data-cascade-id],[data-testid="model-selector-trigger"],[id="antigravity.agentSidePanelInputBox"]';

function isLayoutRelevantNode(candidate: Node): boolean {
  if (candidate.nodeType !== 1) return false;
  const el = candidate as Element;
  return el.matches(LAYOUT_RELEVANT_SELECTOR) || Boolean(el.querySelector(LAYOUT_RELEVANT_SELECTOR));
}

function isRelevantMutation(record: MutationRecord, node: HTMLElement | null): boolean {
  const target = record.target;
  if (target === node || node?.contains(target)) return false;
  if (!node?.isConnected) return true;
  if (target.contains(node) || node.parentElement?.contains(target)) return true;
    if (record.type === 'attributes') {
      const attr = record.attributeName;
      if (
        attr === 'data-cascade-id' ||
        attr === 'data-testid' ||
        attr === 'hidden' ||
        attr === 'inert' ||
        attr === 'contenteditable'
      ) {
        return true;
      }
      if (attr === 'style' || attr === 'class') {
        return target.nodeType === 1 && (target as Element).matches(LAYOUT_RELEVANT_SELECTOR);
      }
      return isLayoutRelevantNode(target);
    }
    for (const added of record.addedNodes) {
      if (isLayoutRelevantNode(added)) return true;
    }
    for (const removed of record.removedNodes) {
      if (removed === node || (removed.nodeType === 1 && (removed as Element).contains(node))) return true;
      if (isLayoutRelevantNode(removed)) return true;
    }
    return false;
  }

export function bindHostLifecycleListeners(params: {
  getNode: () => HTMLElement | null;
  shouldTrackScroll?: () => boolean;
  scheduleLayout: () => void;
  hideCards: () => void;
}): () => void {
  const { getNode, shouldTrackScroll, scheduleLayout, hideCards } = params;
  const observer = new MutationObserver((records) => {
    const node = getNode();
    if (!node?.isConnected) {
      if (records.length > 0) scheduleLayout();
      return;
    }
    if (records.some((record) => isRelevantMutation(record, node))) {
      scheduleLayout();
    }
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      'style',
      'class',
      'hidden',
      'inert',
      'data-cascade-id',
      'data-testid',
      'data-tooltip-id',
      'aria-label',
      'role',
      'contenteditable',
    ],
  });

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') hideCards();
  };
  const onPointer = (e: PointerEvent): void => {
    const node = getNode();
    if (node && !e.composedPath().includes(node)) hideCards();
  };
  const onScroll = (): void => {
    const node = getNode();
    if (!node?.isConnected || shouldTrackScroll?.()) {
      scheduleLayout();
    }
  };
  document.addEventListener('keydown', onKey);
  document.addEventListener('pointerdown', onPointer);
  window.addEventListener('resize', scheduleLayout, { passive: true });
  document.addEventListener('scroll', onScroll, { capture: true, passive: true });

  return () => {
    observer.disconnect();
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('pointerdown', onPointer);
    document.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', scheduleLayout);
  };
}
