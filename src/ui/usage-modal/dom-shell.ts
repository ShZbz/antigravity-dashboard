import type { RuntimeBridgeApi, UsageSummarySnapshot } from '../../contracts/index.ts';
import { compact } from '../../shared/format.ts';
import { FONT_POPOVER_CSS } from '../shared/font-popover.ts';
import baseCss from './usage.css';
import sectionsCss from './usage-sections.css';
import type { UsagePalette } from './palette.ts';
import type { UsageDashboardOptions, UsageDomContext, UsageModalState, UsageWindow } from './types.ts';

export function resolveUsageBridge(
  options?: Pick<UsageDashboardOptions, 'bridge'> | null,
): Partial<RuntimeBridgeApi> | undefined {
  return options?.bridge || (window as UsageWindow).agPulseBridge || (window as UsageWindow).agPulseHost;
}

const BACKDROP_STYLE =
  '#usage-dashboard{position:fixed;inset:0;margin:auto;width:min(1040px,calc(100vw - 40px));max-width:none;height:min(820px,calc(100dvh - 64px));max-height:none;border-radius:18px;pointer-events:none;opacity:0;transition:opacity 100ms ease,display 100ms,overlay 100ms;transition-behavior:allow-discrete}#usage-dashboard:is(:popover-open,.\\:popover-open,[open]){pointer-events:auto;opacity:1}@starting-style{#usage-dashboard:popover-open,#usage-dashboard[open]{opacity:0}}#usage-dashboard::backdrop{background:#0006;backdrop-filter:blur(3px);pointer-events:none;opacity:0;transition:opacity 100ms ease,display 100ms,overlay 100ms;transition-behavior:allow-discrete}#usage-dashboard:is(:popover-open,.\\:popover-open,[open])::backdrop{pointer-events:auto;opacity:1}@starting-style{#usage-dashboard:popover-open::backdrop,#usage-dashboard[open]::backdrop{opacity:0}}@media(prefers-reduced-motion:no-preference){#usage-dashboard{scale:.98;transition:opacity 140ms ease,scale 150ms cubic-bezier(.2,.9,.3,1),display 150ms,overlay 150ms;transition-behavior:allow-discrete}#usage-dashboard:is(:popover-open,.\\:popover-open,[open]){scale:1}@starting-style{#usage-dashboard:popover-open,#usage-dashboard[open]{opacity:0;scale:.975}}#usage-dashboard::backdrop{transition:opacity 140ms ease,display 140ms,overlay 140ms;transition-behavior:allow-discrete}}@media(max-width:640px){#usage-dashboard{width:calc(100vw - 12px);height:calc(100dvh - 12px);border-radius:12px}}@media(max-width:480px){#usage-dashboard{width:100vw;height:100dvh;border-radius:0;border-width:0}}';

const DIALOG_STYLE =
  'box-sizing:border-box;overflow:hidden;visibility:visible;padding:0;border:1px solid var(--pulse-border);background:var(--pulse-background);color:var(--pulse-foreground);box-shadow:0 24px 100px #0006';

const FULLPAGE_HOST_STYLE =
  '#usage-dashboard[data-display-mode="fullpage"]{position:static;display:block;width:100%;max-width:none;height:100%;max-height:none;margin:0;padding:0;border:0;border-radius:0;box-shadow:none;background:var(--pulse-background);color:var(--pulse-foreground);overflow:hidden;opacity:1;pointer-events:auto}';

const FULLPAGE_DIALOG_STYLE =
  'box-sizing:border-box;overflow:hidden;visibility:visible;padding:0;border:0;background:var(--pulse-background);color:var(--pulse-foreground);box-shadow:none';

const PAGE_MARKUP =
  '<header class="top"><div><div class="eyebrow">ANTIGRATIVE DASHBOARD</div><h1 id="title"></h1><div class="sub"><span class="live-dot"></span><span id="subtitle"></span></div></div><div class="top-controls"><div class="actions"><button id="locale" type="button" aria-label="Language"><span id="locale-label" class="locale-label">中</span></button><button id="refresh" type="button" aria-label="Refresh"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 7a5 5 0 1 0-1.3 4.4M13 3v4H9"/></svg></button><button id="font-settings" type="button" class="font-trigger" aria-label="Font size settings"><span>Aa</span></button><button id="close" type="button" aria-label="Close"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8"/></svg></button></div><button id="add-manual" type="button" class="btn-manual" aria-label="Add manual usage"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg><span id="add-manual-label">录入远程用量</span></button></div></header><div class="tabs-bar"><nav class="tabs" role="tablist"><button id="overview-tab" role="tab" aria-controls="overview"></button><button id="details-tab" role="tab" aria-controls="details"></button></nav><span id="account-switcher-slot"></span></div><div class="totals" id="totals"></div><section id="usage-waiting" class="usage-waiting" role="status" hidden></section><section id="overview" role="tabpanel"><div class="section-head"><div><h2 id="activity-title"></h2><div class="muted" id="heat-sub"></div></div><div class="chart-controls"><div class="seg" id="heat-controls"><button data-heat="day"></button><button data-heat="week"></button></div><div class="year-picker"><button id="year" type="button" class="year-trigger" aria-label="Year" aria-haspopup="listbox" aria-controls="year-menu" aria-expanded="false"><span id="year-label"></span><svg class="year-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></button><div id="year-menu" class="year-menu" role="listbox" aria-label="Year" popover="manual"></div></div></div></div><div class="heat-wrap"><div class="calendar"><div class="months" id="months"></div><div class="heat-row"><div class="weekdays" id="weekdays"></div><div class="heat" id="heat"></div></div></div></div><div class="heat-footer"><span id="heat-summary"></span><div class="scale"><span id="less"></span><i class="swatch"></i><i class="swatch" data-level="1"></i><i class="swatch" data-level="2"></i><i class="swatch" data-level="3"></i><i class="swatch" data-level="4"></i><span id="more"></span></div></div><div class="selected"><div><div class="title" id="selection-title"></div><span class="muted" id="selection-value"></span></div><button id="selection-details"></button></div></section><section id="details" role="tabpanel" hidden><div class="section-head"><div class="detail-heading-group"><div class="detail-picker-row"><div class="picker" id="dim-picker"><button id="dim-trigger" type="button" class="picker-trigger" aria-haspopup="listbox" aria-controls="dim-menu" aria-expanded="false"><span id="dim-label"></span><svg class="picker-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></button><div id="dim-menu" class="picker-menu" role="listbox" popover="manual"></div></div><div class="picker" id="model-view-picker"><button id="model-view-trigger" type="button" class="picker-trigger" aria-haspopup="listbox" aria-controls="model-view-menu" aria-expanded="false"><span id="model-view-label"></span><svg class="picker-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></button><div id="model-view-menu" class="picker-menu" role="listbox" popover="manual"></div></div><span id="project-scope-note" class="project-scope-note" hidden></span></div><div id="detail-summary-row" class="detail-summary-row"></div></div><div class="chart-controls"><div class="range"><button id="previous" aria-label="Previous">‹</button><strong id="range-label"></strong><button id="next" aria-label="Next">›</button></div><div id="custom-range-controls" class="custom-range-controls" hidden></div><div class="seg" id="period-controls"><button data-period="day"></button><button data-period="week"></button><button data-period="month"></button><button data-period="custom"></button></div></div></div><div class="legend" id="legend"></div><div class="chart-wrap"><div class="chart"><div class="axis" id="axis"></div><div class="plot" id="plot"></div></div></div><div class="hourly-section" id="hourly-section"><div class="hourly-header"><button id="hourly-toggle" type="button" class="hourly-toggle" aria-expanded="false"><span id="hourly-toggle-title"></span><span id="hourly-title"></span><span id="hourly-subtitle" class="muted"></span><svg class="hourly-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></button><div class="hourly-mode-seg" id="hourly-mode-controls"><button id="hourly-mode-combined" type="button" data-hourly-mode="combined"></button><button id="hourly-mode-today" type="button" data-hourly-mode="today"></button></div></div><div id="hourly-content" class="hourly-content" hidden><div class="hourly-chart-wrap" id="hourly-chart"></div></div></div><section class="project-detail-section" id="project-detail-section" hidden></section><div class="table-wrap"><table class="table"><thead><tr id="table-head"></tr></thead><tbody id="table-body"></tbody></table></div><div class="manual-section" id="manual-section"><div class="section-head"><h2 id="manual-title"></h2></div><div class="table-wrap"><table class="table" id="manual-table"><thead><tr id="manual-table-head"></tr></thead><tbody id="manual-table-body"></tbody></table></div></div></section><div id="manual-modal" class="modal-layer" hidden></div><div class="alert" id="alert" hidden></div><footer class="footer"><span id="coverage"></span><span id="timezone"></span></footer><div class="tip" id="tip" role="status" popover="manual" hidden></div>';

const INTRO_MARKUP =
  '<div class="intro-heading"><span class="intro-mark" aria-hidden="true"><svg viewBox="0 0 16 16"><ellipse cx="8" cy="4" rx="5" ry="2"/><path d="M3 4v8c0 2 10 2 10 0V4M3 8c0 2 10 2 10 0"/></svg></span><h2 id="usage-intro-title"></h2></div><div class="intro-copy"><p id="usage-intro-history"></p><p id="usage-intro-scope"></p><p id="usage-intro-storage"></p></div><div class="intro-bottom"><span id="usage-intro-error" role="status"></span><button id="usage-intro-done" type="button"></button></div>';

export function createDomNode<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  content?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (content !== undefined) n.textContent = content;
  return n;
}

function el(tag: string, attrs: Record<string, string | boolean | null | undefined> = {}): HTMLElement {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') n.textContent = String(v ?? '');
    else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : String(v));
  }
  return n;
}

export interface UsageShellElements {
  dialog: HTMLDialogElement;
  backdrop: HTMLStyleElement;
  view: ShadowRoot;
  page: HTMLElement;
  intro: HTMLElement;
  context: UsageDomContext;
}

export function mountUsageDomShell(options: UsageDashboardOptions, state: UsageModalState): UsageShellElements {
  const { root, language, setMarkup } = options;
  const isFullpage = options.displayMode === 'fullpage';
  const dialog = document.createElement('dialog');
  dialog.id = 'usage-dashboard';
  if (isFullpage) {
    dialog.dataset.displayMode = 'fullpage';
  } else {
    dialog.setAttribute('popover', 'manual');
    dialog.setAttribute('aria-modal', 'true');
  }
  dialog.setAttribute('aria-label', language.language === 'zh-CN' ? '用量统计' : 'Token usage');
  dialog.style.cssText = isFullpage ? FULLPAGE_DIALOG_STYLE : DIALOG_STYLE;

  const shell = document.createElement('div');
  const view = shell.attachShadow({ mode: 'open' });
  shell.style.height = '100%';
  dialog.append(shell);
  root.append(dialog);

  const backdrop = document.createElement('style');
  backdrop.textContent = isFullpage ? FULLPAGE_HOST_STYLE : BACKDROP_STYLE;
  root.append(backdrop);

  const css = document.createElement('style');
  // Keep usage.css after usage-sections.css so its @media responsive and reduced-motion rules are not overridden.
  css.textContent = `${sectionsCss}\n${baseCss}\n${FONT_POPOVER_CSS}`;
  view.append(css);

  const page = document.createElement('div');
  page.className = 'page';
  if (isFullpage) page.dataset.displayMode = 'fullpage';
  setMarkup(page, PAGE_MARKUP);
  if (isFullpage) {
    const closeBtn = page.querySelector<HTMLButtonElement>('#close');
    if (closeBtn) closeBtn.hidden = true;
  }
  view.append(page);

  const accSelect = el('select', { id: 'account-switcher', class: 'account-switcher', 'aria-label': 'Account', hidden: true });
  page.querySelector('#account-switcher-slot')?.replaceWith(accSelect);
  page.querySelector('#custom-range-controls')?.append(
    el('input', { type: 'date', id: 'custom-start', 'aria-label': 'Start date' }),
    el('span', { text: '–' }),
    el('input', { type: 'date', id: 'custom-end', 'aria-label': 'End date' }),
  );

  buildManualModalDom(page);

  const intro = document.createElement('section');
  intro.id = 'usage-intro';
  intro.className = 'usage-intro';
  intro.hidden = true;
  intro.setAttribute('aria-labelledby', 'usage-intro-title');
  setMarkup(intro, INTRO_MARKUP);
  page.querySelector('.top')?.after(intro);

  const $ = <T extends HTMLElement = HTMLElement>(id: string): T | null => view.getElementById(id) as T | null;
  const text = (id: string, value: string): void => {
    const target = $(id);
    if (target && target.textContent !== value) target.textContent = value;
  };
  const zh = (): boolean => options.language.language === 'zh-CN';
  const w = (cn: string, en: string): string => (zh() ? cn : en);
  const full = (n: number | null | undefined): string => Number(n || 0).toLocaleString(zh() ? 'zh-CN' : 'en-US');
  const compactNum = (n: number | null | undefined): string => {
    const num = Number(n || 0);
    return compact(num, { localeFallback: zh() ? 'zh-CN' : 'en-US' });
  };

  return {
    dialog,
    backdrop,
    view,
    page,
    intro,
    context: { root, dialog, view, page, intro, options, state, $, text, zh, w, full, compactNum },
  };
}

function buildManualModalDom(page: HTMLElement): void {
  const modalCard = el('div', { class: 'modal-card' });
  const manualForm = el('form', { class: 'modal-form', id: 'manual-form' });
  const makeField = (rowAttrs: Record<string, string | boolean | null | undefined>, lblId: string, inputNode: HTMLElement) => {
    const row = el('div', rowAttrs);
    row.append(el('label', { for: inputNode.id, id: lblId }), inputNode);
    return row;
  };
  const accRow = makeField({ class: 'form-row', id: 'manual-account-row' }, 'lbl-account', el('select', { id: 'manual-account' }));
  const projRow = makeField({ class: 'form-row' }, 'lbl-project', el('input', { type: 'text', id: 'manual-project', required: true }));
  const dtRow = makeField({ class: 'form-row' }, 'lbl-datetime', el('input', { type: 'datetime-local', id: 'manual-datetime', required: true }));
  const modelRow = makeField({ class: 'form-row' }, 'lbl-model', el('input', { type: 'text', id: 'manual-model', list: 'manual-model-list', required: true }));
  modelRow.append(el('datalist', { id: 'manual-model-list' }));
  const twoCol = el('div', { class: 'form-row two-col' });
  for (const [fid, lid] of [['manual-prompt', 'lbl-prompt'], ['manual-completion', 'lbl-completion']]) {
    const cell = el('div');
    cell.append(el('label', { for: fid, id: lid }), el('input', { type: 'number', id: fid, min: '0', required: true }));
    twoCol.append(cell);
  }
  const cacheRow = makeField({ class: 'form-row' }, 'lbl-cache', el('input', { type: 'number', id: 'manual-cache', min: '0' }));
  const noteRow = makeField({ class: 'form-row' }, 'lbl-note', el('input', { type: 'text', id: 'manual-note' }));
  const modalActions = el('div', { class: 'modal-actions' });
  modalActions.append(
    el('button', { type: 'button', id: 'manual-cancel' }),
    el('button', { type: 'submit', id: 'manual-submit', class: 'btn-primary' }),
  );
  manualForm.append(accRow, projRow, dtRow, modelRow, twoCol, cacheRow, noteRow, modalActions);
  modalCard.append(el('h3', { class: 'modal-title', id: 'manual-modal-title' }), manualForm);
  page.querySelector('#manual-modal')?.append(modalCard);
}

export function renderOnboardingGuide(ctx: UsageDomContext, palette: UsagePalette): void {
  const { options, state, intro, $, text, w, view, dialog } = ctx;
  const replayGuide = (window as UsageWindow).__agPulseUsageGuidePreview === true;
  const signature = `${options.language.language}|${palette.themeSignature(ctx.root.host)}`;
  if (replayGuide && signature !== state.guideSignature) {
    state.guideDismissed = false;
    state.guideError = false;
  }
  state.guideSignature = signature;
  intro.hidden = state.guideDismissed;
  text('usage-intro-title', w('先了解你的用量统计', 'About your token usage'));
  text(
    'usage-intro-history',
    w(
      '自动汇总当前账号可读取的本地历史对话，再持续记录新请求；已删除或缺失的历史可能无法补齐。',
      'Available local conversations for this account are imported automatically, then new requests are recorded. Deleted or missing history may leave gaps.',
    ),
  );
  text(
    'usage-intro-scope',
    w(
      '统计仅代表本机已记录的 Token 用量，不是账户账单；天、周、月均按 UTC+8 划分。',
      'Totals cover usage recorded on this device, not account billing. Days, weeks and months use UTC+8.',
    ),
  );
  text(
    'usage-intro-storage',
    w(
      '只在本地保存时间、模型和用量，不保存对话正文。删除对话不会扣除已记录的用量。',
      'Only times, models and usage counters are saved locally, never conversation text. Deleting a chat does not subtract usage already recorded.',
    ),
  );
  text('usage-intro-done', state.guideSaving ? w('保存中…', 'Saving…') : w('知道了', 'Got it'));
  text('usage-intro-error', state.guideError ? w('未能保存，请再试一次。', 'Could not save. Please try again.') : '');
  const doneBtn = $<HTMLButtonElement>('usage-intro-done');
  if (doneBtn) {
    doneBtn.disabled = state.guideSaving;
    doneBtn.setAttribute('aria-busy', String(state.guideSaving));
  }
  void view;
  void dialog;
}

export function renderKpiCards(ctx: UsageDomContext, value: UsageSummarySnapshot): void {
  const { $, w, compactNum, full } = ctx;
  const totalsEl = $('totals');
  if (!totalsEl) return;
  const kpis: Array<[string, number]> = [
    [w('今日用量', 'Today'), value.todayTokens],
    [w('本周用量', 'This week'), value.weekTokens],
    [w('本月用量', 'This month'), value.monthTokens],
    [w('累计用量', 'All time'), value.totalTokens],
  ];
  if (totalsEl.children.length !== 4) {
    totalsEl.replaceChildren(
      ...kpis.map(([label, total]) => {
        const metric = createDomNode('div', 'metric');
        const val = createDomNode('div', 'value', compactNum(total));
        val.append(createDomNode('span', 'unit', 'Token'));
        metric.append(createDomNode('label', '', label), val);
        metric.title = `${full(total)} Token`;
        return metric;
      }),
    );
    return;
  }
  [...totalsEl.children].forEach((node, idx) => {
    const metric = node as HTMLElement;
    const [label, total] = kpis[idx];
    const lbl = metric.querySelector('label');
    const val = metric.querySelector('.value');
    if (lbl && lbl.textContent !== label) lbl.textContent = label;
    const unit = val?.querySelector('.unit');
    const compactText = compactNum(total);
    if (!val || !unit) {
      const nextVal = createDomNode('div', 'value', compactText);
      nextVal.append(createDomNode('span', 'unit', 'Token'));
      val ? val.replaceWith(nextVal) : metric.append(nextVal);
    } else if (val.firstChild?.nodeType === 3) {
      if (val.firstChild.textContent !== compactText) val.firstChild.textContent = compactText;
    } else {
      val.replaceChildren(document.createTextNode(compactText), unit);
    }
    const title = `${full(total)} Token`;
    if (metric.title !== title) metric.title = title;
  });
}
