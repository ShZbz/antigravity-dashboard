import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { CacheMetrics, LatestRateStatus, RateReason, SpeedMetrics, TokenCounts, TokenSummary } from '../../contracts/metrics.ts';
import { platformPaths } from '../../platform/paths.ts';
import { atomicWriteFile, readJsonSafe, statStamp } from '../../shared/atomic-fs.ts';
import { formatModelName, safeContext } from '../context.ts';
import { safeTaskUsage } from '../delegation/task-usage.ts';
import { safeModelUsage } from '../metrics/index.ts';
import { RATE_REASONS, RATE_VERSION } from '../rate-quality.ts';
import { safeTranscriptStats } from '../reader/transcript.ts';

const GUID = /^(?:[a-zA-Z0-9_.-]+\/)*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCOPE = /^[0-9a-f]{64}$/;
const MAX_HISTORY_BYTES = 65536;
const MAX_WRITE_CACHE_ENTRIES = 16;
const NUMERIC_KEYS = [
  'steps', 'rounds', 'requests', 'measuredRequests', 'missingTiming', 'tps', 'latestTps',
  'streamingSeconds', 'modelSeconds', 'toolSeconds', 'ttftSeconds', 'excludedTiming', 'rateWarnings',
] as const;
const COUNT_KEYS = ['input', 'output', 'responseOutput', 'thinkingOutput', 'cacheRead', 'cacheWrite'] as const;
const CACHE_KEYS = [
  'inputTokens', 'cachedTokens', 'cacheWriteTokens', 'uncachedTokens', 'outputTokens',
  'measuredRequests', 'missingRequests', 'totalTokens', 'hitRate',
] as const;
const TOKEN_KEYS = [
  'inputTokens', 'cachedTokens', 'cacheWriteTokens', 'uncachedTokens', 'outputTokens',
  'measuredRequests', 'inputRequests', 'outputRequests', 'missingInputRequests', 'missingOutputRequests', 'totalTokens',
] as const;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isTok = (v: unknown): v is number => isNum(v) && Number.isSafeInteger(v);
const isRec = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object');
const isoOrNull = (v: unknown): string | null =>
  typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;

const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex');

export interface HistoryRecord { metrics: SpeedMetrics; savedAt: string; }
interface HistoryWriteCacheEntry { fileStamp: string; result: HistoryRecord; metricsHash: string; }
interface PersistedHistoryFile { schema: number; account: string; conversationId: string; savedAt: string; metrics: unknown; }

function buildTokenSummary(raw: Record<string, unknown>, counts: TokenCounts, cache: CacheMetrics, requests: number | null): TokenSummary {
  if (isRec(raw.tokens)) {
    const rt = raw.tokens;
    const t = {} as Record<string, number | boolean | null>;
    for (const k of TOKEN_KEYS) t[k] = isTok(rt[k]) ? rt[k] : null;
    // Earlier token records counted only requests with complete input.
    for (const k of ['uncachedRequests', 'cachedRequests', 'cacheWriteRequests'] as const) t[k] = isTok(rt[k]) ? rt[k] : t.inputRequests;
    t.outputAvailable = isTok(t.outputTokens) && (rt.outputAvailable === true || ((t.outputRequests as number) > 0));
    const suppliedTotal = t.totalTokens;
    const total = ((t.inputTokens as number | null) ?? 0) + ((t.outputTokens as number | null) ?? 0);
    t.totalTokens = (t.inputTokens !== null || t.outputTokens !== null) && isTok(total) ? total : null;
    t.coverageUnknown = rt.coverageUnknown === true || TOKEN_KEYS.some((k) => t[k] === null) || suppliedTotal !== t.totalTokens;
    t.complete = rt.complete === true && !t.coverageUnknown && t.missingInputRequests === 0 && t.missingOutputRequests === 0 &&
      t.inputRequests === requests && t.outputRequests === requests && TOKEN_KEYS.every((k) => t[k] !== null) &&
      t.inputTokens === (t.uncachedTokens as number) + (t.cachedTokens as number) + (t.cacheWriteTokens as number) && suppliedTotal === t.totalTokens;
    return t as unknown as TokenSummary;
  }
  // Schema-1 records used a cache-only total, but already saved all output usage in counts.
  const rc = isRec(raw.counts) ? raw.counts : null;
  const inputRequests = cache.measuredRequests || 0;
  const uncachedTokens = isTok(rc?.input) ? rc.input : cache.uncachedTokens || 0;
  const cachedTokens = isTok(rc?.cacheRead) ? rc.cacheRead : cache.cachedTokens || 0;
  const cacheWriteTokens = isTok(rc?.cacheWrite) ? rc.cacheWrite : cache.cacheWriteTokens || 0;
  const inputTotal = uncachedTokens + cachedTokens + cacheWriteTokens;
  const inputTokens = isTok(inputTotal) ? inputTotal : null;
  const minCov = (v: number): number => Math.max(inputRequests, v > 0 ? 1 : 0);
  const total = (inputTokens ?? 0) + counts.output;
  return {
    inputTokens, cachedTokens, cacheWriteTokens, uncachedTokens, outputTokens: counts.output,
    inputRequests, outputRequests: null, outputAvailable: isTok(rc?.output),
    uncachedRequests: minCov(uncachedTokens), cachedRequests: minCov(cachedTokens), cacheWriteRequests: minCov(cacheWriteTokens),
    measuredRequests: Math.max(inputRequests, counts.output > 0 || inputTotal > 0 ? 1 : 0),
    missingInputRequests: Math.max(0, (requests || 0) - inputRequests),
    missingOutputRequests: null, coverageUnknown: true, totalTokens: isTok(total) ? total : null, complete: false,
  };
}

export function safeMetrics(value: unknown, conversationId: string): SpeedMetrics {
  if (typeof conversationId !== 'string' || !GUID.test(conversationId) || !isRec(value)) {
    throw new Error('Invalid conversation statistics');
  }
  const counts = {} as TokenCounts;
  const rc = isRec(value.counts) ? value.counts : null;
  for (const k of COUNT_KEYS) counts[k] = isTok(rc?.[k]) ? rc[k] : 0;

  const cacheObj = {} as Record<string, number | boolean | null>;
  const rCache = isRec(value.cache) ? value.cache : null;
  for (const k of CACHE_KEYS) cacheObj[k] = (k === 'hitRate' ? isNum : isTok)(rCache?.[k]) ? (rCache![k] as number) : null;
  if (typeof cacheObj.hitRate === 'number' && cacheObj.hitRate > 1) cacheObj.hitRate = null;
  cacheObj.complete = rCache?.complete === true;
  const cache = cacheObj as unknown as CacheMetrics;

  const numFields = {} as Record<string, number | null>;
  for (const k of NUMERIC_KEYS) numFields[k] = isNum(value[k]) ? value[k] : null;

  const rateVersion = value.rateVersion === RATE_VERSION ? RATE_VERSION : 0;
  const rt = isRec(value.timingReasons) ? value.timingReasons : null;
  const timingReasons = Object.fromEntries(RATE_REASONS.map((k) => [k, isNum(rt?.[k]) ? rt[k] : 0])) as Record<RateReason, number>;
  const latestRateStatus: LatestRateStatus =
    value.latestRateStatus === 'ok' || value.latestRateStatus === 'missing' || value.latestRateStatus === 'unreliable'
      ? value.latestRateStatus : 'missing';
  const tokens = buildTokenSummary(value, counts, cache, numFields.requests);
  if (
    isRec(value.tokens) &&
    !tokens.coverageUnknown &&
    cache.hitRate === null &&
    (cache.measuredRequests ?? 0) === 0 &&
    tokens.inputRequests !== null &&
    tokens.inputRequests > 0 &&
    tokens.uncachedRequests === tokens.inputRequests &&
    tokens.cachedRequests === tokens.inputRequests &&
    tokens.cacheWriteRequests === tokens.inputRequests &&
    tokens.inputTokens !== null &&
    tokens.inputTokens > 0 &&
    tokens.uncachedTokens !== null &&
    tokens.cachedTokens !== null &&
    tokens.cacheWriteTokens !== null &&
    tokens.inputTokens === tokens.uncachedTokens + tokens.cachedTokens + tokens.cacheWriteTokens &&
    tokens.cachedTokens + tokens.cacheWriteTokens <= tokens.inputTokens
  ) {
    const out = tokens.outputTokens ?? 0;
    const total = tokens.inputTokens + out;
    if (isTok(total)) {
      cache.inputTokens = tokens.inputTokens;
      cache.uncachedTokens = tokens.uncachedTokens;
      cache.cachedTokens = tokens.cachedTokens;
      cache.cacheWriteTokens = tokens.cacheWriteTokens;
      cache.outputTokens = out;
      cache.totalTokens = total;
      cache.measuredRequests = tokens.inputRequests;
      cache.missingRequests = tokens.missingInputRequests ?? 0;
      cache.hitRate = tokens.cachedTokens / tokens.inputTokens;
      cache.complete = cache.missingRequests === 0;
    }
  }

  const result: SpeedMetrics = {
    ...(numFields as Pick<SpeedMetrics, (typeof NUMERIC_KEYS)[number]>),
    source: 'Antigravity request metadata',
    status: typeof value.status === 'string' && /^[A-Z0-9_]+$/.test(value.status) ? value.status : null,
    conversationId, planModel: formatModelName(value.planModel), activeModel: formatModelName(value.activeModel),
    timingReasons, rateVersion, counts, tokens, cache,
    latestRateStatus, rateBasis: value.rateBasis === 'response' ? 'response' : 'all-output',
    latestShortSample: value.latestShortSample === true,
    model: typeof value.model === 'string' ? value.model.slice(0, 256) : null,
    context: safeContext(value.context) || null, complete: value.complete === true,
    speedRestoredFromHistory: value.speedRestoredFromHistory === true, cacheRestoredFromHistory: value.cacheRestoredFromHistory === true,
    speedSavedAt: isoOrNull(value.speedSavedAt), cacheSavedAt: isoOrNull(value.cacheSavedAt),
  };

  const modelUsage = safeModelUsage(value.modelUsage, { maxModels: 32 });
  if (modelUsage) result.modelUsage = modelUsage;
  const transcript = safeTranscriptStats(value.transcriptStats);
  if (transcript && (transcript.status === 'ready' || transcript.status === 'partial') && (transcript.matchedSteps > 0 || transcript.complete)) {
    result.transcriptStats = transcript;
  }
  const taskUsage = safeTaskUsage(value.taskUsage);
  if (taskUsage) result.taskUsage = taskUsage;
  if (Array.isArray(value.delegatedConversations)) {
    const ids = value.delegatedConversations.filter((id): id is string => typeof id === 'string' && GUID.test(id)).map((id) => id.toLowerCase());
    if (ids.length) result.delegatedConversations = [...new Set(ids)];
  }
  if (result.rateVersion !== RATE_VERSION) {
    result.tps = result.latestTps = result.streamingSeconds = null;
    result.measuredRequests = 0;
    result.latestRateStatus = 'legacy';
    result.latestShortSample = false;
  }
  return result;
}

export function usableMetrics(metrics: SpeedMetrics | null | undefined): boolean {
  if (!metrics) return false;
  return Boolean(
    (isNum(metrics.tps) && (metrics.measuredRequests ?? 0) > 0) ||
      (metrics.tokens?.measuredRequests ?? 0) > 0 || (metrics.cache?.measuredRequests ?? 0) > 0 ||
      ((metrics.requests ?? 0) > 0 && (metrics.counts?.output ?? 0) > 0) || safeContext(metrics.context) ||
      (isNum(metrics.taskUsage?.tokens?.totalTokens) && metrics.taskUsage!.tokens.totalTokens! > 0) ||
      ((metrics.taskUsage?.subagents ?? 0) > 0 && isNum(metrics.taskUsage?.tokens?.totalTokens)),
  );
}

export function shouldKeepSaved(saved: SpeedMetrics | null | undefined, fresh: SpeedMetrics): boolean {
  if (!saved || !usableMetrics(saved)) return false;
  return Boolean(
    !usableMetrics(fresh) || fresh.complete === false ||
      (fresh.requests ?? 0) < (saved.requests ?? 0) || (fresh.counts?.output ?? 0) < (saved.counts?.output ?? 0),
  );
}

export function reconcileMetrics(saved: SpeedMetrics | null | undefined, fresh: SpeedMetrics, savedAt: string | null = null): SpeedMetrics {
  if (saved && shouldKeepSaved(saved, fresh)) {
    const keptUsage = (fresh.modelUsage?.totalTokens || 0) > (saved.modelUsage?.totalTokens || 0)
      ? fresh.modelUsage : saved.modelUsage || fresh.modelUsage || null;
    return {
      ...saved, transcriptStats: fresh.transcriptStats || null, transcriptRestoredFromHistory: false,
      context: fresh.context || null, contextRestored: false, restoredFromHistory: true, savedAt,
      taskUsage: fresh.taskUsage || saved.taskUsage || null,
      delegatedConversations: fresh.delegatedConversations || saved.delegatedConversations || null,
      planModel: fresh.planModel ?? saved.planModel ?? null, activeModel: fresh.activeModel ?? saved.activeModel ?? null,
      ...(keptUsage ? { modelUsage: keptUsage } : {}),
    };
  }
  const result: SpeedMetrics = {
    ...fresh, contextRestored: false, transcriptRestoredFromHistory: false, restoredFromHistory: false,
    speedRestoredFromHistory: fresh.speedRestoredFromHistory === true, cacheRestoredFromHistory: fresh.cacheRestoredFromHistory === true,
  };
  if (saved?.taskUsage && !result.taskUsage) result.taskUsage = saved.taskUsage;
  if (saved?.delegatedConversations && !result.delegatedConversations) result.delegatedConversations = saved.delegatedConversations;
  if (result.planModel == null && saved?.planModel) result.planModel = saved.planModel;
  if (result.activeModel == null && saved?.activeModel) result.activeModel = saved.activeModel;
  if (saved?.modelUsage && (!result.modelUsage || (result.modelUsage.totalRequests || 0) < (saved.modelUsage.totalRequests || 0))) {
    result.modelUsage = saved.modelUsage;
  }
  if (!usableMetrics(saved)) return result;
  if ((fresh.cache?.measuredRequests || 0) < (saved!.cache?.measuredRequests || 0)) {
    result.cache = saved!.cache;
    result.cacheRestoredFromHistory = true;
    result.cacheSavedAt = saved!.cacheSavedAt || savedAt;
  }
  return result;
}

function fitPayloadWithinLimit(scope: string, convId: string, savedAt: string, metrics: SpeedMetrics): string | null {
  const make = (m: SpeedMetrics): string =>
    `{"schema":1,"account":${JSON.stringify(scope)},"conversationId":${JSON.stringify(convId)},"savedAt":${JSON.stringify(savedAt)},"metrics":${JSON.stringify(m)}}`;
  let payload = make(metrics);
  if (Buffer.byteLength(payload, 'utf8') <= MAX_HISTORY_BYTES) return payload;
  if ((metrics.modelUsage?.models?.length ?? 0) > 8) {
    metrics.modelUsage = safeModelUsage(metrics.modelUsage, { maxModels: 8 }) ?? undefined;
    payload = make(metrics);
  }
  if (Buffer.byteLength(payload, 'utf8') > MAX_HISTORY_BYTES && (metrics.taskUsage?.modelUsage?.models?.length ?? 0) > 8) {
    metrics.taskUsage = { ...metrics.taskUsage!, modelUsage: safeModelUsage(metrics.taskUsage!.modelUsage, { maxModels: 8 }) ?? undefined };
    payload = make(metrics);
  }
  if (Buffer.byteLength(payload, 'utf8') > MAX_HISTORY_BYTES && Array.isArray(metrics.taskUsage?.items)) {
    const items = [...metrics.taskUsage.items];
    while (items.length && Buffer.byteLength(payload, 'utf8') > MAX_HISTORY_BYTES) {
      items.pop();
      if (items.length) metrics.taskUsage = { ...metrics.taskUsage, items };
      else { const { items: _drop, ...rest } = metrics.taskUsage; metrics.taskUsage = rest; }
      payload = make(metrics);
    }
  }
  if (Buffer.byteLength(payload, 'utf8') > MAX_HISTORY_BYTES && metrics.modelUsage?.models?.length) {
    metrics.modelUsage = { ...metrics.modelUsage, models: metrics.modelUsage.models.slice(0, 4) };
    payload = make(metrics);
  }
  return Buffer.byteLength(payload, 'utf8') <= MAX_HISTORY_BYTES ? payload : null;
}

export class SessionHistory {
  directory: string;
  pending = new Map<string, Promise<unknown>>();
  createdDirs = new Set<string>();
  writeCache = new Map<string, HistoryWriteCacheEntry>();

  constructor(directory = join(platformPaths().data, 'history-v1')) { this.directory = directory; }
  async stamp(file: string): Promise<string | null | undefined> { return statStamp(file); }

  rememberWrite(file: string, fileStamp: string, result: HistoryRecord, metricsHash: string): void {
    this.writeCache.delete(file);
    while (this.writeCache.size >= MAX_WRITE_CACHE_ENTRIES) {
      const oldest = this.writeCache.keys().next().value;
      if (oldest === undefined) break;
      this.writeCache.delete(oldest);
    }
    this.writeCache.set(file, { fileStamp, result, metricsHash });
  }

  file(scope: string, id: string): string {
    if (!SCOPE.test(scope) || !GUID.test(id)) throw new Error('Invalid history scope');
    return join(this.directory, scope, `${id.toLowerCase().replace(/[^a-z0-9_-]/g, '_')}.json`);
  }

  async load(scope: string | null | undefined, id: string): Promise<HistoryRecord | null> {
    if (!scope) return null;
    try {
      const record = await readJsonSafe<PersistedHistoryFile>(this.file(scope, id), { maxBytes: MAX_HISTORY_BYTES });
      if (!record || !isRec(record) || record.schema !== 1 || record.account !== scope ||
        record.conversationId !== id.toLowerCase() || typeof record.savedAt !== 'string' || !Number.isFinite(Date.parse(record.savedAt))) return null;
      const metrics = safeMetrics(record.metrics, id);
      return usableMetrics(metrics) ? { metrics, savedAt: record.savedAt } : null;
    } catch { return null; }
  }

  async save(scope: string | null | undefined, id: string, value: unknown): Promise<HistoryRecord | null> {
    if (!scope) return null;
    const key = this.file(scope, id);
    const previous = this.pending.get(key) || Promise.resolve();
    const pending = previous.catch(() => {}).then(() => this.write(scope, id, value));
    this.pending.set(key, pending);
    try { return await pending; } finally { if (this.pending.get(key) === pending) this.pending.delete(key); }
  }

  async write(scope: string, id: string, value: unknown): Promise<HistoryRecord | null> {
    let metrics = safeMetrics(value, id);
    const file = this.file(scope, id);
    if (!usableMetrics(metrics)) return null;
    const cached = this.writeCache.get(file);
    const fileStamp = await this.stamp(file);
    let previous: HistoryRecord | null = null, previousHash: string | null = null;
    if (fileStamp === null) this.writeCache.delete(file);
    else if (cached && fileStamp !== undefined && cached.fileStamp === fileStamp) {
      previous = cached.result;
      previousHash = cached.metricsHash;
    } else previous = await this.load(scope, id);
    if (previous && shouldKeepSaved(previous.metrics, metrics)) {
      if (!metrics.context && !(isRec(value) && Object.hasOwn(value, 'transcriptStats'))) return previous;
      metrics = reconcileMetrics(previous.metrics, metrics, previous.savedAt);
    } else if (previous) metrics = reconcileMetrics(previous.metrics, metrics, previous.savedAt);
    metrics = safeMetrics(metrics, id);
    const savedAt = new Date().toISOString();
    const payload = fitPayloadWithinLimit(scope, id.toLowerCase(), savedAt, metrics);
    if (!payload) return previous || null;
    const metricsHash = sha256Hex(JSON.stringify(metrics));
    if (previous && (previousHash ?? sha256Hex(JSON.stringify(previous.metrics))) === metricsHash) {
      if (fileStamp) this.rememberWrite(file, fileStamp, previous, metricsHash);
      return previous;
    }
    try {
      await atomicWriteFile(file, payload, { encoding: 'utf8', mode: 0o600, createdDirs: this.createdDirs });
    } catch (error) {
      this.writeCache.delete(file);
      throw error;
    }
    const result: HistoryRecord = { metrics, savedAt };
    const nextStamp = await this.stamp(file);
    if (nextStamp) this.rememberWrite(file, nextStamp, result, metricsHash);
    return result;
  }
}
