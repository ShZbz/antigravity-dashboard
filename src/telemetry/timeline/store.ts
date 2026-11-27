// Opt-in local persistence for bounded structural model timelines.
// Stores snapshots under <dataDir>/timeline-v1/<scope>/<cascadeId>.json.
import { createHash } from 'node:crypto';
import { readdir, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { ClearTimelineResult, ModelTimelineSnapshot } from '../../contracts/timeline.ts';
import { platformPaths } from '../../platform/paths.ts';
import { atomicWriteFile, readJsonSafe, statStamp } from '../../shared/atomic-fs.ts';
import {
  compactTimeline,
  MAX_TIMELINE_BYTES,
  MAX_TIMELINE_NODES,
  safeTimeline,
} from './compactor.ts';

const GUID =
  /^(?:[a-zA-Z0-9_.-]+\/)*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCOPE = /^(?:[0-9a-f]{64}|[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63})$/;
const MAX_WRITE_CACHE_ENTRIES = 8;
const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex');

function validScope(scope: unknown): scope is string {
  return typeof scope === 'string' && SCOPE.test(scope) && !scope.includes('..');
}

interface TimelineWriteCacheEntry {
  fileStamp: string;
  result: ModelTimelineSnapshot;
  bodyHash: string;
}

interface PersistedTimelineRecord {
  schema: number;
  account: string;
  cascadeId: string;
  savedAt: string;
  timeline: unknown;
}

export interface TimelineStoreOptions {
  maxNodes?: number;
  maxBytes?: number;
}

export class TimelineStore {
  directory: string;
  maxNodes: number;
  maxBytes: number;
  pending = new Map<string, Promise<unknown>>();
  createdDirs = new Set<string>();
  writeCache = new Map<string, TimelineWriteCacheEntry>();

  constructor(
    directory = join(platformPaths().data, 'timeline-v1'),
    { maxNodes = MAX_TIMELINE_NODES, maxBytes = MAX_TIMELINE_BYTES }: TimelineStoreOptions = {},
  ) {
    this.directory = directory;
    this.maxNodes = maxNodes;
    this.maxBytes = maxBytes;
  }

  file(scope: string, cascadeId: string): string {
    if (!validScope(scope) || typeof cascadeId !== 'string' || !GUID.test(cascadeId)) {
      throw new Error('Invalid timeline scope or conversation ID');
    }
    const safeId = cascadeId.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    return join(this.directory, scope, `${safeId}.json`);
  }

  async stamp(file: string): Promise<string | null | undefined> {
    return statStamp(file);
  }

  rememberWrite(
    file: string,
    fileStamp: string,
    result: ModelTimelineSnapshot,
    bodyHash: string,
  ): void {
    this.writeCache.delete(file);
    while (this.writeCache.size >= MAX_WRITE_CACHE_ENTRIES) {
      const oldest = this.writeCache.keys().next().value;
      if (oldest === undefined) break;
      this.writeCache.delete(oldest);
    }
    this.writeCache.set(file, { fileStamp, result, bodyHash });
  }

  async load(scope: string | null | undefined, cascadeId: string): Promise<ModelTimelineSnapshot | null> {
    if (!scope) return null;
    try {
      const file = this.file(scope, cascadeId);
      const record = await readJsonSafe<PersistedTimelineRecord>(file, { maxBytes: this.maxBytes });
      if (!record || typeof record !== 'object') return null;
      if (
        record.schema !== 1 ||
        record.account !== scope ||
        record.cascadeId !== cascadeId.toLowerCase()
      ) {
        return null;
      }
      if (typeof record.savedAt !== 'string' || !Number.isFinite(Date.parse(record.savedAt))) {
        return null;
      }
      const timeline = safeTimeline(record.timeline, {
        maxNodes: this.maxNodes,
        maxBytes: this.maxBytes,
      });
      if (!timeline) return null;
      return { ...timeline, savedAt: record.savedAt };
    } catch {
      return null;
    }
  }

  async save(
    scope: string | null | undefined,
    cascadeId: string,
    timeline: ModelTimelineSnapshot | null | undefined,
  ): Promise<ModelTimelineSnapshot | null> {
    if (!scope || !timeline || timeline.enabled !== true) return null;
    const key = this.file(scope, cascadeId);
    const previous = this.pending.get(key) || Promise.resolve();
    const pending = previous.catch(() => {}).then(() => this.write(scope, cascadeId, timeline));
    this.pending.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.pending.get(key) === pending) this.pending.delete(key);
    }
  }

  async write(
    scope: string,
    cascadeId: string,
    rawTimeline: ModelTimelineSnapshot,
  ): Promise<ModelTimelineSnapshot | null> {
    const normalized = compactTimeline(
      { ...rawTimeline, cascadeId: rawTimeline.cascadeId || cascadeId, savedAt: null },
      {
        maxNodes: this.maxNodes,
        maxBytes: Math.max(4096, this.maxBytes - 512),
      },
    );
    if (!normalized) return null;
    const file = this.file(scope, cascadeId);
    const bodyHash = sha256Hex(JSON.stringify(normalized));
    const fileStamp = await this.stamp(file);
    const cached = this.writeCache.get(file);
    if (fileStamp === null) {
      this.writeCache.delete(file);
    } else if (cached && fileStamp !== undefined && cached.fileStamp === fileStamp && cached.bodyHash === bodyHash) {
      this.rememberWrite(file, fileStamp, cached.result, bodyHash);
      return cached.result;
    }

    const savedAt = new Date().toISOString();
    const persisted: ModelTimelineSnapshot = { ...normalized, savedAt };
    const payload = JSON.stringify({
      schema: 1,
      account: scope,
      cascadeId: cascadeId.toLowerCase(),
      savedAt,
      timeline: persisted,
    });
    if (Buffer.byteLength(payload, 'utf8') > this.maxBytes) return null;

    try {
      await atomicWriteFile(file, payload, {
        encoding: 'utf8',
        mode: 0o600,
        createdDirs: this.createdDirs,
      });
    } catch (error) {
      this.writeCache.delete(file);
      throw error;
    }

    const nextStamp = await this.stamp(file);
    if (nextStamp) this.rememberWrite(file, nextStamp, persisted, bodyHash);
    return persisted;
  }

  async clear(scope: string, cascadeId: string): Promise<ClearTimelineResult> {
    const file = this.file(scope, cascadeId);
    const prev = this.pending.get(file) || Promise.resolve();
    const job = prev.catch(() => {}).then(async (): Promise<ClearTimelineResult> => {
      this.writeCache.delete(file);
      await unlink(file).catch((err: unknown) => {
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
      });
      return { cleared: true, scope, cascadeId: cascadeId.toLowerCase() };
    });
    this.pending.set(file, job);
    try {
      return await job;
    } finally {
      if (this.pending.get(file) === job) this.pending.delete(file);
    }
  }

  async clearAll(scope: string | null = null): Promise<ClearTimelineResult> {
    if (scope !== null && scope !== undefined) {
      if (!validScope(scope)) throw new Error('Invalid timeline scope');
      const dir = join(this.directory, scope);
      this.createdDirs.delete(dir);
      for (const key of [...this.writeCache.keys()]) {
        if (key.startsWith(dir)) this.writeCache.delete(key);
      }
      await rm(dir, { recursive: true, force: true });
      return { cleared: true, scope };
    }
    this.createdDirs.clear();
    this.writeCache.clear();
    const entries = await readdir(this.directory, { withFileTypes: true }).catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
      throw err;
    });
    for (const entry of entries) {
      await rm(join(this.directory, entry.name), { recursive: true, force: true });
    }
    return { cleared: true, scope: 'all' };
  }
}
