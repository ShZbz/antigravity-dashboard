import type { SpeedMetrics, TokenSummary } from '../../contracts/index.ts';
import { setAttr, setStyle, setText } from '../../shared/dom.ts';
import { compact, count, percent, rate } from '../../shared/format.ts';
import { toggleHidden } from './cards.ts';
import type { ComposerMatch, WidgetLanguage, WidgetMetricsSnapshot, WidgetSurface } from './types.ts';

type ExtendedLatestRateStatus = SpeedMetrics['latestRateStatus'] | 'generating';

export function renderSpeedContextCacheCards(params: {
  root: ShadowRoot;
  data: WidgetMetricsSnapshot;
  composer: ComposerMatch | null;
  lastConversation: string | null;
  surface: WidgetSurface | undefined;
  language: WidgetLanguage;
}): void {
  const { root, data, composer, lastConversation, surface, language } = params;
  const $ = (id: string) => root.getElementById(id);
  const t = language.t;
  const speed = data.speed;

  toggleHidden(root.querySelector<HTMLElement>('[data-card="speed"]'), !lastConversation && !surface?.showEmpty);
  const hasUsageSummary = Boolean(data.usage ?? data.usageTotals);
  toggleHidden(
    root.querySelector<HTMLElement>('[data-card="cache"]'),
    !lastConversation && !surface?.showEmpty && !hasUsageSummary,
  );
  toggleHidden(root.querySelector<HTMLElement>('[data-card="context"]'), false);

  const context = speed?.context;
  const hasCapacity = typeof context?.usedFraction === 'number';
  const empty = surface?.conversationState?.(composer).status === 'new' && !lastConversation && data.connection === 'live';

  setText($('context-percent'), hasCapacity ? `${Math.round((context.usedFraction ?? 0) * 100)}%` : '—');
  setStyle(
    $('context-ring') as HTMLElement | null,
    '--used-angle',
    `${hasCapacity ? Math.min(1, context.usedFraction ?? 0) * 360 : 0}deg`,
  );
  setText(
    $('context-summary'),
    hasCapacity
      ? t('contextUsed', {
          used: Math.round((context.usedFraction ?? 0) * 100),
          remaining: Math.round((context.remainingFraction ?? 0) * 100),
        })
      : t(empty ? 'waitingRequest' : 'contextUnknown'),
  );
  setText(
    $('context-tokens'),
    context
      ? t('contextTokens', {
          used: compact(context.usedTokens),
          max: context.maxTokens === null ? '—' : compact(context.maxTokens),
        })
      : '—',
  );

  const muModels = Array.isArray(speed?.modelUsage?.models) ? speed.modelUsage.models : [];
  const planModel = speed?.planModel || speed?.modelUsage?.planModel || null;
  const activeModel = speed?.activeModel || speed?.modelUsage?.activeModel || context?.model || null;
  setText($('context-model'), activeModel || '—');

  const hasHybridPlan = Boolean(planModel && activeModel && planModel !== activeModel);
  const showOrchestrator = hasHybridPlan || muModels.length >= 2;
  toggleHidden($('context-orchestrator-row') as HTMLElement | null, !showOrchestrator);
  if (showOrchestrator) {
    if (planModel) {
      setText($('context-orchestrator-label'), t('contextPlanner'));
      setText($('context-planner'), planModel);
      setText(
        $('context-orchestrator-note'),
        /orchestrator/i.test(planModel) ? t('contextQuotaSplit') : t('contextMultiModelHint'),
      );
    } else {
      setText($('context-orchestrator-label'), t('modelMixTitle'));
      setText($('context-planner'), t('modelMixModelsCount', { count: muModels.length }));
      setText($('context-orchestrator-note'), t('contextMultiModelHint'));
    }
  }

  const contextFill = $('context-fill') as HTMLElement | null;
  setStyle(contextFill, 'width', hasCapacity ? `${Math.min(1, context.usedFraction ?? 0) * 100}%` : '0%');
  setStyle(
    contextFill,
    'background',
    hasCapacity && (context.usedFraction ?? 0) >= 0.9 ? 'var(--pulse-danger)' : '',
  );
  const contextTrack = $('context-track');
  setAttr(contextTrack, 'aria-valuenow', hasCapacity ? Math.min(100, (context.usedFraction ?? 0) * 100) : null);
  setAttr(contextTrack, 'aria-valuemin', '0');
  setAttr(contextTrack, 'aria-valuemax', '100');

  setText($('tps'), rate(speed?.tps));
  setText(
    $('rounds'),
    speed ? t('rounds', { rounds: speed.rounds ?? 0, steps: speed.steps ?? 0 }) : '',
  );
  setText(
    $('samples'),
    speed
      ? t('sample', {
          rounds: speed.rounds ?? 0,
          steps: speed.steps ?? 0,
          requests: speed.measuredRequests ?? 0,
        })
      : t('waitingRequest'),
  );
  setText($('model-time'), language.elapsed(speed?.modelSeconds));
  setText($('tool-time'), language.elapsed(speed?.toolSeconds));
  setText($('ttft'), language.elapsed(speed?.ttftSeconds));
  setText($('session-rate'), `${rate(speed?.tps)} tok/s`);

  const status = speed?.latestRateStatus as ExtendedLatestRateStatus | undefined;
  const inlineLatestDisplay =
    status === 'generating'
      ? speed?.latestTps !== null && speed?.latestTps !== undefined
        ? `~${rate(speed.latestTps)} tok/s`
        : t('generating')
      : status === 'unreliable'
        ? t('timingUnreliable')
        : status === 'legacy'
          ? t('ratePending')
          : `${rate(speed?.latestTps)} tok/s`;
  setText($('latest-rate'), inlineLatestDisplay);
  setText(
    $('tokens'),
    speed ? `${count(speed.counts.responseOutput)} / ${count(speed.counts.thinkingOutput)} tok` : '—',
  );
  if (status === 'legacy') setText($('session-rate'), t('ratePending'));

  const savedNote = speed?.restoredFromHistory
    ? ` ${t('savedStats', { time: speed.savedAt ? language.resetDate(speed.savedAt) : '—' })}`
    : '';
  const saveWarning = data.persistenceError ? ` ${t('saveFailed')}` : '';
  setText(
    $('rate-note'),
    [language.errorMessage(data.error || data.sessionError), language.rateNote(speed)].filter(Boolean).join(' ') +
      savedNote +
      saveWarning,
  );
  const rateNoteEl = $('rate-note') as HTMLElement | null;
  if (rateNoteEl && !rateNoteEl.hidden) rateNoteEl.hidden = true;

  const cache = speed?.cache;
  setText($('cache-rate'), percent(cache?.hitRate));
  setText($('cache-detail-rate'), percent(cache?.hitRate));

  const tokens = (speed?.tokens || cache) as Partial<TokenSummary> | undefined;
  // Keep coverage in the data model; the compact card shows readable counters.
  const hasTotal =
    Boolean(tokens?.measuredRequests) &&
    Number.isSafeInteger(tokens?.totalTokens) &&
    (tokens?.totalTokens ?? -1) >= 0;
  setText($('cache-total'), hasTotal ? `${compact(tokens?.totalTokens)} tok` : '— tok');
  setText($('cache-coverage'), hasTotal ? `${count(tokens?.totalTokens)} tok` : '— tok');

  const inputCoverage = {
    uncachedTokens: 'uncachedRequests',
    cachedTokens: 'cachedRequests',
    cacheWriteTokens: 'cacheWriteRequests',
  } as const;
  for (const [field, id] of [
    ['cachedTokens', 'cache-read'],
    ['uncachedTokens', 'cache-miss'],
    ['cacheWriteTokens', 'cache-write'],
    ['outputTokens', 'cache-output'],
  ] as const) {
    const available =
      field === 'outputTokens'
        ? (tokens?.outputAvailable ?? tokens?.outputRequests ?? tokens?.measuredRequests)
        : (tokens?.[inputCoverage[field]] ?? tokens?.inputRequests ?? tokens?.measuredRequests);
    const val = tokens?.[field];
    const known = Number.isSafeInteger(val) && (val ?? -1) >= 0;
    setText($(id), available && known ? `${count(val)} tok` : '—');
  }
  toggleHidden($('cache-write-row') as HTMLElement | null, !((tokens?.cacheWriteTokens ?? 0) > 0));

  const task = speed?.taskUsage;
  if (task && task.subagents > 0) {
    toggleHidden($('task-tokens-row') as HTMLElement | null, false);
    toggleHidden($('subagent-tokens-row') as HTMLElement | null, false);
    setText(
      $('task-total-tokens'),
      `${count(task.tokens?.totalTokens)} tok${task.state === 'loading' ? ` (${t('loading')})` : ''}`,
    );
    setText($('subagent-tokens'), `${count(task.subagentTokens)} tok`);
    setText($('subagent-tokens-label'), t('taskTokensSubagents', { count: task.subagents }));
  } else {
    toggleHidden($('task-tokens-row') as HTMLElement | null, true);
    toggleHidden($('subagent-tokens-row') as HTMLElement | null, true);
  }
  toggleHidden($('cache-note') as HTMLElement | null, true);
}
