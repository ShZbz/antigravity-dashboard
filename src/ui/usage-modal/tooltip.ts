import { createDomNode } from './dom-shell.ts';
import { modelLabel, type UsagePalette } from './palette.ts';
import type { UsageDomContext, UsageTotalsResult } from './types.ts';

export interface TooltipController {
  show(bucket: UsageTotalsResult, target: Element, activeItem?: string | null): void;
  showNodes(target: Element, nodes: readonly Node[]): void;
  hide(): void;
  highlightItem(item: string | null): void;
  bindBucket(button: HTMLButtonElement, bucket: UsageTotalsResult, onSelect: (bucket: UsageTotalsResult) => void): void;
}

export function createTooltipController(ctx: UsageDomContext, palette: UsagePalette): TooltipController {
  const { $, dialog, state, w, full, compactNum } = ctx;
  let tipTarget: Element | null = null;
  let tipItem: string | null = null;

  const highlightItem = (item: string | null): void => {
    const plot = $('plot');
    if (!plot) return;
    if (item) plot.dataset.highlight = item;
    else delete plot.dataset.highlight;
    const attr = state.dimension === 'user' ? 'user' : state.dimension === 'project' ? 'project' : 'model';
    for (const bar of plot.querySelectorAll<HTMLElement>('.bar-segment')) {
      if (item && bar.dataset[attr] === item) bar.dataset.highlight = 'true';
      else delete bar.dataset.highlight;
    }
  };

  const hidePopoverIfOpen = (tip: HTMLElement): void => {
    try {
      if (typeof tip.hidePopover === 'function' && tip.matches(':popover-open')) tip.hidePopover();
    } catch {
      // Ignore if Popover API is unavailable or element is disconnected.
    }
  };

  const revealTip = (tip: HTMLElement, target: Element): void => {
    tip.hidden = false;
    try {
      if (tip.isConnected && typeof tip.showPopover === 'function' && !tip.matches(':popover-open')) {
        tip.showPopover();
      }
    } catch {
      // Ignore if Popover API is unavailable or element cannot enter top layer.
    }
    const anchor = target.classList?.contains('bar-column') ? target.querySelector('.stack') || target : target;
    const rect = anchor.getBoundingClientRect();
    const bounds = dialog.getBoundingClientRect();
    const r = tip.getBoundingClientRect();
    const left = Math.max(
      bounds.left + 12,
      Math.min(bounds.right - r.width - 12, rect.left + rect.width / 2 - r.width / 2),
    );
    const aboveTop = rect.top - r.height - 10;
    const top =
      aboveTop >= bounds.top + 12
        ? aboveTop
        : Math.min(bounds.bottom - r.height - 12, Math.max(bounds.top + 12, rect.bottom + 10));
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  };

  const hide = (): void => {
    const tip = $('tip');
    if (tip) {
      hidePopoverIfOpen(tip);
      tip.hidden = true;
    }
    tipTarget = null;
    tipItem = null;
    highlightItem(null);
  };

  const show = (bucket: UsageTotalsResult, target: Element, activeItem: string | null = null): void => {
    const tip = $('tip');
    if (!tip) return;
    if (!tip.hidden && tipTarget === target && tipItem === activeItem) return;
    tipTarget = target;
    tipItem = activeItem;
    highlightItem(activeItem);

    tip.replaceChildren(
      createDomNode('div', 'tip-title', bucket.from === bucket.to ? bucket.from : `${bucket.from} – ${bucket.to}`),
      createDomNode('strong', '', `${full(bucket.total)} Token`),
      createDomNode('div', 'muted', w(`${bucket.requests} 次请求`, `${bucket.requests} requests`)),
    );

    if (state.dimension === 'project') {
      const projName = new Map((state.projectOverview?.projects || []).map((p) => [p.projectKey, p.name]));
      for (const [pKey, r] of Object.entries(bucket.projects || {}).sort((a, b) => b[1].total - a[1].total)) {
        const row = createDomNode('div', `tip-model${activeItem ? (activeItem === pKey ? ' active' : ' dimmed') : ''}`);
        const label = createDomNode('span');
        const dot = createDomNode('i', 'dot');
        dot.style.setProperty('--model-color', palette.projectColor(pKey));
        label.append(dot, document.createTextNode(projName.get(pKey) || pKey));
        const amount = createDomNode('span', '', compactNum(r.total));
        amount.append(createDomNode('span', 'model-share', bucket.total ? `${((r.total / bucket.total) * 100).toFixed(1)}%` : '0%'));
        row.append(label, amount);
        tip.append(row);
      }
    } else if (state.dimension === 'user') {
      for (const [u, r] of Object.entries(bucket.users || {}).sort((a, b) => b[1].total - a[1].total)) {
        const row = createDomNode('div', `tip-model${activeItem ? (activeItem === u ? ' active' : ' dimmed') : ''}`);
        const label = createDomNode('span');
        const dot = createDomNode('i', 'dot');
        dot.style.setProperty('--model-color', palette.userColor(u));
        if (u === 'legacy') dot.classList.add('legacy');
        label.append(dot, document.createTextNode(palette.userDisplayName(u, state.value, w)));
        const amount = createDomNode('span', '', compactNum(r.total));
        amount.append(createDomNode('span', 'model-share', bucket.total ? `${((r.total / bucket.total) * 100).toFixed(1)}%` : '0%'));
        row.append(label, amount);
        tip.append(row);
      }
    } else {
      for (const [model, r] of Object.entries(bucket.models || {}).sort((a, b) => b[1].total - a[1].total)) {
        const row = createDomNode('div', `tip-model${activeItem ? (activeItem === model ? ' active' : ' dimmed') : ''}`);
        const label = createDomNode('span');
        const dot = createDomNode('i', 'dot');
        dot.style.setProperty('--model-color', palette.modelColor(model, state.modelViewMode));
        label.append(dot, document.createTextNode(modelLabel(model, state.modelViewMode)));
        const amount = createDomNode('span', '', compactNum(r.total));
        amount.append(createDomNode('span', 'model-share', bucket.total ? `${((r.total / bucket.total) * 100).toFixed(1)}%` : '0%'));
        row.append(label, amount);
        tip.append(row);
      }
    }

    revealTip(tip, target);
  };

  const bindBucket = (
    button: HTMLButtonElement,
    bucket: UsageTotalsResult,
    onSelect: (selected: UsageTotalsResult) => void,
  ): void => {
    button.setAttribute('aria-label', `${bucket.from === bucket.to ? bucket.from : `${bucket.from} – ${bucket.to}`}: ${full(bucket.total)} Token`);
    button.addEventListener('pointerenter', () => show(bucket, button));
    button.addEventListener('pointerleave', hide);
    button.addEventListener('focus', () => show(bucket, button));
    button.addEventListener('blur', hide);
    button.addEventListener('pointermove', (event) => {
      const seg = (event.target as Element | null)?.closest?.('.bar-segment') as HTMLElement | null;
      const item =
        state.dimension === 'user'
          ? seg?.dataset.user || null
          : state.dimension === 'project'
            ? seg?.dataset.project || null
            : seg?.dataset.model || null;
      show(bucket, button, item);
    });
    button.addEventListener('click', () => onSelect(bucket));
  };

  const showNodes = (target: Element, nodes: readonly Node[]): void => {
    const tip = $('tip');
    if (!tip) return;
    tipTarget = target;
    tipItem = null;
    tip.replaceChildren(...nodes);
    revealTip(tip, target);
  };

  return { show, showNodes, hide, highlightItem, bindBucket };
}
