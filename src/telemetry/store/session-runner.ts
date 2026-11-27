import { createHash } from 'node:crypto';
import type { SpeedMetrics, TaskUsageSummary } from '../../contracts/metrics.ts';
import type { ModelTimelineSnapshot } from '../../contracts/timeline.ts';
import { normalizeConversationId } from '../delegation/delegation.ts';
import { quotaMetrics, trajectoryMetrics } from '../metrics/index.ts';
import { buildModelTimeline } from '../timeline/index.ts';
import { sameStringList, sameTaskUsage, sameTranscriptStats } from './equality.ts';
import { reconcileMetrics, usableMetrics } from './history.ts';
import { resolveTaskUsageIn } from './session-state.ts';
import type {
  AncestorResolutionHost,
  SessionEntry,
  StoreTimelineStoreLike,
  StoreTranscriptsLike,
  SummarySnapshotState,
} from './types.ts';
import type { SnapshotDiffOutput } from '../../platform/native-bridge.ts';

export interface SessionRunnerHost extends AncestorResolutionHost {
  timelineStore: StoreTimelineStoreLike | null;
  transcripts: StoreTranscriptsLike | null;
  persistenceError: string | null;
  usagePersistenceError: boolean;
  quotaDirtyAt?: number;
  quotaSettledAt?: number;
  onTrajectory: ((scope: string, id: string, raw: unknown) => Promise<unknown> | unknown) | null;
  touchSession?: (id: string, entry: SessionEntry) => void;
  trimSessions?: (keepId?: string | null) => void;
  pruneBaseMetrics?: () => void;
}

export interface QuotaRefreshHost {
  client: AncestorResolutionHost['client'];
  delegated: AncestorResolutionHost['delegated'];
  transcripts: StoreTranscriptsLike | null;
  sessions: Map<string, SessionEntry>;
  ancestorPending: AncestorResolutionHost['ancestorPending'];
  ancestorRaws: AncestorResolutionHost['ancestorRaws'];
  rawSummaries: AncestorResolutionHost['rawSummaries'];
  summaries: unknown[];
  summariesAt: number;
  summaryStates?: Map<string, SummarySnapshotState>;
  dirtySessionIds?: Set<string>;
  newlySettledSessionIds?: Set<string>;
  runningSessionIds?: Set<string>;
  lastSummaryDiff?: SnapshotDiffOutput | null;
  quota: ReturnType<typeof quotaMetrics> | null;
  quotaAt: number;
  quotaForceAt?: number;
  quotaDirtyAt?: number;
  quotaSettledAt?: number;
  quotaCommittedSeq?: number;
  supportsForceQuotaRefresh?: boolean;
  identity: string | null;
  registeredAccount: { identity: string; email: string; name: string } | null;
  epoch: number;
  onAccount: ((scope: string, meta: { email: string; name: string }) => Promise<unknown> | unknown) | null;
}

export interface ExecuteQuotaRefreshOptions {
  forceRefresh?: boolean;
  requestSeq?: number;
}

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function handleDelegatedUpdate(
  host: SessionRunnerHost & { resolveRootId(id: string | null): string | null },
  scope: string,
  id: string,
  taskUsage: TaskUsageSummary,
  childIds: string[],
): Promise<void> {
  const entry = host.sessions.get(id);
  if (entry?.data && scope === host.identity) {
    const rawObj = entry.rawWeak?.deref?.() || host.client?.reader?.entries?.get?.(id)?.data || null;
    let modelTimeline: ModelTimelineSnapshot | null =
      host.modelTimelineEnabled && rawObj
        ? buildModelTimeline(rawObj, {
            cascadeId: id,
            metrics: entry.baseMetrics || entry.data,
            subagentItems: host.delegated?.getTimelineChildren?.(id) || [],
          })
        : host.modelTimelineEnabled
          ? entry.data.modelTimeline || null
          : null;
    if (modelTimeline && host.timelineStore && host.owns() === true) {
      try { modelTimeline = (await host.timelineStore.save(scope, id, modelTimeline)) || modelTimeline; } catch {}
    }
    entry.data = { ...entry.data, taskUsage, modelTimeline };
    if (childIds?.length) entry.data.delegatedConversations = childIds;
    entry.updatedAt = Date.now();
    try {
      const saved = await host.history.save(scope, id, entry.data);
      if (saved) entry.savedAt = saved.savedAt ?? null;
    } catch {}
  }
  const normRoot = normalizeConversationId(id);
  if (normRoot && taskUsage && scope === host.identity) {
    for (const [sid, childEntry] of host.sessions) {
      if (normalizeConversationId(sid) === normRoot || !childEntry?.data) continue;
      if (childEntry.data.delegatedConversations?.length) continue;
      if (host.resolveRootId(sid) === normRoot) childEntry.data = { ...childEntry.data, taskUsage };
    }
  }
}

export async function loadCachedSession(host: SessionRunnerHost, id: string, guid: RegExp): Promise<SpeedMetrics | null> {
  if (!guid.test(id) || !host.identity) return null;
  const scope = host.identity;
  const epoch = host.epoch;
  const entry = host.sessions.get(id);
  if (entry?.data && usableMetrics(entry.data)) {
    host.touchSession?.(id, entry);
    let modelTimeline = host.modelTimelineEnabled ? entry.data.modelTimeline || null : null;
    if (host.modelTimelineEnabled && !modelTimeline && host.timelineStore) {
      modelTimeline = await host.timelineStore.load(scope, id).catch(() => null);
    }
    return {
      ...entry.data, modelTimeline,
      transcriptRestoredFromHistory: !!entry.data.transcriptStats, restoredFromHistory: true, savedAt: entry.savedAt || null,
    };
  }
  const saved = await host.history.load(scope, id);
  if (scope !== host.identity || epoch !== host.epoch || !saved) return null;
  const modelTimeline = host.modelTimelineEnabled && host.timelineStore ? await host.timelineStore.load(scope, id).catch(() => null) : null;
  if (scope !== host.identity || epoch !== host.epoch) return null;
  const restored: SpeedMetrics = { ...saved.metrics, modelTimeline };
  if (!host.sessions.has(id)) {
    host.sessions.set(id, { data: restored, savedAt: saved.savedAt, updatedAt: 0, withTimeline: host.modelTimelineEnabled });
    host.trimSessions?.(id);
    host.pruneBaseMetrics?.();
  }
  return { ...restored, transcriptRestoredFromHistory: !!saved.metrics.transcriptStats, restoredFromHistory: true, savedAt: saved.savedAt };
}

async function callRetrieveUserQuota(host: QuotaRefreshHost, forceRefresh: boolean): Promise<unknown> {
  if (!forceRefresh || host.supportsForceQuotaRefresh === false) {
    return host.client.call('RetrieveUserQuotaSummary');
  }
  try {
    return await host.client.call('RetrieveUserQuotaSummary', { forceRefresh: true });
  } catch (error) {
    const status = (error as { status?: unknown } | null | undefined)?.status;
    if (status === 400) {
      host.supportsForceQuotaRefresh = false;
      return host.client.call('RetrieveUserQuotaSummary');
    }
    throw error;
  }
}

export async function executeQuotaRefresh(
  host: QuotaRefreshHost,
  { forceRefresh = false, requestSeq }: ExecuteQuotaRefreshOptions = {},
): Promise<void> {
  const epoch = host.epoch;
  const [userRes, quotaRes] = await Promise.allSettled([
    host.client.call('GetUserStatus'),
    callRetrieveUserQuota(host, forceRefresh),
  ]);
  if (epoch !== host.epoch) throw new Error('后台已重新连接，请等待刷新');
  if (userRes.status === 'rejected') throw userRes.reason;
  const user = userRes.value;
  const email: string | null =
    user.userStatus?.email ||
    (user.userStatus ? `vertex:${host.client.paths?.()?.profile || process.env.GOOGLE_CLOUD_PROJECT || process.env.USERPROFILE || 'local'}` : null);
  const identity = email ? createHash('sha256').update(email).digest('hex') : null;
  if (identity !== host.identity) {
    host.delegated?.reset?.(); host.transcripts?.reset(); host.client.resetTrajectories?.();
    host.quota = null; host.quotaAt = 0;
    host.quotaForceAt = 0; host.quotaDirtyAt = 0; host.quotaSettledAt = 0;
    host.sessions.clear(); host.ancestorPending.clear(); host.ancestorRaws.clear();
    host.summaries = []; host.rawSummaries = null; host.summariesAt = 0; host.registeredAccount = null;
    host.summaryStates?.clear(); host.dirtySessionIds?.clear(); host.newlySettledSessionIds?.clear(); host.runningSessionIds?.clear();
    if ('lastSummaryDiff' in host) host.lastSummaryDiff = null;
  }
  host.identity = identity;
  const accountName: string = user.userStatus?.name || email || '';
  let accountPromise: Promise<void> | null = null;
  if (
    identity && email &&
    (host.registeredAccount?.identity !== identity || host.registeredAccount?.email !== email || host.registeredAccount?.name !== accountName)
  ) {
    accountPromise = Promise.resolve()
      .then(() => host.onAccount?.(identity, { email, name: accountName }))
      .then(() => { if (epoch === host.epoch && identity === host.identity) host.registeredAccount = { identity, email, name: accountName }; })
      .catch(() => {});
  }
  if (quotaRes.status === 'rejected') { if (accountPromise) await accountPromise; throw quotaRes.reason; }
  if (accountPromise) await accountPromise;
  if (epoch !== host.epoch || identity !== host.identity) throw new Error('后台已重新连接，请等待刷新');
  if (requestSeq !== undefined && host.quotaCommittedSeq !== undefined && requestSeq < host.quotaCommittedSeq) {
    return;
  }
  host.quota = quotaMetrics(quotaRes.value);
  const completedAt = Date.now();
  host.quotaAt = completedAt;
  if (forceRefresh) host.quotaForceAt = completedAt;
  if (requestSeq !== undefined) host.quotaCommittedSeq = requestSeq;
}

async function saveSessionTimeline(
  host: SessionRunnerHost,
  scope: string | null,
  id: string,
  raw: unknown,
  metrics: SpeedMetrics,
): Promise<ModelTimelineSnapshot | null> {
  if (host.modelTimelineEnabled !== true) return null;
  let modelTimeline = buildModelTimeline(raw, {
    cascadeId: id, metrics, subagentItems: host.delegated?.getTimelineChildren?.(id) || [],
  });
  if (modelTimeline && scope && host.timelineStore && host.owns() === true) {
    try { modelTimeline = (await host.timelineStore.save(scope, id, modelTimeline)) || modelTimeline; } catch {}
  }
  return modelTimeline;
}

async function persistSessionHistory(
  host: SessionRunnerHost, scope: string | null, id: string, entry: SessionEntry, current: () => boolean,
): Promise<void> {
  if (!scope || !entry.data) return;
  try {
    const nextSaved = await host.history.save(scope, id, entry.data);
    if (nextSaved) entry.savedAt = nextSaved.savedAt ?? null;
    if (current()) host.persistenceError = null;
  } catch {
    host.persistenceError = '统计暂时无法保存到本地';
  }
}

function markSessionSummaryPolled(host: SessionRunnerHost, id: string, entry: SessionEntry): void {
  const summaryState = host.summaryStates?.get(id);
  if (summaryState) {
    entry.summaryFingerprint = summaryState.fingerprint;
    entry.summaryStatusKind = summaryState.statusKind;
    entry.summarySettled = summaryState.settled;
    entry.polledSummaryFingerprint = summaryState.fingerprint;
  }
  host.dirtySessionIds?.delete(id);
  host.newlySettledSessionIds?.delete(id);
}

export async function runSessionPoll(
  host: SessionRunnerHost, id: string, entry: SessionEntry, force: boolean,
): Promise<SpeedMetrics> {
  const scope = host.identity;
  const epoch = host.epoch;
  const current = (): boolean => scope === host.identity && epoch === host.epoch && host.sessions.get(id) === entry;
  try {
    const timelineEnabled = host.modelTimelineEnabled === true;
    const savedPromise = !entry.data && scope ? host.history.load(scope, id).catch(() => null) : null;
    const trajectoryPromise = host.client.trajectory(id, { force, modelTimelineEnabled: timelineEnabled });
    let saved: { metrics: SpeedMetrics; savedAt?: string | null } | null = null;
    let raw: unknown;
    try { [saved, raw] = await Promise.all([savedPromise, trajectoryPromise]); } catch (error) {
      if (savedPromise && !entry.data) {
        saved = await savedPromise;
        if (current() && saved && !entry.data) { entry.data = { ...saved.metrics, modelTimeline: null }; entry.savedAt = saved.savedAt ?? null; }
      }
      throw error;
    }
    if (!current()) throw new Error('后台已重新连接，请等待刷新');
    if (saved && !entry.data) { entry.data = { ...saved.metrics, modelTimeline: null }; entry.savedAt = saved.savedAt ?? null; }
    const readerEntry = host.client?.reader?.entries?.get?.(id);
    const readerRev = readerEntry && readerEntry.data === raw ? (readerEntry.rev ?? 0) : null;
    const prevRaw = entry.rawWeak?.deref?.() ?? null;
    const sameRaw =
      !force && entry.withTimeline === timelineEnabled && readerRev !== null &&
      prevRaw === raw && entry.rawRev === readerRev && entry.baseMetrics && entry.data && !entry.data.restoredFromHistory;
    if (sameRaw && !host.usagePersistenceError && !host.persistenceError) {
      const prev = entry.data!;
      let nextTranscript = prev.transcriptStats;
      try { if (scope && host.transcripts) nextTranscript = host.transcripts.request(scope, id, raw); } catch {}
      const { taskUsage: nextTaskUsage, delegatedConversations: nextDelegated } = await resolveTaskUsageIn(
        host, scope, epoch, id, raw, { existingData: prev, force, current },
      );
      if (!current()) throw new Error('后台已重新连接，请等待刷新');
      if (sameTranscriptStats(nextTranscript, prev.transcriptStats) && sameTaskUsage(nextTaskUsage, prev.taskUsage) && sameStringList(nextDelegated, prev.delegatedConversations)) {
        entry.updatedAt = Date.now();
        host.touchSession?.(id, entry);
        host.pruneBaseMetrics?.();
        markSessionSummaryPolled(host, id, entry);
        return prev;
      }
      const fresh: SpeedMetrics = { ...entry.baseMetrics! };
      if (nextTranscript) fresh.transcriptStats = nextTranscript;
      if (nextTaskUsage) fresh.taskUsage = nextTaskUsage;
      if (nextDelegated) fresh.delegatedConversations = nextDelegated;
      const modelTimeline = await saveSessionTimeline(host, scope, id, raw, entry.baseMetrics!);
      entry.data = { ...reconcileMetrics(prev, fresh, entry.savedAt || null), conversationId: id, modelTimeline };
      entry.updatedAt = Date.now();
      host.touchSession?.(id, entry);
      host.pruneBaseMetrics?.();
      await persistSessionHistory(host, scope, id, entry, current);
      if (!current()) throw new Error('后台已重新连接，请等待刷新');
      markSessionSummaryPolled(host, id, entry);
      return entry.data;
    }
    if (host.onTrajectory && scope) {
      try { await host.onTrajectory(scope, id, raw); if (current()) host.usagePersistenceError = false; }
      catch { if (current()) host.usagePersistenceError = true; }
    }
    if (!current()) throw new Error('后台已重新连接，请等待刷新');
    const baseMetrics = trajectoryMetrics(raw);
    const fresh: SpeedMetrics = { ...baseMetrics };
    // Optional background I/O cannot delay or fail the core metrics request.
    try { if (scope && host.transcripts) fresh.transcriptStats = host.transcripts.request(scope, id, raw); } catch {}
    const { taskUsage, delegatedConversations } = await resolveTaskUsageIn(
      host, scope, epoch, id, raw, { existingData: entry.data, force, current },
    );
    if (!current()) throw new Error('后台已重新连接，请等待刷新');
    if (taskUsage) fresh.taskUsage = taskUsage;
    if (delegatedConversations) fresh.delegatedConversations = delegatedConversations;
    const modelTimeline = await saveSessionTimeline(host, scope, id, raw, baseMetrics);
    if (!current()) throw new Error('后台已重新连接，请等待刷新');
    const prevRequests = entry.data?.requests ?? 0;
    const prevOutput = entry.data?.counts?.output ?? 0;
    const prevRunning = entry.data?.status === 'CASCADE_RUN_STATUS_RUNNING';
    entry.data = { ...reconcileMetrics(entry.data, fresh, entry.savedAt || null), conversationId: id, modelTimeline };
    const nextRequests = entry.data.requests ?? 0;
    const nextOutput = entry.data.counts?.output ?? 0;
    const nextRunning = entry.data.status === 'CASCADE_RUN_STATUS_RUNNING';
    if (nextRequests > prevRequests || nextOutput > prevOutput || nextRunning) {
      host.quotaDirtyAt = Date.now();
    }
    if ((prevRunning && !nextRunning) || (nextRequests > prevRequests && !nextRunning)) {
      host.quotaSettledAt = Date.now();
    }
    entry.updatedAt = Date.now();
    entry.rawWeak = readerRev !== null && raw && typeof raw === 'object' ? new WeakRef(raw) : null;
    entry.rawRev = readerRev;
    entry.withTimeline = timelineEnabled;
    entry.baseMetrics = readerRev !== null ? baseMetrics : null;
    host.touchSession?.(id, entry);
    host.pruneBaseMetrics?.();
    await persistSessionHistory(host, scope, id, entry, current);
    if (!current()) throw new Error('后台已重新连接，请等待刷新');
    markSessionSummaryPolled(host, id, entry);
    return entry.data;
  } catch (error) {
    if (current() && entry.data && usableMetrics(entry.data)) {
      entry.updatedAt = Date.now();
      entry.rawWeak = null; entry.rawRev = null; entry.baseMetrics = null;
      const updating = errorMessage(error) === '会话仍在更新，请等待下一次刷新';
      const status = updating ? 'CASCADE_RUN_STATUS_RUNNING' : entry.data.status;
      let modelTimeline = host.modelTimelineEnabled ? entry.data.modelTimeline || null : null;
      if (host.modelTimelineEnabled && !modelTimeline && scope && host.timelineStore) {
        modelTimeline = await host.timelineStore.load(scope, id).catch(() => null);
      }
      entry.data = { ...entry.data, modelTimeline, status, transcriptRestoredFromHistory: !!entry.data.transcriptStats, restoredFromHistory: true, savedAt: entry.savedAt || null };
      return entry.data;
    }
    throw error;
  }
}
