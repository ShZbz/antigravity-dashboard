// Background task accounting. Every source remains an independent conversation;
// only numeric request projections are combined, never timing or context windows.
import type { TaskUsageState, TaskUsageSummary } from '../../contracts/metrics.ts';
import { trajectoryMetrics } from '../metrics/index.ts';
import { buildTimelineChildren, collectTaskChildren } from './delegated-collector.ts';
import { buildTaskResult, createDelegatedTaskState } from './delegated-result.ts';
import type {
  ChildTimelineSummary,
  DelegatedClientLike,
  DelegatedRequestOptions,
  DelegatedTaskState,
  DelegatedUsageOptions,
} from './delegated-types.ts';
import { delegatedHints, delegatedIds, normalizeConversationId } from './delegation.ts';
import { mergeTaskHint, seedTaskHints } from './hints.ts';
import {
  mergeTaskModelRecords,
  mergeTaskRecords,
  safeTaskUsage,
  taskModelRecords,
  taskRecords,
  type TaskModelRecord,
  type TaskUsageRecord,
} from './task-usage.ts';

export type {
  DelegatedClientLike,
  DelegatedUsageOptions,
  DelegatedRequestOptions,
  ChildTimelineSummary,
  DelegatedTaskState,
} from './delegated-types.ts';

type TimestampedDelegatedTaskState = DelegatedTaskState & { lastAccessedAt?: number };

export class DelegatedUsage {
  client: DelegatedClientLike;
  onSource: NonNullable<DelegatedUsageOptions['onSource']>;
  onUpdate: NonNullable<DelegatedUsageOptions['onUpdate']>;
  owns: () => boolean;
  now: () => number;
  budgetBytes: number;
  maxAgents: number;
  maxEntries: number;
  refreshMs: number;
  modelTimelineEnabled: boolean;

  tasks = new Map<string, DelegatedTaskState>();
  epoch = 0;
  scope: string | null = null;
  running: Promise<void> | null = null;
  bytes = 0;
  disposed = false;

  constructor(
    client: DelegatedClientLike,
    {
      onSource = async () => {},
      onUpdate = async () => {},
      owns = () => true,
      now = Date.now,
      budgetBytes = 8 * 1024 * 1024,
      maxAgents = 128,
      maxEntries = 4,
      refreshMs = 5000,
      modelTimelineEnabled = false,
    }: DelegatedUsageOptions = {},
  ) {
    this.client = client;
    this.onSource = onSource;
    this.onUpdate = onUpdate;
    // A Promise is truthy but is never proof of ownership. Callers must supply
    // the synchronous cached predicate, not the asynchronous marker verifier.
    this.owns = () => owns() === true;
    this.now = now;
    this.budgetBytes = budgetBytes;
    this.maxAgents = maxAgents;
    this.maxEntries = maxEntries;
    this.refreshMs = refreshMs;
    this.modelTimelineEnabled = modelTimelineEnabled === true;
  }

  setModelTimelineEnabled(enabled: boolean): boolean {
    const next = enabled === true;
    const turnedOn = next && !this.modelTimelineEnabled;
    this.modelTimelineEnabled = next;
    if (!next) {
      for (const task of this.tasks.values()) task.childTimelines?.clear?.();
    } else if (turnedOn) {
      for (const task of this.tasks.values()) task.lastAt = -Infinity;
    }
    return this.modelTimelineEnabled;
  }

  getTimelineChildren(id: unknown): ChildTimelineSummary[] {
    const norm = normalizeConversationId(id);
    if (!norm) return [];
    const task = this.tasks.get(norm);
    if (!task) return [];
    (task as TimestampedDelegatedTaskState).lastAccessedAt = this.now();
    return buildTimelineChildren(task, this.client.reader?.summaries || {});
  }

  reset(): void {
    this.epoch++;
    this.tasks.clear();
    this.bytes = 0;
    this.scope = null;
  }

  dispose(): void {
    this.disposed = true;
    this.reset();
  }

  trimIdle(maxAgeMs = 180_000, keepIds?: ReadonlySet<string>): number {
    const now = this.now();
    const isKept = (key: string): boolean =>
      Boolean(keepIds && (keepIds.has(key) || keepIds.has(key.toLowerCase())));
    let evicted = 0;
    for (const [key, task] of [...this.tasks]) {
      if (isKept(key) || task.collecting || task.requested) continue;
      const accessedAt =
        (task as TimestampedDelegatedTaskState).lastAccessedAt ??
        (Number.isFinite(task.lastAt) ? task.lastAt : 0);
      if (now - accessedAt >= maxAgeMs) {
        this.bytes = Math.max(0, this.bytes - task.bytes);
        this.tasks.delete(key);
        evicted++;
      }
    }
    return evicted;
  }

  links(id: unknown, raw: unknown): string[] {
    return delegatedIds(id, raw, this.client.reader?.summaries || {});
  }

  request(
    scope: string | null | undefined,
    id: unknown,
    raw: unknown,
    { saved = null, knownIds = [], force = false, isCurrent = () => true }: DelegatedRequestOptions = {},
  ): TaskUsageSummary | null {
    if (this.disposed || !scope || !this.owns()) return safeTaskUsage(saved);
    const normId = normalizeConversationId(id);
    if (!normId) return null;
    if (scope !== this.scope) {
      this.reset();
      this.scope = scope;
    }
    const summaries = this.client.reader?.summaries || {};
    const ids = [
      ...new Set([
        ...this.links(normId, raw),
        ...knownIds.map(normalizeConversationId).filter((v): v is string => v !== null),
      ]),
    ].filter((child) => child !== normId);

    let task = this.tasks.get(normId);
    if (!ids.length && !task) return safeTaskUsage(saved);
    if (!task) {
      while (this.tasks.size >= this.maxEntries) {
        const oldest = this.tasks.keys().next().value;
        if (oldest === undefined) break;
        this.bytes -= this.tasks.get(oldest)!.bytes;
        this.tasks.delete(oldest);
      }
      task = createDelegatedTaskState(normId, scope, saved);
      this.tasks.set(normId, task);
    }
    this.tasks.delete(normId);
    this.tasks.set(normId, task);
    (task as TimestampedDelegatedTaskState).lastAccessedAt = this.now();
    task.isCurrent = isCurrent;
    seedTaskHints(task.hints, task.id, saved);
    const oldSize = task.children.size;
    this.addChildren(task, ids);
    for (const [cid, h] of delegatedHints(normId, raw, summaries, 0)) {
      mergeTaskHint(task.hints, task.id, cid, h);
    }
    const rawObj = raw && typeof raw === 'object' ? (raw as object) : null;
    if (!rawObj || task.raw?.deref() !== rawObj) {
      if (rawObj) task.raw = new WeakRef(rawObj);
      const rows = taskRecords(raw, normId);
      if (!this.put(task, normId, rows)) task.truncated = true;
      this.putModels(task, normId, taskModelRecords(raw, normId));
      const m = trajectoryMetrics(raw);
      task.planModel = m.planModel || task.planModel;
      task.activeModel = m.activeModel || task.activeModel;
      task.result = this.result(
        task,
        task.lastAt === -Infinity ? 'loading' : task.result?.state || 'loading',
      );
    }
    if (
      force ||
      (!task.collecting &&
        (oldSize !== task.children.size || this.now() - task.lastAt >= this.refreshMs))
    ) {
      task.requested = true;
      task.force ||= force;
      this.schedule();
    }
    return task.result || this.result(task, 'loading');
  }

  private addChildren = (task: DelegatedTaskState, ids: string[]): void => {
    for (const id of ids) {
      if (id === task.id || task.children.has(id)) continue;
      if (task.children.size >= this.maxAgents) {
        task.truncated = true;
        break;
      }
      task.children.add(id);
    }
  };

  private evictForSize(task: DelegatedTaskState, oldBytes: number, newBytes: number): boolean {
    if (this.bytes - oldBytes + newBytes > this.budgetBytes) {
      for (const [key, other] of this.tasks) {
        if (other === task) continue;
        this.bytes -= other.bytes;
        this.tasks.delete(key);
        if (this.bytes - oldBytes + newBytes <= this.budgetBytes) break;
      }
    }
    return this.bytes - oldBytes + newBytes <= this.budgetBytes;
  }

  put = (task: DelegatedTaskState, id: string, rows: TaskUsageRecord[]): boolean => {
    const merged = mergeTaskRecords(task.sources.get(id)?.rows || [], rows);
    if (merged.restored) task.staleSources.add(id);
    else task.staleSources.delete(id);
    const size = Buffer.byteLength(JSON.stringify(merged.rows));
    const old = task.sources.get(id)?.bytes || 0;
    if (!this.evictForSize(task, old, size)) return false;
    this.bytes += size - old;
    task.bytes += size - old;
    task.sources.set(id, { rows: merged.rows, bytes: size });
    return true;
  };

  putModels = (task: DelegatedTaskState, id: string, rows: TaskModelRecord[]): boolean => {
    if (!task.modelSources) task.modelSources = new Map();
    const merged = mergeTaskModelRecords(task.modelSources.get(id)?.rows || [], rows);
    const size = Buffer.byteLength(JSON.stringify(merged));
    const old = task.modelSources.get(id)?.bytes || 0;
    if (!this.evictForSize(task, old, size)) return false;
    this.bytes += size - old;
    task.bytes += size - old;
    task.modelSources.set(id, { rows: merged, bytes: size });
    return true;
  };

  result = (task: DelegatedTaskState, state: TaskUsageState): TaskUsageSummary =>
    buildTaskResult(task, state, this.client.reader?.summaries || {});

  private schedule(): void {
    if (this.running || this.disposed) return;
    this.running = Promise.resolve()
      .then(async () => {
        for (;;) {
          const task = [...this.tasks.values()].find((t) => t.requested);
          if (!task || this.disposed || !this.owns()) break;
          task.requested = false;
          const force = task.force;
          task.force = false;
          const epoch = this.epoch;
          const current = () =>
            !this.disposed &&
            this.owns() &&
            epoch === this.epoch &&
            task.scope === this.scope &&
            this.tasks.get(task.id) === task &&
            (task.isCurrent ? task.isCurrent() : true);
          task.collecting = true;
          try {
            await collectTaskChildren(
              {
                client: this.client,
                now: this.now,
                modelTimelineEnabled: this.modelTimelineEnabled,
                addChildren: this.addChildren,
                put: this.put,
                putModels: this.putModels,
                buildResult: this.result,
                onSource: this.onSource,
                onUpdate: this.onUpdate,
              },
              task,
              force,
              current,
            );
          } finally {
            task.collecting = false;
            (task as TimestampedDelegatedTaskState).lastAccessedAt = this.now();
          }
        }
      })
      .finally(() => {
        this.running = null;
      });
  }

  async idle(): Promise<void> {
    while (this.running) await this.running;
  }
}
