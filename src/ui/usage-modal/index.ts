// Shared local usage views. Values and model labels are inserted as text.
import type { UsageSummarySnapshot } from '../../contracts/index.ts';
import { bindAccountSwitcher, syncAccountSwitcher } from './account-switcher.ts';
import { UsageDayIndex, type AggregationQuery } from './aggregator.ts';
import { mountUsageDomShell, renderKpiCards, renderOnboardingGuide, resolveUsageBridge } from './dom-shell.ts';
import { bindUsageModalEvents, type UsageEventsCleanup } from './events.ts';
import { createFocusTrap } from './focus-trap.ts';
import { createHeatmapController } from './heatmap.ts';
import { renderHeaderAndLabels, renderWaitingState } from './localize-modal.ts';
import { bindManualModal, renderManualEntries } from './manual-modal.ts';
import { UsagePalette } from './palette.ts';
import { createProjectDetailController, type ProjectDetailController } from './project-detail.ts';
import { createStackedBarController } from './stacked-bar.ts';
import { createTooltipController } from './tooltip.ts';
import type {
  UsageDashboardHandle,
  UsageDashboardOptions,
  UsageModalState,
  UsageWindow,
} from './types.ts';

export type { UsageDashboardHandle, UsageDashboardOptions } from './types.ts';

export default function createUsageDashboard(options: UsageDashboardOptions): UsageDashboardHandle {
  const hostLabel = options.hostLabel ?? 'Antigravity';
  const state: UsageModalState = {
    value: null,
    tab: 'overview',
    heatMode: 'day',
    period: 'day',
    year: null,
    anchor: null,
    selected: null,
    disabledModels: new Set(),
    disabledUsers: new Set(),
    disabledProjects: new Set(),
    dimension: 'model',
    projectOverview: null,
    projectOverviewKey: '',
    projectLoading: false,
    projectError: null,
    selectedProjectKey: null,
    projectDetail: null,
    projectDetailKey: '',
    projectDetailLoading: false,
    projectDetailError: null,
    activeConvId: null,
    modelViewMode: 'simple',
    expandedModelGroups: new Set(),
    hourlyMode: 'combined',
    lastKey: '',
    busy: false,
    opener: null,
    showAllModels: false,
    selectedBar: null,
    hourlyExpanded: false,
    customStart: '',
    customEnd: '',
    disposed: false,
    accountKey: null,
    currentBuckets: [],
    guideDismissed: Boolean(options.guideDismissed),
    guideSaving: false,
    guideError: false,
    guideSignature: null,
    lastManualSig: '',
    lastAccQueryKey: '',
  };

  const { dialog, backdrop, context: ctx } = mountUsageDomShell(options, state);
  const { $ } = ctx;
  const palette = new UsagePalette(() => dialog);
  const dayIndex = new UsageDayIndex();
  const getQuery = (): AggregationQuery => ({
    dimension: state.dimension,
    modelViewMode: state.modelViewMode,
    disabledModels: state.disabledModels,
    disabledUsers: state.disabledUsers,
    disabledProjects: state.disabledProjects,
  });

  const tooltip = createTooltipController(ctx, palette);
  const heatmap = createHeatmapController(ctx, dayIndex, tooltip, getQuery);
  let events!: UsageEventsCleanup;
  let projectDetail!: ProjectDetailController;
  let projectReqEpoch = 0;
  let projectDetailEpoch = 0;

  const activeRangeBounds = (): { from: string; to: string } => {
    if (state.selectedBar) {
      return { from: state.selectedBar.from, to: state.selectedBar.to };
    }
    return {
      from: state.currentBuckets[0]?.from || state.value?.today || '',
      to: state.currentBuckets.at(-1)?.to || state.value?.today || '',
    };
  };

  const loadProjectDetail = async (projectKey: string, from: string, to: string): Promise<void> => {
    const scope = state.value?.viewScope || state.value?.accountKey || state.value?.activeAccount || null;
    const reqKey = `${scope || ''}|${projectKey}|${from}|${to}`;
    if (state.projectDetailKey === reqKey && (state.projectDetail || state.projectDetailLoading)) return;
    const bridge = resolveUsageBridge(options);
    if (typeof bridge?.getProjectDetail !== 'function') return;

    const myEpoch = ++projectDetailEpoch;
    state.projectDetailKey = reqKey;
    state.projectDetailLoading = true;
    state.projectDetailError = null;
    projectDetail.render();
    try {
      const res = await bridge.getProjectDetail({ projectKey, scope, from, to });
      if (state.disposed || myEpoch !== projectDetailEpoch) return;
      if (res && typeof res === 'object' && 'error' in res) {
        state.projectDetail = null;
        state.projectDetailError = res.error;
      } else {
        state.projectDetail = res;
      }
    } catch (err) {
      if (state.disposed || myEpoch !== projectDetailEpoch) return;
      state.projectDetail = null;
      state.projectDetailError = err instanceof Error ? err.message : ctx.w('加载失败', 'Load failed');
    } finally {
      if (!state.disposed && myEpoch === projectDetailEpoch) {
        state.projectDetailLoading = false;
        projectDetail.render();
      }
    }
  };

  const ensureProjectUsage = async (from: string, to: string): Promise<void> => {
    const scope = state.value?.viewScope || state.value?.accountKey || state.value?.activeAccount || null;
    const reqKey = `${scope || ''}|${from}|${to}`;
    if (state.projectOverviewKey === reqKey) return;
    const bridge = resolveUsageBridge(options);
    if (typeof bridge?.getProjectUsage !== 'function') return;

    const myEpoch = ++projectReqEpoch;
    state.projectOverviewKey = reqKey;
    state.projectLoading = true;
    state.projectError = null;
    try {
      const res = await bridge.getProjectUsage({ scope, from, to });
      if (state.disposed || myEpoch !== projectReqEpoch) return;
      if (res && typeof res === 'object' && 'error' in res) {
        state.projectOverview = null;
        state.projectOverviewKey = '';
        dayIndex.rebuildProjects(null);
        state.projectError = res.error;
      } else {
        state.projectOverview = res;
        dayIndex.rebuildProjects(res);
        if (state.selectedProjectKey) {
          if (res.projects.some((p) => p.projectKey === state.selectedProjectKey)) {
            const bounds = activeRangeBounds();
            void loadProjectDetail(state.selectedProjectKey, bounds.from || from, bounds.to || to);
          } else {
            state.selectedProjectKey = null;
            state.projectDetail = null;
            state.projectDetailKey = '';
          }
        }
      }
    } catch (err) {
      if (state.disposed || myEpoch !== projectReqEpoch) return;
      state.projectOverview = null;
      state.projectOverviewKey = '';
      dayIndex.rebuildProjects(null);
      state.projectError = err instanceof Error ? err.message : ctx.w('加载失败', 'Load failed');
    } finally {
      if (!state.disposed && myEpoch === projectReqEpoch) {
        state.projectLoading = false;
        if (state.tab === 'details' && state.dimension === 'project') chart.renderChart();
      }
    }
  };

  const syncProjectDetailToActiveRange = (): void => {
    if (!state.selectedProjectKey) return;
    const { from, to } = activeRangeBounds();
    if (from && to) void loadProjectDetail(state.selectedProjectKey, from, to);
  };

  const selectProject = (projectKey: string): void => {
    state.selectedProjectKey = projectKey;
    state.projectDetailKey = '';
    chart.updateDrilldownView();
    if (state.dimension !== 'project') syncProjectDetailToActiveRange();
  };

  projectDetail = createProjectDetailController(ctx, palette, tooltip, selectProject);
  const chart = createStackedBarController(ctx, dayIndex, palette, tooltip, getQuery, {
    onSyncPickers: () => events?.syncPickers(),
    onProjectRange: (from, to) => {
      void ensureProjectUsage(from, to);
    },
    onSelectProject: selectProject,
    onRenderProjectDetail: () => projectDetail.render(),
    onProjectDrilldown: syncProjectDetailToActiveRange,
  });
  const manual = bindManualModal(ctx);
  bindAccountSwitcher(ctx);
  const focusTrap = createFocusTrap(ctx, {
    onCloseYear: (restore) => heatmap.closeYear(restore),
    onIsYearOpen: () => heatmap.isYearOpen(),
    onCloseSubPopovers: () => {
      let closed = false;
      if (projectDetail.isPickerOpen()) {
        projectDetail.closePicker();
        closed = true;
      }
      if (events?.closeSubPopovers()) closed = true;
      return closed;
    },
    onCloseManualModal: (restore) => manual.closeManualModal(restore),
  });

  const render = (): void => {
    renderOnboardingGuide(ctx, palette);
    const value = state.value;
    if (!value) {
      heatmap.closeYear(false);
      tooltip.hide();
      renderWaitingState(ctx);
      return;
    }

    const waitEl = $('usage-waiting');
    if (waitEl) waitEl.hidden = true;
    palette.sync(value, state.modelViewMode, options.root.host);

    renderHeaderAndLabels(ctx, hostLabel);
    renderKpiCards(ctx, value);
    void syncAccountSwitcher(ctx);
    renderManualEntries(ctx);

    if (state.tab === 'overview') heatmap.renderHeat();
    else chart.renderChart();
  };

  events = bindUsageModalEvents(ctx, options, {
    palette,
    dayIndex,
    tooltip,
    heatmap,
    chart,
    render,
  });

  const contentKey = (data: UsageSummarySnapshot): string =>
    JSON.stringify([{ ...data, updatedAt: undefined }, options.language.language, palette.themeSignature(options.root.host)]);

  const themeObserver = new MutationObserver(() => {
    if (!state.disposed && state.value && dialog.open) {
      const key = contentKey(state.value);
      if (key !== state.lastKey) {
        state.lastKey = key;
        render();
      }
    }
  });
  if (options.root.host) {
    themeObserver.observe(options.root.host, { attributes: true, attributeFilter: ['data-pulse-theme', 'style'] });
  }

  return {
    open(data, trigger) {
      if (!data || state.disposed) return;
      state.accountKey = data.accountKey;
      state.value = data;
      state.opener = (trigger as HTMLElement | null) ?? null;
      state.year ||= data.today.slice(0, 4);
      state.anchor ||= data.today;
      state.lastKey = contentKey(data);
      dayIndex.rebuild(data);
      events.loadPreferencesIfNeeded();
      render();
      focusTrap.present();
    },
    update(data) {
      if (state.disposed) return;
      if (!data) {
        if (!state.value) return;
        state.value = null;
        state.lastKey = '';
        dayIndex.rebuild(null);
        if (dialog.open) render();
        return;
      }
      if (
        (state.accountKey && state.accountKey !== data.accountKey) ||
        (state.value?.viewScope && data.viewScope && state.value.viewScope !== data.viewScope)
      ) {
        state.selected = null;
        state.selectedBar = null;
        state.disabledModels.clear();
        state.disabledUsers.clear();
        state.disabledProjects.clear();
        state.expandedModelGroups.clear();
        state.projectOverview = null;
        state.projectOverviewKey = '';
        dayIndex.rebuildProjects(null);
        state.selectedProjectKey = null;
        state.projectDetail = null;
        state.projectDetailKey = '';
        state.lastAccQueryKey = '';
        state.year = data.today.slice(0, 4);
        state.anchor = data.today;
      }
      state.accountKey = data.accountKey;
      state.value = data;
      if (!dialog.open) return;
      const key = contentKey(data);
      if (key === state.lastKey) return;
      state.lastKey = key;
      dayIndex.rebuild(data);
      render();
    },
    restoreModal() {
      if (options.displayMode === 'fullpage') return;
      if (!state.disposed && dialog.open && dialog.isConnected && !dialog.matches(':popover-open')) {
        heatmap.closeYear(false);
        focusTrap.present();
      }
    },
    close: focusTrap.close,
    syncGuideDismissed() {
      if ((window as UsageWindow).__agPulseUsageGuidePreview !== true) events.dismissGuide();
    },
    syncPreferences(prefs) {
      events.syncPreferences(prefs);
    },
    dispose() {
      state.disposed = true;
      themeObserver.disconnect();
      events.dispose();
      projectDetail.dispose();
      heatmap.dispose();
      focusTrap.dispose();
      dialog.remove();
      backdrop.remove();
    },
    get isOpen() {
      return dialog.open;
    },
  };
}
