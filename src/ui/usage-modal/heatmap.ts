import { addDays, startOfWeek, type AggregationQuery, type UsageDayIndex } from './aggregator.ts';
import { createDomNode } from './dom-shell.ts';
import type { TooltipController } from './tooltip.ts';
import type { UsageDomContext, UsageTotalsResult } from './types.ts';

export interface HeatmapController {
  renderHeat(): void;
  showSelection(): void;
  syncYear(): void;
  closeYear(restore?: boolean): void;
  positionYear(): void;
  isYearOpen(): boolean;
  dispose(): void;
}

const EN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ZH_WEEKDAYS = ['一', '', '三', '', '五', '', '日'];
const EN_WEEKDAYS = ['M', '', 'W', '', 'F', '', 'S'];

export function createHeatmapController(
  ctx: UsageDomContext,
  dayIndex: UsageDayIndex,
  tooltip: TooltipController,
  getQuery: () => AggregationQuery,
): HeatmapController {
  const { $, text, w, zh, full, state, view, page, dialog, options } = ctx;

  const showSelection = (): void => {
    if (!state.value) return;
    const bucket = state.selected || dayIndex.totals(state.value.today, state.value.today, getQuery());
    text('selection-title', bucket.from === bucket.to ? bucket.from : `${bucket.from} – ${bucket.to}`);
    text('selection-value', `${full(bucket.total)} Token · ${w(`${bucket.requests} 次请求`, `${bucket.requests} requests`)}`);
  };

  const syncYear = (): void => {
    text('year-label', String(state.year));
    $('year')?.setAttribute('aria-label', `${w('选择年份', 'Select year')} · ${state.year}`);
    $('year-menu')?.setAttribute('aria-label', w('年份', 'Year'));
    for (const option of $('year-menu')?.children || []) {
      const el = option as HTMLElement;
      option.setAttribute('aria-selected', String(el.dataset.year === String(state.year)));
    }
  };

  const closeYear = (restore = true): void => {
    const menu = $('year-menu');
    if (!menu || !menu.matches(':popover-open')) return;
    menu.hidePopover();
    $('year')?.setAttribute('aria-expanded', 'false');
    if (restore) $('year')?.focus({ preventScroll: true });
  };

  const positionYear = (): void => {
    const menu = $('year-menu');
    const yearBtn = $('year');
    if (!menu || !yearBtn || !menu.matches(':popover-open')) return;
    const r = yearBtn.getBoundingClientRect();
    const bounds = dialog.getBoundingClientRect();
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    menu.style.left = `${Math.max(bounds.left + 12, Math.min(r.right - width, bounds.right - width - 12))}px`;
    const below = r.bottom + 7;
    menu.style.top = `${below + height <= bounds.bottom - 12 ? below : Math.max(bounds.top + 12, r.top - height - 7)}px`;
  };

  const openYear = (): void => {
    const menu = $('year-menu');
    if (!menu) return;
    tooltip.hide();
    menu.showPopover();
    $('year')?.setAttribute('aria-expanded', 'true');
    positionYear();
    ((menu.querySelector('[aria-selected=true]') || menu.firstElementChild) as HTMLElement | null)?.focus({ preventScroll: true });
  };

  const renderHeat = (): void => {
    if (!state.value || !state.year) return;
    const years: number[] = [];
    const first = Number(state.value.firstDate?.slice(0, 4) || state.value.today.slice(0, 4));
    const currentYear = Number(state.value.today.slice(0, 4));
    const minimum = Math.max(first, currentYear - 10);
    for (let y = currentYear; y >= minimum; y--) years.push(y);

    const yearBtn = $('year');
    const yearMenu = $('year-menu');
    if (yearBtn && yearMenu && yearBtn.dataset.years !== years.join(',')) {
      yearMenu.replaceChildren(
        ...years.map((y) => {
          const option = createDomNode('button', 'year-option');
          option.type = 'button';
          option.dataset.year = String(y);
          option.setAttribute('role', 'option');
          option.tabIndex = -1;
          options.setMarkup(option, '<span></span><svg class="year-check" viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8 3 3 7-7"/></svg>');
          if (option.firstElementChild) option.firstElementChild.textContent = String(y);
          option.addEventListener('click', () => {
            state.year = String(y);
            syncYear();
            closeYear();
            renderHeat();
          });
          return option;
        }),
      );
      yearBtn.dataset.years = years.join(',');
    }
    syncYear();

    const start = startOfWeek(`${state.year}-01-01`);
    const end = `${state.year}-12-31`;
    const weeks = Math.floor((Date.parse(end) - Date.parse(start)) / 604800000) + 1;
    const heatEl = $('heat');
    if (!heatEl) return;
    heatEl.className = `heat${state.heatMode === 'week' ? ' week' : ''}`;
    heatEl.style.gridTemplateColumns = `repeat(${weeks},minmax(0,1fr))`;
    if (state.heatMode === 'week') {
      heatEl.style.setProperty('grid-template-columns', `repeat(${Math.ceil(weeks / 2)},minmax(0,1fr))`, 'important');
    }

    const query = getQuery();
    const buckets: UsageTotalsResult[] = [];
    const heatFrag = document.createDocumentFragment();
    for (let i = 0; i < (state.heatMode === 'day' ? weeks * 7 : weeks); i++) {
      const date = addDays(start, state.heatMode === 'day' ? i : i * 7);
      const to = state.heatMode === 'day' ? date : addDays(date, 6);
      buckets.push(
        state.heatMode === 'day'
          ? dayIndex.totals(date, date, query)
          : dayIndex.totals(date < `${state.year}-01-01` ? `${state.year}-01-01` : date, to > end ? end : to, query),
      );
    }

    const max = Math.max(1, ...buckets.map((b) => b.total));
    let lastActiveBtn: HTMLButtonElement | null = null;
    let lastUsableBtn: HTMLButtonElement | null = null;
    for (const bucket of buckets) {
      const button = createDomNode('button');
      button.type = 'button';
      const future = bucket.from > state.value.today || bucket.to < `${state.year}-01-01` || bucket.from > `${state.year}-12-31`;
      button.dataset.level = bucket.total === 0 ? '0' : String(Math.min(4, Math.ceil((bucket.total / max) * 4)));
      if (future) {
        button.className = 'future';
        button.disabled = true;
      } else {
        tooltip.bindBucket(button, bucket, (picked) => {
          state.selected = picked;
          state.anchor = picked.from;
          showSelection();
        });
        lastUsableBtn = button;
        if (button.dataset.level !== '0') lastActiveBtn = button;
      }
      button.tabIndex = -1;
      heatFrag.append(button);
    }
    if (lastActiveBtn || lastUsableBtn) (lastActiveBtn || lastUsableBtn)!.tabIndex = 0;
    heatEl.replaceChildren(heatFrag);

    const monthsFrag = document.createDocumentFragment();
    const weekdaysFrag = document.createDocumentFragment();
    const monthsEl = $('months');
    if (state.heatMode === 'day' && monthsEl) {
      monthsEl.style.gridTemplateColumns = `repeat(${weeks},minmax(0,1fr))`;
      for (let m = 1; m <= 12; m++) {
        const date = `${state.year}-${String(m).padStart(2, '0')}-01`;
        const col = Math.floor((Date.parse(date) - Date.parse(start)) / 604800000) + 1;
        const label = createDomNode('span', '', zh() ? `${m}月` : EN_MONTHS[m - 1]);
        label.style.gridColumn = String(col);
        label.style.gridRow = '1';
        monthsFrag.append(label);
      }
      for (let i = 0; i < 7; i++) {
        weekdaysFrag.append(createDomNode('span', '', i % 2 === 0 ? (zh() ? ZH_WEEKDAYS[i] : EN_WEEKDAYS[i]) : ''));
      }
    }
    monthsEl?.replaceChildren(monthsFrag);
    $('weekdays')?.replaceChildren(weekdaysFrag);

    text('heat-sub', state.heatMode === 'day' ? w('每格代表一天', 'Each square is one day') : w('每格代表一周 · 周一开始', 'Each square is one week · starts Monday'));
    const annual = dayIndex.totals(`${state.year}-01-01`, `${state.year}-12-31`, query);
    text('heat-summary', w(`${state.year} 年 · ${full(annual.total)} Token`, `${state.year} · ${full(annual.total)} tokens`));
    for (const b of view.querySelectorAll<HTMLElement>('[data-heat]')) {
      b.setAttribute('aria-pressed', String(b.dataset.heat === state.heatMode));
    }
    showSelection();
  };

  $('year')?.addEventListener('click', () => ($('year-menu')?.matches(':popover-open') ? closeYear() : openYear()));
  $('year')?.addEventListener('keydown', (event) => {
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      openYear();
      const menu = $('year-menu');
      if (event.key === 'Home') (menu?.firstElementChild as HTMLElement | null)?.focus();
      if (event.key === 'End') (menu?.lastElementChild as HTMLElement | null)?.focus();
    }
  });
  $('year-menu')?.addEventListener('keydown', (event) => {
    const optionsList = [...($('year-menu')?.children || [])] as HTMLElement[];
    const current = optionsList.indexOf(view.activeElement as HTMLElement);
    let next: number | null = null;
    if (event.key === 'ArrowDown') next = Math.min(optionsList.length - 1, current + 1);
    else if (event.key === 'ArrowUp') next = Math.max(0, current - 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = optionsList.length - 1;
    if (next !== null) {
      event.preventDefault();
      optionsList[next]?.focus({ preventScroll: true });
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeYear();
    } else if (event.key === 'Tab') {
      closeYear();
    }
  });

  const closeYearOnScroll = (): void => closeYear(false);
  view.addEventListener('pointerdown', (event) => {
    const path = event.composedPath();
    const yearBtn = $('year');
    const yearMenu = $('year-menu');
    if (yearBtn && yearMenu && !path.includes(yearBtn) && !path.includes(yearMenu)) closeYear(false);
  });
  page.addEventListener('scroll', closeYearOnScroll, { passive: true });
  window.addEventListener('resize', positionYear);

  $('heat')?.addEventListener('keydown', (event) => {
    const buttons = [...($('heat')?.children || [])] as HTMLButtonElement[];
    const target = event.target as HTMLButtonElement;
    const index = buttons.indexOf(target);
    if (index < 0) return;
    const half = Math.ceil(buttons.length / 2);
    const delta: Record<string, number> =
      state.heatMode === 'day'
        ? { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 }
        : { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -half, ArrowDown: half };
    const next =
      event.key === 'Home'
        ? buttons.findIndex((b) => !b.disabled)
        : event.key === 'End'
          ? buttons.findLastIndex((b) => !b.disabled)
          : index + (delta[event.key] ?? NaN);
    if (!Number.isFinite(next) || next < 0 || next >= buttons.length || buttons[next].disabled) return;
    event.preventDefault();
    target.tabIndex = -1;
    buttons[next].tabIndex = 0;
    buttons[next].focus();
  });

  return {
    renderHeat,
    showSelection,
    syncYear,
    closeYear,
    positionYear,
    isYearOpen: () => Boolean($('year-menu')?.matches(':popover-open')),
    dispose() {
      closeYear(false);
      window.removeEventListener('resize', positionYear);
      page.removeEventListener('scroll', closeYearOnScroll);
    },
  };
}
