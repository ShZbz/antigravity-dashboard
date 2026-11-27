import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { AccountsResponse, MetricsRequestInput, SwitchAccountResponse } from '../../contracts/ipc.ts';
import type {
  ConnectionStatus,
  ConversationSummary,
  MetricsSnapshot,
  QuotaGroup,
  SpeedMetrics,
  TaskUsageSummary,
} from '../../contracts/metrics.ts';
import type { ClearTimelineResult } from '../../contracts/timeline.ts';
import {
  isNativeAccelAvailable,
  type SessionDescriptorInput,
  type SnapshotDiffOutput,
} from '../../platform/native-bridge.ts';
import { AntigravityClient, isNoLocalCredentialsError } from '../client/index.ts';
import { DelegatedUsage, type DelegatedClientLike } from '../delegation/delegated-usage.ts';
import {
  readLocalConversationSummaries,
  resolveLocalAntigravityDir,
} from '../reader/local-summaries.ts';
import { TranscriptReader } from '../reader/transcript.ts';
import { diffSessionSnapshotsWithFallback, parseSummaryMtimeMs } from '../snapshot-diff.ts';
import { TimelineStore } from '../timeline/store.ts';
import { SessionHistory } from './history.ts';
import { executeQuotaRefresh, handleDelegatedUpdate, loadCachedSession, runSessionPoll } from './session-runner.ts';
import {
  findSessionEntryIn,
  mapConversationSummaries,
  refreshAncestorUsageIn,
  resolveRootIdFrom,
  resolveTaskUsageIn,
  selectRootConversationFrom,
  summaryMetaFrom,
} from './session-state.ts';
import {
  GUID,
  HASH,
  type MetricsStoreOptions,
  type RawSummaryRecord,
  type SessionEntry,
  type StoreClientLike,
  type StoreDelegatedLike,
  type StoreHistoryLike,
  type StoreTimelineStoreLike,
  type StoreTranscriptsLike,
  type SummarySnapshotState,
  type TrajectorySummaryMeta,
} from './types.ts';

export type { MetricsStoreOptions } from './types.ts';

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const QUOTA_IDLE_TTL_MS = 30_000;
const QUOTA_IDLE_FORCE_TTL_MS = 90_000;
const QUOTA_ACTIVE_TTL_MS = 12_000;
const QUOTA_SETTLE_COOLDOWN_MS = 5_000;
const QUOTA_EXPIRED_RETRY_MS = 10_000;
const MAX_SESSIONS = 16;
const MAX_RECENT_BASE_METRICS = 2;
export const LOCAL_SQLITE_MODE_NOTICE = '当前版本已切换为本地 SQLite 直读模式（云端额度暂不可用）';

function hasExpiredQuotaWindow(groups: QuotaGroup[] | null, now: number): boolean {
  if (!Array.isArray(groups)) return false;
  for (const group of groups) {
    const windows = group?.windows;
    if (!windows || typeof windows !== 'object') continue;
    for (const win of Object.values(windows)) {
      if (!win || !win.available || typeof win.resetAt !== 'string') continue;
      const resetMs = Date.parse(win.resetAt);
      if (Number.isFinite(resetMs) && resetMs <= now) return true;
    }
  }
  return false;
}

export class MetricsStore {
  client: StoreClientLike;
  history: StoreHistoryLike;
  timelineStore: StoreTimelineStoreLike | null;
  modelTimelineEnabled: boolean;
  onTrajectory: ((scope: string, id: string, raw: unknown) => Promise<unknown> | unknown) | null;
  onAccount: ((scope: string, meta: { email: string; name: string }) => Promise<unknown> | unknown) | null;
  transcripts: StoreTranscriptsLike | null;
  delegated: StoreDelegatedLike | null;
  owns: () => boolean;
  resolveLocalIdentityFn: ((recentConversationIds: readonly string[]) => Promise<string | null> | string | null) | null;
  localFallbackActive = false;
  quota: QuotaGroup[] | null = null;
  quotaAt = 0;
  quotaForceAt = 0;
  quotaDirtyAt = 0;
  quotaSettledAt = 0;
  quotaPending: Promise<void> | null = null;
  quotaPendingForce = false;
  quotaRequestSeq = 0;
  quotaCommittedSeq = 0;
  supportsForceQuotaRefresh = true;
  identity: string | null = null;
  registeredAccount: { identity: string; email: string; name: string } | null = null;
  serverPid: number | null = null;
  summaries: ConversationSummary[] = [];
  rawSummaries: Record<string, RawSummaryRecord> | null = null;
  summariesAt = 0;
  summaryStates = new Map<string, SummarySnapshotState>();
  dirtySessionIds = new Set<string>();
  newlySettledSessionIds = new Set<string>();
  runningSessionIds = new Set<string>();
  lastSummaryDiff: SnapshotDiffOutput | null = null;
  sessions = new Map<string, SessionEntry>();
  ancestorPending = new Map<string, Promise<void>>();
  ancestorRaws = new Map<string, WeakRef<object>>();
  persistenceError: string | null = null;
  usagePersistenceError = false;
  epoch = 0;
  lastActiveConversationId: string | null = null;

  constructor(
    client: StoreClientLike = new AntigravityClient(),
    {
      history = new SessionHistory(),
      timelineStore = undefined,
      dataDir = null,
      modelTimelineEnabled = false,
      onTrajectory = null,
      onAccount = null,
      transcripts = new TranscriptReader(),
      delegated = null,
      owns = () => true,
      resolveLocalIdentity = null,
    }: MetricsStoreOptions = {},
  ) {
    this.client = client;
    this.history = history;
    this.timelineStore =
      timelineStore === null
        ? null
        : timelineStore ||
          new TimelineStore(
            dataDir ? join(dataDir, 'timeline-v1') : history?.directory ? join(dirname(history.directory), 'timeline-v1') : undefined,
          );
    this.modelTimelineEnabled = modelTimelineEnabled === true;
    this.onTrajectory = onTrajectory;
    this.onAccount = onAccount;
    this.transcripts = transcripts;
    this.owns = owns;
    this.resolveLocalIdentityFn = typeof resolveLocalIdentity === 'function' ? resolveLocalIdentity : null;
    this.client?.setModelTimelineEnabled?.(this.modelTimelineEnabled);
    this.delegated =
      delegated ||
      new DelegatedUsage(this.client as unknown as DelegatedClientLike, {
        owns: () => this.owns() === true,
        modelTimelineEnabled: this.modelTimelineEnabled,
        onSource: async (scope: string, id: string, raw: unknown) => {
          if (this.onTrajectory && scope) {
            try { await this.onTrajectory(scope, id, raw); } catch {}
          }
        },
        onUpdate: (scope: string, id: string, taskUsage: TaskUsageSummary, childIds: string[]) =>
          handleDelegatedUpdate(this, scope, id, taskUsage, childIds),
      });
    this.delegated?.setModelTimelineEnabled?.(this.modelTimelineEnabled);
  }

  setModelTimelineEnabled(enabled: boolean): boolean {
    const next = enabled === true;
    if (next === this.modelTimelineEnabled) return this.modelTimelineEnabled;
    this.modelTimelineEnabled = next;
    this.client?.setModelTimelineEnabled?.(next);
    this.delegated?.setModelTimelineEnabled?.(next);
    for (const entry of this.sessions.values()) {
      entry.updatedAt = 0;
      if (!next && entry.data) {
        entry.data = { ...entry.data, modelTimeline: null };
        entry.rawWeak = null; entry.rawRev = null; entry.withTimeline = false;
      }
    }
    return this.modelTimelineEnabled;
  }

  async clearTimeline(cascadeId: string | null = null): Promise<ClearTimelineResult> {
    const scope = this.identity;
    if (typeof cascadeId === 'string' && GUID.test(cascadeId)) {
      const norm = cascadeId.toLowerCase();
      for (const [key, entry] of this.sessions) {
        if (key.toLowerCase() === norm && entry.data) {
          entry.data = { ...entry.data, modelTimeline: null };
          entry.updatedAt = 0;
        }
      }
      if (scope && this.timelineStore) return await this.timelineStore.clear(scope, norm);
      return { cleared: true, scope: scope || null, cascadeId: norm };
    }
    return this.clearAllTimelines(scope ?? null);
  }

  async clearAllTimelines(scope: string | null = this.identity ?? null): Promise<ClearTimelineResult> {
    for (const entry of this.sessions.values()) {
      if (entry.data) entry.data = { ...entry.data, modelTimeline: null };
      entry.updatedAt = 0;
    }
    if (this.timelineStore) return await this.timelineStore.clearAll(scope);
    return { cleared: true, scope: scope || 'all' };
  }

  summaryMeta(id: string): TrajectorySummaryMeta | null {
    return summaryMetaFrom(this.rawSummaries, this.client?.reader?.summaries, id);
  }

  findSessionEntry(normId: string | null): { key: string; entry: SessionEntry } | null {
    return findSessionEntryIn(this.sessions, normId);
  }

  resolveRootId(id: string | null, fallbackMeta: TrajectorySummaryMeta | null = null): string | null {
    return resolveRootIdFrom(this.rawSummaries, this.client?.reader?.summaries, id, fallbackMeta);
  }

  selectRootConversation(summaries: ConversationSummary[] = [], fallbackId: string | null = null): string | null {
    return selectRootConversationFrom(this.rawSummaries, this.client?.reader?.summaries, summaries, fallbackId);
  }

  refreshAncestorUsage(scope: string, epoch: number, ancestorId: string, ancestorSaved: TaskUsageSummary | null, force: boolean): void {
    refreshAncestorUsageIn(this, scope, epoch, ancestorId, ancestorSaved, force);
  }

  resolveTaskUsage(
    scope: string | null,
    epoch: number,
    id: string,
    raw: unknown,
    options?: { existingData?: SpeedMetrics | null; force?: boolean; current?: () => boolean },
  ): Promise<{ taskUsage: TaskUsageSummary | null; delegatedConversations: string[] | undefined }> {
    return resolveTaskUsageIn(this, scope, epoch, id, raw, options);
  }

  cachedSession(id: string): Promise<SpeedMetrics | null> {
    return loadCachedSession(this, id, GUID);
  }

  private quotaRefreshPlan(force: boolean, now = Date.now()): { refresh: boolean; forceUpstream: boolean } {
    if (force) return { refresh: true, forceUpstream: true };
    if (!this.quota) return { refresh: true, forceUpstream: true };

    const age = now - this.quotaAt;
    const forceAge = now - this.quotaForceAt;
    if (hasExpiredQuotaWindow(this.quota, now) && age >= QUOTA_EXPIRED_RETRY_MS) {
      return { refresh: true, forceUpstream: true };
    }
    if (this.quotaSettledAt > this.quotaForceAt && forceAge >= QUOTA_SETTLE_COOLDOWN_MS) {
      return { refresh: true, forceUpstream: true };
    }
    const active = this.runningSessionIds.size > 0 || this.quotaDirtyAt > this.quotaForceAt;
    if (active && forceAge >= QUOTA_ACTIVE_TTL_MS) {
      return { refresh: true, forceUpstream: true };
    }
    if (forceAge >= QUOTA_IDLE_FORCE_TTL_MS) {
      return { refresh: true, forceUpstream: true };
    }
    if (age >= QUOTA_IDLE_TTL_MS) {
      return { refresh: true, forceUpstream: false };
    }
    return { refresh: false, forceUpstream: false };
  }

  async refreshQuota(force = false): Promise<void> {
    const plan = this.quotaRefreshPlan(force);
    if (!plan.refresh) return;
    if (this.quotaPending) {
      if (!plan.forceUpstream || this.quotaPendingForce) return this.quotaPending;
    }
    const seq = ++this.quotaRequestSeq;
    const pending = executeQuotaRefresh(this, {
      forceRefresh: plan.forceUpstream,
      requestSeq: seq,
    }).finally(() => {
      if (this.quotaPending === pending) {
        this.quotaPending = null;
        this.quotaPendingForce = false;
      }
    });
    this.quotaPending = pending;
    this.quotaPendingForce = plan.forceUpstream;
    return pending;
  }

  getSummaryDiff(): SnapshotDiffOutput | null {
    return this.lastSummaryDiff;
  }

  private clearSummaryDiffState(): void {
    this.summaryStates.clear();
    this.dirtySessionIds.clear();
    this.newlySettledSessionIds.clear();
    this.runningSessionIds.clear();
    this.lastSummaryDiff = null;
  }

  private resetForServerPid(pid: number): void {
    this.epoch++;
    this.delegated?.reset?.();
    this.transcripts?.reset();
    this.quota = null;
    this.quotaAt = 0;
    this.quotaForceAt = 0;
    this.quotaDirtyAt = 0;
    this.quotaSettledAt = 0;
    this.quotaPending = null;
    this.quotaPendingForce = false;
    this.quotaCommittedSeq = 0;
    this.quotaRequestSeq++;
    this.supportsForceQuotaRefresh = true;
    this.sessions.clear();
    this.ancestorPending.clear();
    this.ancestorRaws.clear();
    this.identity = null;
    this.registeredAccount = null;
    this.summaries = [];
    this.rawSummaries = null;
    this.summariesAt = 0;
    this.clearSummaryDiffState();
    this.serverPid = pid;
    this.lastActiveConversationId = null;
  }

  private async ensureLocalIdentity(
    localDir: { rootDir: string; conversationsDir: string },
    recentConversationIds: readonly string[],
  ): Promise<string | null> {
    if (this.identity && HASH.test(this.identity)) return this.identity;
    const epoch = this.epoch;
    let resolved: string | null = null;
    if (this.resolveLocalIdentityFn) {
      try {
        const candidate = await this.resolveLocalIdentityFn(recentConversationIds);
        if (typeof candidate === 'string' && HASH.test(candidate)) resolved = candidate;
      } catch {
        // Fall through to deterministic profile scope hash.
      }
    }
    if (epoch !== this.epoch) return this.identity;
    if (!resolved) {
      const pathInfo = this.client.paths?.();
      const profileKey = pathInfo?.profile || localDir.rootDir;
      const prefix = /antigravity-vertex/i.test(profileKey) ? 'vertex:' : 'local:';
      resolved = createHash('sha256').update(`${prefix}${profileKey}`).digest('hex');
    }
    this.identity = resolved;
    return resolved;
  }

  private commitSummaries(rawSummaries: Record<string, RawSummaryRecord>, mapped?: ConversationSummary[]): ConversationSummary[] {
    this.rawSummaries = rawSummaries;
    const now = Date.now();
    this.client?.reader?.seedSummaries?.(rawSummaries, now, this.client?.server);
    this.summaries = mapped ?? mapConversationSummaries(rawSummaries);
    this.summariesAt = now;

    const descriptors: SessionDescriptorInput[] = new Array(this.summaries.length);
    for (let i = 0; i < this.summaries.length; i++) {
      const item = this.summaries[i];
      const prev = this.summaryStates.get(item.id);
      descriptors[i] = {
        cascadeId: item.id,
        mtimeMs: parseSummaryMtimeMs(item.modifiedAt),
        sizeBytes: 0,
        stepCount: typeof item.stepCount === 'number' && Number.isFinite(item.stepCount) ? Math.trunc(item.stepCount) : 0,
        lastUserInputStepIndex:
          typeof item.lastUserInputStepIndex === 'number' && Number.isFinite(item.lastUserInputStepIndex)
            ? Math.trunc(item.lastUserInputStepIndex)
            : -1,
        status: item.status || '',
        prevFingerprint: prev?.fingerprint ?? null,
        prevSettled: prev ? prev.settled : null,
      };
    }
    const diff = diffSessionSnapshotsWithFallback(descriptors);
    this.lastSummaryDiff = diff;
    this.dirtySessionIds = new Set(diff.dirtyIds);
    this.newlySettledSessionIds = new Set(diff.newlySettledIds);
    this.runningSessionIds = new Set(diff.runningIds);
    if (this.runningSessionIds.size > 0 || this.dirtySessionIds.size > 0) {
      this.quotaDirtyAt = now;
    }
    if (this.newlySettledSessionIds.size > 0) {
      this.quotaDirtyAt = now;
      this.quotaSettledAt = now;
    }
    const nextStates = new Map<string, SummarySnapshotState>();
    for (const item of diff.items) {
      const settled = item.statusKind === 'settled';
      nextStates.set(item.cascadeId, {
        fingerprint: item.fingerprint,
        settled,
        statusKind: item.statusKind,
        preferSqlite: item.preferSqlite,
      });
      const entry = this.sessions.get(item.cascadeId);
      if (entry) {
        entry.summaryFingerprint = item.fingerprint;
        entry.summaryStatusKind = item.statusKind;
        entry.summarySettled = settled;
      }
    }
    this.summaryStates = nextStates;

    return this.summaries;
  }

  async listConversations(force = false): Promise<ConversationSummary[]> {
    if (!force && Date.now() - this.summariesAt < 5000) return this.summaries;
    const scope = this.identity;
    const epoch = this.epoch;
    if (this.localFallbackActive) {
      const localDir = resolveLocalAntigravityDir(this.client);
      if (localDir) {
        const local = await readLocalConversationSummaries(localDir.rootDir, {
          conversationsDir: localDir.conversationsDir,
          force,
        });
        if (scope !== this.identity || epoch !== this.epoch) throw new Error('后台已重新连接，请等待刷新');
        return this.commitSummaries(local.rawSummaries, local.summaries);
      }
    }
    let response: { trajectorySummaries?: Record<string, RawSummaryRecord> };
    try {
      response = await this.client.call('GetAllCascadeTrajectories');
    } catch (err) {
      if (isNoLocalCredentialsError(err)) {
        const localDir = resolveLocalAntigravityDir(this.client);
        if (localDir && isNativeAccelAvailable()) {
          this.localFallbackActive = true;
          const local = await readLocalConversationSummaries(localDir.rootDir, {
            conversationsDir: localDir.conversationsDir,
            force,
          });
          if (scope !== this.identity || epoch !== this.epoch) throw new Error('后台已重新连接，请等待刷新');
          return this.commitSummaries(local.rawSummaries, local.summaries);
        }
      }
      throw err;
    }
    if (scope !== this.identity || epoch !== this.epoch) throw new Error('后台已重新连接，请等待刷新');
    const rawSummaries: Record<string, RawSummaryRecord> = response.trajectorySummaries || {};
    return this.commitSummaries(rawSummaries);
  }

  touchSession(id: string, entry: SessionEntry): void {
    if (this.sessions.get(id) !== entry) return;
    this.sessions.delete(id);
    this.sessions.set(id, entry);
  }

  trimSessions(keepId: string | null = null): void {
    if (this.sessions.size <= MAX_SESSIONS) return;
    for (const [key, entry] of this.sessions) {
      if (this.sessions.size <= MAX_SESSIONS) break;
      if (entry.pending || key === keepId || key === this.lastActiveConversationId) continue;
      entry.baseMetrics = null;
      entry.rawWeak = null;
      entry.rawRev = null;
      this.sessions.delete(key);
    }
  }

  pruneBaseMetrics(): void {
    const keepFrom = Math.max(0, this.sessions.size - MAX_RECENT_BASE_METRICS);
    let idx = 0;
    for (const entry of this.sessions.values()) {
      const isRecent = idx >= keepFrom;
      idx++;
      if (!entry.baseMetrics) continue;
      const rawDead = entry.rawWeak != null && entry.rawWeak.deref() === undefined;
      if (rawDead || (!isRecent && !entry.pending)) {
        entry.baseMetrics = null;
        if (rawDead) {
          entry.rawWeak = null;
          entry.rawRev = null;
        }
      }
    }
  }

  async session(id: string, force = false): Promise<SpeedMetrics> {
    if (!GUID.test(id)) throw new Error('会话标识无效');
    let entry = this.sessions.get(id);
    if (entry) {
      this.touchSession(id, entry);
    }
    if (entry?.pending) return entry.pending;
    const summaryState = this.summaryStates.get(id);
    const summaryChanged =
      Boolean(summaryState && entry?.polledSummaryFingerprint !== summaryState.fingerprint) ||
      this.newlySettledSessionIds.has(id);
    if (!force && !summaryChanged && entry?.data && Date.now() - (entry.updatedAt ?? 0) < 1800) {
      this.pruneBaseMetrics();
      return entry.data;
    }
    if (!entry) {
      entry = {};
      this.sessions.set(id, entry);
      this.trimSessions(id);
    }
    entry.pending = runSessionPoll(this, id, entry, force).finally(() => {
      entry!.pending = null;
      this.trimSessions(id);
      this.pruneBaseMetrics();
    });
    return entry.pending;
  }

  private async runLocalSqliteSnapshot(
    localDir: { rootDir: string; conversationsDir: string },
    pidHint: number,
    conversationId: string | null | undefined,
    force: boolean,
  ): Promise<{
    connection: ConnectionStatus;
    error: string | null;
    speed: SpeedMetrics | null;
    sessionError: string | null;
    source: string;
  }> {
    const pid = Number.isSafeInteger(pidHint) && pidHint > 0 ? pidHint : -1;
    if (pid !== this.serverPid) {
      this.resetForServerPid(pid);
    }
    this.localFallbackActive = true;
    this.quota = null;
    this.quotaAt = 0;
    let sessionError: string | null = null;
    let speed: SpeedMetrics | null = null;
    if (conversationId && GUID.test(conversationId)) this.lastActiveConversationId = conversationId;
    let summaries = this.summaries;
    if (!conversationId) {
      try {
        summaries = await this.listConversations(force);
      } catch (e) {
        sessionError ||= errorMessage(e);
      }
    }
    const recentIds = [
      ...(conversationId && GUID.test(conversationId) ? [conversationId] : []),
      ...summaries.slice(0, 8).map((s) => s.id),
    ];
    await this.ensureLocalIdentity(localDir, recentIds);
    const selected = conversationId || this.selectRootConversation(summaries, this.lastActiveConversationId);
    if (selected) {
      try {
        speed = await this.session(selected, force);
      } catch (e) {
        sessionError = errorMessage(e);
      }
    }
    return {
      connection: 'live',
      error: LOCAL_SQLITE_MODE_NOTICE,
      speed,
      sessionError,
      source: 'Antigravity local SQLite',
    };
  }

  async snapshot({ conversationId, force = false }: MetricsRequestInput = {}): Promise<MetricsSnapshot> {
    let connection: ConnectionStatus = 'live';
    let error: string | null = null;
    let speed: SpeedMetrics | null = null;
    let sessionError: string | null = null;
    let source = 'Antigravity local API';
    try {
      const localDir = resolveLocalAntigravityDir(this.client);
      const canUseLocalSqlite = Boolean(localDir && isNativeAccelAvailable());
      let localDiscoverErr: ReturnType<typeof isNoLocalCredentialsError> extends boolean
        ? ({ pid?: number; port?: number } & Error) | null
        : null = null;
      let server: { pid: number; [key: string]: unknown } | null = null;
      try {
        server = await this.client.discover();
        this.localFallbackActive = false;
      } catch (discoverErr) {
        if (isNoLocalCredentialsError(discoverErr) && canUseLocalSqlite) {
          localDiscoverErr = discoverErr;
          this.localFallbackActive = true;
        } else {
          throw discoverErr;
        }
      }

      if (localDiscoverErr && localDir) {
        const localResult = await this.runLocalSqliteSnapshot(
          localDir,
          typeof localDiscoverErr.pid === 'number' ? localDiscoverErr.pid : -1,
          conversationId,
          force,
        );
        ({ connection, error, speed, sessionError, source } = localResult);
      } else {
        if (server!.pid !== this.serverPid) {
          this.resetForServerPid(server!.pid);
        }
        let fallbackToSqlite = false;
        try {
          await this.refreshQuota(force);
        } catch (e) {
          if (isNoLocalCredentialsError(e) && canUseLocalSqlite) {
            fallbackToSqlite = true;
          } else {
            connection = this.quota ? 'stale' : 'offline';
            error = errorMessage(e);
          }
        }
        if (!fallbackToSqlite) {
          if (conversationId && GUID.test(conversationId)) this.lastActiveConversationId = conversationId;
          let summaries = this.summaries;
          // The inline composer already supplies its exact ID. Enumerating every
          // conversation first adds unrelated RPC latency to a route transition.
          if (!conversationId) {
            try {
              summaries = await this.listConversations(force);
            } catch (e) {
              connection = this.quota ? 'stale' : 'offline';
              error ||= errorMessage(e);
            }
          }
          if (this.localFallbackActive && canUseLocalSqlite) {
            fallbackToSqlite = true;
          } else {
            const selected = conversationId || this.selectRootConversation(summaries, this.lastActiveConversationId);
            if (selected) {
              try {
                speed = await this.session(selected, force);
              } catch (e) {
                if (isNoLocalCredentialsError(e) && canUseLocalSqlite) {
                  fallbackToSqlite = true;
                } else {
                  sessionError = errorMessage(e);
                }
              }
            }
          }
        }
        if (fallbackToSqlite && localDir) {
          const localResult = await this.runLocalSqliteSnapshot(localDir, server!.pid, conversationId, force);
          ({ connection, error, speed, sessionError, source } = localResult);
        } else if (!force && connection === 'live' && this.quotaRefreshPlan(false).refresh) {
          void this.refreshQuota(false).catch(() => {});
        }
      }
    } catch (e) {
      this.localFallbackActive = false;
      connection = this.quota ? 'stale' : 'offline';
      error = errorMessage(e);
      const fallbackId = conversationId || this.selectRootConversation(this.summaries, this.lastActiveConversationId);
      if (fallbackId) speed = await this.cachedSession(fallbackId);
    }
    return {
      connection, error, sessionError,
      serverTime: new Date().toISOString(),
      quotaUpdatedAt: this.quotaAt ? new Date(this.quotaAt).toISOString() : null,
      groups: this.quota || [], speed, conversations: this.summaries,
      persistenceError: this.persistenceError, source,
    };
  }

  switchAccount(identity: string): SwitchAccountResponse {
    if (!identity || (identity !== 'all' && !HASH.test(identity))) throw new Error('Invalid account scope');
    return { success: true, active: identity, activeAccount: this.identity || identity };
  }

  setLocalIdentity(scope: string | null): boolean {
    if (scope !== null && (!scope || !HASH.test(scope))) {
      throw new Error('Invalid account scope');
    }
    if (scope === this.identity) return false;
    this.epoch++;
    this.delegated?.reset?.();
    this.transcripts?.reset();
    this.client.resetTrajectories?.();
    this.sessions.clear();
    this.ancestorPending.clear();
    this.ancestorRaws.clear();
    this.registeredAccount = null;
    this.identity = scope;
    return true;
  }

  async getAccounts(): Promise<AccountsResponse> {
    return {
      active: this.identity,
      accounts: this.identity ? [{ id: this.identity, name: `Account (${this.identity.slice(0, 8)})`, active: true }] : [],
    };
  }

  dispose(): void {
    this.epoch++;
    this.quotaPending = null;
    this.quotaPendingForce = false;
    this.quotaDirtyAt = 0;
    this.quotaSettledAt = 0;
    this.delegated?.dispose?.();
    this.transcripts?.dispose?.();
    this.sessions.clear();
    this.clearSummaryDiffState();
    this.ancestorPending.clear();
    this.ancestorRaws.clear();
  }
}
