import {
  isNativeAccelAvailable,
  readSqliteConversationMeta,
  readSqliteTrajectory,
} from '../../platform/native-bridge.ts';
import { isNoLocalCredentialsError } from '../client/server-discovery.ts';
import {
  defaultConversationsDir,
  resolveLocalConversationDbPath,
} from './local-conversations.ts';
import { resolveLocalAntigravityDir, statSqliteDbStamp } from './local-summaries.ts';
import { readRemoteTrajectory, scheduleRemoteBackfill } from './remote-reader.ts';
import { extractPlanModelFromSteps, normalizeRemoteSnapshot, settled, TOOL_STEP, unavailable } from './remote-snapshot.ts';

function normalizeSqliteStatus(rawStatus: unknown, summaryStatus?: unknown): string {
  if (typeof summaryStatus === 'string' && summaryStatus.trim()) return summaryStatus.trim();
  const s = typeof rawStatus === 'string' ? rawStatus.trim() : '';
  if (!s) return 'CASCADE_RUN_STATUS_IDLE';
  if (/^CASCADE_RUN_STATUS_/.test(s)) return s;
  if (/RUNNING|GENERATING|PENDING|WAITING|QUEUED/i.test(s)) return 'CASCADE_RUN_STATUS_RUNNING';
  return 'CASCADE_RUN_STATUS_IDLE';
}

export { normalizeRemoteSnapshot };
import type {
  ProjectedStep,
  RawGeneratorMetadataLike,
  RemoteReaderHost,
  TrajectoryCacheEntry,
  TrajectoryReaderClient,
  TrajectoryResult,
  TrajectorySummaryLike,
} from './types.ts';

const INACTIVE_IDLE_BYTES_CAP = 2 * 1024 * 1024;
type TimestampedTrajectoryEntry = TrajectoryCacheEntry & { lastAccessedAt?: number };

export interface TrajectoryReaderOptions {
  budgetBytes?: number;
  idleRecheckMs?: number;
  modelTimelineEnabled?: boolean;
  conversationsDir?: string | null;
}

export interface ReadTrajectoryOptions {
  summary?: TrajectorySummaryLike;
  force?: boolean;
  isCurrent?: () => boolean;
  modelTimelineEnabled?: boolean;
  conversationsDir?: string | null;
}

/**
 * Bounded-memory incremental reader for local and remote Antigravity trajectories.
 */
export class TrajectoryReader implements RemoteReaderHost {
  // Serialized statistics budget, not transcript/response size. Local resource
  // experiments cover 1K/8K/32K records; 8 MiB bounds retained objects well below
  // the 32K-record case (~100 MiB extra heap). See docs/LONG_CONVERSATIONS.md.
  client: TrajectoryReaderClient;
  budgetBytes: number;
  idleRecheckMs: number;
  modelTimelineEnabled: boolean;
  conversationsDir: string | null;
  entries = new Map<string, TrajectoryCacheEntry>();
  epoch = 0;
  endpoint: Record<string, unknown> | null = null;
  summaries: Record<string, TrajectorySummaryLike> | null = null;
  summaryAt = -Infinity;
  summaryPending: Promise<void> | null = null;
  cachedBytes = 0;
  onTrajectory?: (id: string, data: TrajectoryResult) => void;

  constructor(
    client: TrajectoryReaderClient,
    {
      budgetBytes = 8 * 1024 * 1024,
      idleRecheckMs = 10000,
      modelTimelineEnabled = client?.modelTimelineEnabled === true,
      conversationsDir = null,
    }: TrajectoryReaderOptions = {},
  ) {
    this.client = client;
    this.budgetBytes = budgetBytes;
    this.idleRecheckMs = idleRecheckMs;
    this.modelTimelineEnabled = modelTimelineEnabled === true;
    this.conversationsDir =
      conversationsDir ??
      (client as { conversationsDir?: string | null } | null)?.conversationsDir ??
      null;
  }

  setModelTimelineEnabled(enabled: boolean): boolean {
    this.modelTimelineEnabled = enabled === true;
    return this.modelTimelineEnabled;
  }

  isTimelineEnabled(options?: { modelTimelineEnabled?: boolean }): boolean {
    return (options?.modelTimelineEnabled ?? this.modelTimelineEnabled ?? this.client?.modelTimelineEnabled) === true;
  }

  callStepRpc<T = Record<string, unknown>>(method: string, body: Record<string, unknown>, wantTimeline: boolean): Promise<T> {
    const clientTimeline = this.client?.modelTimelineEnabled === true;
    if (wantTimeline !== clientTimeline) return this.client.call<T>(method, body, true, { modelTimelineEnabled: wantTimeline });
    return this.client.call<T>(method, body);
  }

  reset(): void {
    this.epoch++;
    this.entries.clear();
    this.summaries = null;
    this.summaryAt = -Infinity;
    this.summaryPending = null;
    this.cachedBytes = 0;
  }

  seedSummaries(
    summaries: Record<string, TrajectorySummaryLike> | null | undefined,
    at = this.client.now(),
    endpoint = this.client.server,
  ): void {
    if (!summaries || typeof summaries !== 'object') return;
    if (endpoint) {
      if (this.endpoint && ['pid', 'port', 'csrf'].some((k) => this.endpoint![k] !== endpoint[k])) return;
      if (!this.endpoint) this.endpoint = endpoint;
    }
    this.summaries = summaries;
    this.summaryAt = at;
  }

  private currentNow(): number {
    return typeof this.client?.now === 'function' ? this.client.now() : Date.now();
  }

  private touchEntry(entry: TrajectoryCacheEntry): void {
    (entry as TimestampedTrajectoryEntry).lastAccessedAt = this.currentNow();
  }

  trim(keep?: string): void {
    for (const [key, e] of this.entries) {
      if (this.cachedBytes <= this.budgetBytes) break;
      if (key === keep || e.pending) continue;
      this.cachedBytes -= e.bytes;
      this.entries.delete(key);
    }
  }

  trimIdle(maxAgeMs = 180_000, keepIds?: ReadonlySet<string>): number {
    const now = this.currentNow();
    const isKept = (key: string): boolean =>
      Boolean(keepIds && (keepIds.has(key) || keepIds.has(key.toLowerCase())));
    let evicted = 0;

    for (const [key, e] of [...this.entries]) {
      if (isKept(key) || e.pending || e.backfilling) continue;
      const accessedAt = (e as TimestampedTrajectoryEntry).lastAccessedAt ?? e.verifiedAt ?? 0;
      if (now - accessedAt >= maxAgeMs) {
        this.cachedBytes = Math.max(0, this.cachedBytes - e.bytes);
        this.entries.delete(key);
        evicted++;
      }
    }

    const inactiveCap = Math.min(this.budgetBytes, INACTIVE_IDLE_BYTES_CAP);
    let inactiveBytes = 0;
    for (const [key, e] of this.entries) {
      if (!isKept(key) && !e.pending && !e.backfilling) {
        inactiveBytes += e.bytes;
      }
    }
    if (inactiveBytes > inactiveCap) {
      for (const [key, e] of [...this.entries]) {
        if (inactiveBytes <= inactiveCap) break;
        if (isKept(key) || e.pending || e.backfilling) continue;
        inactiveBytes -= e.bytes;
        this.cachedBytes = Math.max(0, this.cachedBytes - e.bytes);
        this.entries.delete(key);
        evicted++;
      }
    }

    return evicted;
  }

  async summary(id: string, provided?: TrajectorySummaryLike, force = false): Promise<TrajectorySummaryLike> {
    if (provided) return provided;
    if (force || !this.summaries || this.client.now() - this.summaryAt >= 1800) {
      if (!this.summaryPending) {
        const epoch = this.epoch;
        const pending = this.client
          .call<{ trajectorySummaries?: Record<string, TrajectorySummaryLike> }>('GetAllCascadeTrajectories')
          .then((r) => {
            if (epoch !== this.epoch) throw unavailable();
            this.summaries = r.trajectorySummaries || {};
            this.summaryAt = this.client.now();
          })
          .finally(() => {
            if (this.summaryPending === pending) this.summaryPending = null;
          });
        this.summaryPending = pending;
      }
      await this.summaryPending;
    }
    const s = this.summaries?.[id];
    if (!s) throw new Error('会话暂时没有可用统计');
    return s;
  }

  async read(
    id: string,
    {
      summary: provided,
      force = false,
      isCurrent = () => true,
      modelTimelineEnabled,
      conversationsDir,
    }: ReadTrajectoryOptions = {},
  ): Promise<TrajectoryResult> {
    if (!isCurrent()) throw unavailable();
    const wantTimeline = this.isTimelineEnabled({ modelTimelineEnabled });
    let endpoint: Record<string, unknown>;
    let localSqliteOnly = false;
    try {
      endpoint = await this.client.discover();
    } catch (discoverErr) {
      if (!isNoLocalCredentialsError(discoverErr)) throw discoverErr;
      const hasLocalRoot = Boolean(conversationsDir || resolveLocalAntigravityDir(this.client));
      if (!hasLocalRoot || !isNativeAccelAvailable()) throw discoverErr;
      endpoint = { pid: discoverErr.pid, port: discoverErr.port, csrf: '__local_sqlite__' };
      localSqliteOnly = true;
    }
    if (!this.endpoint) this.endpoint = endpoint;
    else if (['pid', 'port', 'csrf'].some((k) => this.endpoint![k] !== endpoint[k])) {
      this.reset();
      this.endpoint = endpoint;
    }
    let entry = this.entries.get(id);
    if (entry?.pending) {
      this.touchEntry(entry);
      return entry.pending;
    }
    if (!entry) {
      entry = { data: null, bytes: 0, withTimeline: false };
      this.entries.set(id, entry);
    }
    this.touchEntry(entry);
    const epoch = this.epoch;
    const current = (): boolean => epoch === this.epoch && this.entries.get(id) === entry && isCurrent();
    const assertCurrent = (): void => { if (!current()) throw unavailable(); };
    const activeEntry = entry;
    activeEntry.pending = (
      localSqliteOnly
        ? this.loadLocalDirectEntry(id, activeEntry, provided, force, wantTimeline, assertCurrent, conversationsDir)
        : this.loadEntry(id, activeEntry, provided, force, wantTimeline, assertCurrent, conversationsDir)
    ).finally(() => {
      activeEntry.pending = null;
      if (!activeEntry.data && current()) this.entries.delete(id);
      else if (activeEntry.data && current()) this.touchEntry(activeEntry);
      if (current()) this.trim(id);
    });
    return activeEntry.pending;
  }

  resolveDbPath(id: string, explicitDir?: string | null): string | null {
    const dir =
      explicitDir ??
      this.conversationsDir ??
      (this.client as { conversationsDir?: string | null } | null)?.conversationsDir ??
      null;
    if (dir) {
      return resolveLocalConversationDbPath(id, dir);
    }
    if (!this.client || Object.hasOwn(this.client, 'call')) {
      return null;
    }
    const pathsFn = (this.client as { paths?: () => { home?: string; conversationsDir?: string } }).paths;
    if (typeof pathsFn !== 'function') return null;
    try {
      const p = pathsFn.call(this.client);
      if (typeof p?.conversationsDir === 'string' && p.conversationsDir) {
        return resolveLocalConversationDbPath(id, p.conversationsDir);
      }
      if (typeof p?.home === 'string' && p.home) {
        const profile = (this.client as { profile?: unknown }).profile;
        const host = typeof profile === 'string' && profile.length > 0 ? 'ide' : 'app';
        return resolveLocalConversationDbPath(id, defaultConversationsDir(host, p.home));
      }
    } catch {
      return null;
    }
    return null;
  }

  private readFromSqlite(
    id: string,
    dbPath: string,
    resolvedSummary: TrajectorySummaryLike | null,
    wantTimeline: boolean,
    allowPartialCount = false,
  ): TrajectoryResult | null {
    if (!isNativeAccelAvailable()) return null;
    const raw = readSqliteTrajectory<TrajectoryResult>(dbPath, id, {
      modelTimelineEnabled: wantTimeline,
      maxOutputBytes: this.budgetBytes,
    });
    if (
      !raw ||
      !raw.trajectory ||
      !Array.isArray(raw.trajectory.steps) ||
      !Array.isArray(raw.trajectory.generatorMetadata)
    ) {
      return null;
    }
    const count =
      resolvedSummary?.stepCount === undefined ? null : Number(resolvedSummary.stepCount);
    const numSteps = raw.trajectory.steps.length;
    const numGens = raw.trajectory.generatorMetadata.length;
    if (!allowPartialCount) {
      if (count !== null && Number.isSafeInteger(count) && count >= 0) {
        if (numSteps < count) return null;
        if (count > 0 && numSteps === 0 && numGens === 0) return null;
      } else if (numSteps === 0 && numGens === 0) {
        return null;
      }
    } else if (numSteps === 0 && numGens === 0) {
      return null;
    }
    const meta = readSqliteConversationMeta(dbPath, id);
    const status = normalizeSqliteStatus(raw.status, resolvedSummary?.status);
    return {
      ...raw,
      status,
      numTotalSteps: numSteps,
      numTotalGeneratorMetadata: numGens,
      ...(meta ? { trajectoryMetadata: meta } : {}),
    } as TrajectoryResult;
  }

  private async loadLocalDirectEntry(
    id: string,
    entry: TrajectoryCacheEntry,
    provided: TrajectorySummaryLike | undefined,
    force: boolean,
    wantTimeline: boolean,
    assertCurrent: () => void,
    conversationsDir?: string | null,
  ): Promise<TrajectoryResult> {
    const dbPath = this.resolveDbPath(id, conversationsDir);
    if (!dbPath || !isNativeAccelAvailable()) throw new Error('会话暂时没有可用统计');
    const stamp = await statSqliteDbStamp(dbPath);
    assertCurrent();
    if (!stamp) throw new Error('会话暂时没有可用统计');
    const mark = `sqlite:${stamp}`;
    if (!force && entry.data && entry.withTimeline === wantTimeline && entry.mark === mark) {
      entry.verifiedAt = this.currentNow();
      this.touchEntry(entry);
      this.entries.delete(id);
      this.entries.set(id, entry);
      return entry.data;
    }
    const sqliteVal = this.readFromSqlite(id, dbPath, provided ?? null, wantTimeline, true);
    assertCurrent();
    if (!sqliteVal) throw new Error('会话暂时没有可用统计');
    const resolvedSummary: TrajectorySummaryLike = {
      ...(provided || {}),
      stepCount: sqliteVal.numTotalSteps,
      status: sqliteVal.status,
    };
    return this.commitSqliteEntry(id, entry, sqliteVal, resolvedSummary, mark, wantTimeline);
  }

  private commitSqliteEntry(
    id: string,
    entry: TrajectoryCacheEntry,
    value: TrajectoryResult,
    resolvedSummary: TrajectorySummaryLike,
    mark: string,
    wantTimeline: boolean,
  ): TrajectoryResult {
    const steps = value.trajectory.steps;
    const generators = value.trajectory.generatorMetadata;
    const bytes =
      steps.length || generators.length
        ? Buffer.byteLength(JSON.stringify({ steps, generatorMetadata: generators }))
        : 34;
    if (bytes > this.budgetBytes) throw new Error('会话统计数据超过内存预算');
    this.cachedBytes -= entry.bytes;
    entry.bytes = bytes;
    this.cachedBytes += bytes;
    entry.data = value;
    entry.summary = resolvedSummary;
    entry.mark = mark;
    entry.withTimeline = wantTimeline;
    entry.rev = (entry.rev || 0) + 1;
    entry.verifiedAt = this.currentNow();
    this.touchEntry(entry);
    this.entries.delete(id);
    this.entries.set(id, entry);
    this.trim(id);
    return value;
  }

  private async loadEntry(
    id: string,
    entry: TrajectoryCacheEntry,
    provided: TrajectorySummaryLike | undefined,
    force: boolean,
    wantTimeline: boolean,
    assertCurrent: () => void,
    conversationsDir?: string | null,
  ): Promise<TrajectoryResult> {
    const dbPath = this.resolveDbPath(id, conversationsDir);
    let summary: TrajectorySummaryLike | null = null;
    let isRemote = false;
    const hasSnapshotFn = typeof this.client.readAgentStateSnapshot === 'function';
    if (id.includes('/') && hasSnapshotFn) isRemote = true;
    else {
      try { summary = await this.summary(id, provided, force); assertCurrent(); }
      catch (err) {
        if ((err as Error)?.message === '会话暂时没有可用统计') {
          if (
            !force &&
            entry.data &&
            entry.withTimeline === wantTimeline &&
            this.currentNow() - (entry.verifiedAt ?? 0) < this.idleRecheckMs
          ) {
            this.touchEntry(entry);
            this.entries.delete(id);
            this.entries.set(id, entry);
            return entry.data;
          }
          if (dbPath && isNativeAccelAvailable()) {
            const sqliteVal = this.readFromSqlite(id, dbPath, null, wantTimeline);
            if (sqliteVal) {
              assertCurrent();
              const synthSummary: TrajectorySummaryLike = {
                stepCount: sqliteVal.numTotalSteps,
                status: sqliteVal.status,
              };
              const synthMark = JSON.stringify([sqliteVal.numTotalSteps, undefined, sqliteVal.status, undefined]);
              if (!force && entry.data && entry.withTimeline === wantTimeline && entry.mark === synthMark) {
                entry.verifiedAt = this.currentNow();
                this.touchEntry(entry);
                this.entries.delete(id);
                this.entries.set(id, entry);
                return entry.data;
              }
              return this.commitSqliteEntry(id, entry, sqliteVal, synthSummary, synthMark, wantTimeline);
            }
          }
          if (hasSnapshotFn) isRemote = true;
          else throw err;
        } else throw err;
      }
    }
    if (isRemote || (summary?.trajectoryMetadata?.remoteControlDetails && hasSnapshotFn)) {
      try { return await this.readRemote(id, entry, force, assertCurrent, wantTimeline); }
      catch (remoteErr) { if (isRemote) throw remoteErr; }
    }
    const resolvedSummary = summary!;
    const count = resolvedSummary.stepCount === undefined ? null : Number(resolvedSummary.stepCount);
    if (count !== null && (!Number.isSafeInteger(count) || count < 0)) throw new Error('会话统计分页数量无效');
    const mark = JSON.stringify([count, resolvedSummary.lastModifiedTime, resolvedSummary.status, resolvedSummary.lastUserInputStepIndex]);
    const old = entry.data;
    const timelineModeMismatch = Boolean(old) && entry.withTimeline !== wantTimeline;
    const same = Boolean(old) && !timelineModeMismatch && entry.mark === mark;
    if (!force && same && old && settled(resolvedSummary.status) && resolvedSummary.lastModifiedTime && this.currentNow() - (entry.verifiedAt ?? 0) < this.idleRecheckMs) {
      this.touchEntry(entry);
      this.entries.delete(id); this.entries.set(id, entry); return old;
    }
    const isRunning = Boolean(resolvedSummary.status && !settled(resolvedSummary.status));
    if (!isRunning && dbPath && isNativeAccelAvailable()) {
      const sqliteVal = this.readFromSqlite(id, dbPath, resolvedSummary, wantTimeline);
      if (sqliteVal) {
        assertCurrent();
        return this.commitSqliteEntry(id, entry, sqliteVal, resolvedSummary, mark, wantTimeline);
      }
    }
    const incremental = Boolean(
      old && !force && !timelineModeMismatch && count !== null && count >= old.trajectory.steps.length &&
      (count > old.trajectory.steps.length || !settled(entry.summary?.status) || same),
    );
    let stepOffset = 0, metadataOffset = 0;
    if (incremental && old) {
      const lastInput = old.trajectory.steps.findLastIndex((s) => /USER_INPUT/.test(String(s?.type || '')));
      stepOffset = lastInput < 0 ? 0 : lastInput + 1;
      const gs = old.trajectory.generatorMetadata;
      if (gs.length && gs.every((g) => Array.isArray(g.stepIndices) && g.stepIndices.length && g.stepIndices.every((i) => typeof i === 'number' && Number.isInteger(i) && i >= 0))) {
        metadataOffset = Math.max(0, gs.length - 1);
        const associated = (gs.at(-1)?.stepIndices || []).filter(
          (i): i is number => typeof i === 'number' && Number.isInteger(i) && i >= 0 && i < old.trajectory.steps.length && !/USER_INPUT/.test(String(old.trajectory.steps[i]?.type || '')),
        );
        stepOffset = associated.length ? Math.min(...associated) : old.trajectory.steps.length;
      }
      const pendingTool = old.trajectory.steps.findIndex(
        (s) => s?.metadata && (s.metadata.startedAt || s.metadata.createdAt) && !s.metadata.completedAt && (TOOL_STEP.test(String(s.type || '')) || Boolean(s.metadata.toolCall)),
      );
      if (pendingTool >= 0) stepOffset = Math.min(stepOffset, pendingTool);
      if (gs.some((g) => !Array.isArray(g.stepIndices) || !g.stepIndices.length)) metadataOffset = 0;
    }
    const steps: Array<ProjectedStep | undefined> = incremental && old ? old.trajectory.steps.slice(0, stepOffset) : [];
    const generators: RawGeneratorMetadataLike[] = incremental && old ? old.trajectory.generatorMetadata.slice(0, metadataOffset) : [];
    let planModel = incremental && old ? old.trajectory.planModel || null : null;
    let bytes = steps.length || generators.length ? Buffer.byteLength(JSON.stringify({ steps, generatorMetadata: generators })) : 34;
    const deadline = this.client.now() + 30000;
    const append = <T>(target: T[], items: readonly T[]): void => {
      for (const item of items) {
        bytes += Buffer.byteLength(JSON.stringify(item)) + 1;
        if (bytes > this.budgetBytes) throw new Error('会话统计数据超过内存预算');
        target.push(item);
      }
    };
    const check = (): void => { assertCurrent(); if (this.client.now() > deadline) throw new Error('会话统计分页读取超时'); };
    try {
      while (count === null || steps.length < count) {
        check();
        const page = await this.callStepRpc<{ steps?: ProjectedStep[]; planModel?: unknown }>('GetCascadeTrajectorySteps', { cascadeId: id, stepOffset: steps.length, trajectoryVerbosity: 3 }, wantTimeline);
        check();
        const items = page.steps || [];
        if (!Array.isArray(items)) throw new Error('会话统计分页格式无效');
        if (!items.length) { if (count === null) break; throw new Error('完整会话统计分页暂不可用'); }
        const pagePlan = (typeof page.planModel === 'string' && page.planModel.trim() ? page.planModel.trim().slice(0, 256) : null) || extractPlanModelFromSteps(items);
        if (pagePlan) planModel = pagePlan;
        append(steps, items);
      }
      for (;;) {
        check();
        const page = await this.client.call<{ generatorMetadata?: RawGeneratorMetadataLike[]; generatorMetadatas?: RawGeneratorMetadataLike[] }>('GetCascadeTrajectoryGeneratorMetadata', { cascadeId: id, generatorMetadataOffset: generators.length, includeMessages: false });
        check();
        const items = page.generatorMetadata || page.generatorMetadatas || [];
        if (!Array.isArray(items)) throw new Error('会话统计分页格式无效');
        if (!items.length) break;
        append(generators, items);
      }
    } catch (err) {
      const e = err as { message?: string; status?: number } | null;
      if (e?.message === '后台已重新连接，请等待刷新' || e?.message === '会话统计数据超过内存预算') throw err;
      if (dbPath && isNativeAccelAvailable()) {
        const sqliteFallback = this.readFromSqlite(id, dbPath, resolvedSummary, wantTimeline, true);
        if (sqliteFallback) {
          assertCurrent();
          return this.commitSqliteEntry(id, entry, sqliteFallback, resolvedSummary, mark, wantTimeline);
        }
      }
      if (hasSnapshotFn && ((e?.status !== undefined && [404, 501].includes(e.status)) || /not found|unimplemented|cloudproxy|完整会话统计分页暂不可用/i.test(e?.message || ''))) {
        try { return await this.readRemote(id, entry, force, assertCurrent, wantTimeline); } catch {}
      }
      throw err;
    }
    if (generators.some((g) => (g.stepIndices || []).some((i) => typeof i === 'number' && Number.isInteger(i) && i >= steps.length))) {
      if (settled(resolvedSummary.status)) throw new Error('会话仍在更新，请等待下一次刷新');
    }
    const value: TrajectoryResult = {
      trajectory: { cascadeId: id, ...(planModel ? { planModel } : {}), steps, generatorMetadata: generators },
      numTotalSteps: steps.length,
      numTotalGeneratorMetadata: generators.length,
      status: resolvedSummary.status,
    };
    assertCurrent();
    this.cachedBytes -= entry.bytes; entry.bytes = bytes; this.cachedBytes += bytes;
    entry.data = value; entry.summary = resolvedSummary; entry.mark = mark; entry.withTimeline = wantTimeline;
    entry.rev = (entry.rev || 0) + 1; entry.verifiedAt = this.currentNow();
    this.touchEntry(entry);
    this.entries.delete(id); this.entries.set(id, entry); this.trim(id);
    return value;
  }

  readRemote(id: string, entry: TrajectoryCacheEntry, force: boolean, assertCurrent: () => void, wantTimeline = this.isTimelineEnabled()): Promise<TrajectoryResult> {
    return readRemoteTrajectory(this, id, entry, force, assertCurrent, wantTimeline);
  }

  scheduleRemoteBackfill(id: string, entry: TrajectoryCacheEntry): void {
    scheduleRemoteBackfill(this, id, entry);
  }
}
