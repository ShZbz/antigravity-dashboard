import type { UsageDomContext } from './types.ts';

export interface FocusTrapHandlers {
  onCloseYear: (restore?: boolean) => void;
  onIsYearOpen: () => boolean;
  onCloseSubPopovers?: () => boolean;
  onCloseManualModal: (restore?: boolean) => void;
}

export interface FocusTrapController {
  present(): void;
  conceal(): void;
  close(): void;
  dispose(): void;
}

export function createFocusTrap(ctx: UsageDomContext, handlers: FocusTrapHandlers): FocusTrapController {
  const { dialog, view, state, $ } = ctx;
  const within = (event: Event): boolean => event.composedPath().includes(dialog);

  const present = (): void => {
    if (dialog.matches(':popover-open')) return;
    dialog.removeAttribute('open');
    dialog.showPopover();
    dialog.setAttribute('open', '');
    $('locale')?.focus({ preventScroll: true });
  };

  const conceal = (): void => {
    if (dialog.matches(':popover-open')) dialog.hidePopover();
    dialog.removeAttribute('open');
  };

  const close = (): void => {
    handlers.onCloseYear(false);
    handlers.onCloseSubPopovers?.();
    conceal();
    const tip = $('tip');
    if (tip) {
      try {
        if (typeof tip.hidePopover === 'function' && tip.matches(':popover-open')) tip.hidePopover();
      } catch {
        // Ignore if Popover API is unavailable.
      }
      tip.hidden = true;
    }
    state.opener?.focus({ preventScroll: true });
  };

  const containFocus = (event: FocusEvent): void => {
    if (!state.disposed && dialog.open && !within(event)) {
      $('locale')?.focus({ preventScroll: true });
    }
  };

  const containKeys = (event: KeyboardEvent): void => {
    if (state.disposed || !dialog.open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      const manualModal = $('manual-modal');
      if (manualModal && !manualModal.hidden) handlers.onCloseManualModal();
      else if (handlers.onIsYearOpen()) handlers.onCloseYear();
      else if (handlers.onCloseSubPopovers?.()) return;
      else close();
      return;
    }
    if (event.key !== 'Tab') return;
    if (handlers.onIsYearOpen()) handlers.onCloseYear(false);
    const controls = [...view.querySelectorAll<HTMLElement>('button,input,select,a[href],[tabindex]')].filter(
      (n) => n.tabIndex >= 0 && !(n as HTMLButtonElement).disabled && n.getClientRects().length && getComputedStyle(n).visibility !== 'hidden',
    );
    if (!controls.length) {
      event.preventDefault();
      return;
    }
    const index = controls.indexOf(view.activeElement as HTMLElement);
    if (index < 0 || (event.shiftKey && index === 0) || (!event.shiftKey && index === controls.length - 1)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      (event.shiftKey ? controls.at(-1) : controls[0])?.focus({ preventScroll: true });
    }
  };

  const containScroll = (event: Event): void => {
    if (!state.disposed && dialog.open && !within(event)) event.preventDefault();
  };

  const containPointer = (event: MouseEvent): void => {
    if (state.disposed || !dialog.open) return;
    const r = dialog.getBoundingClientRect();
    const backdropHit = event.composedPath()[0] === dialog;
    if (!within(event) || (backdropHit && (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom))) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.type === 'click') close();
    }
  };

  $('close')?.addEventListener('click', close);
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) {
      const r = dialog.getBoundingClientRect();
      if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) {
        close();
      }
    }
  });

  document.addEventListener('focusin', containFocus, true);
  document.addEventListener('keydown', containKeys, true);
  document.addEventListener('wheel', containScroll, { capture: true, passive: false });
  document.addEventListener('touchmove', containScroll, { capture: true, passive: false });
  for (const type of ['pointerdown', 'mousedown', 'click'] as const) {
    document.addEventListener(type, containPointer as EventListener, true);
  }

  return {
    present,
    conceal,
    close,
    dispose() {
      document.removeEventListener('focusin', containFocus, true);
      document.removeEventListener('keydown', containKeys, true);
      document.removeEventListener('wheel', containScroll, true);
      document.removeEventListener('touchmove', containScroll, true);
      for (const type of ['pointerdown', 'mousedown', 'click'] as const) {
        document.removeEventListener(type, containPointer as EventListener, true);
      }
      conceal();
    },
  };
}
