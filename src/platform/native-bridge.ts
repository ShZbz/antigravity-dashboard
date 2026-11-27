import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface SqliteSubagentSpec {
  typeName?: string;
  role?: string;
  inherit?: boolean;
  model?: string;
  modelTier?: string;
}

export interface SqliteConversationMeta {
  createdAt?: string;
  parentConversationId?: string;
  rootConversationId?: string;
  nestingDepth?: number;
  subagentSpec?: SqliteSubagentSpec;
  stepCount?: number;
}

export interface SqliteConversationSummaryRow {
  conversationId: string;
  title: string;
  preview: string;
  lastModifiedTime: number;
  workspaceUris: string;
  projectId: string;
  parentConversationId: string;
  source: string;
  agentName: string;
}

export type SnapshotStatusKind = 'running' | 'settled' | 'unknown';
export type SnapshotTransition = 'unchanged' | 'modified' | 'newly_settled' | 'newly_discovered';

export interface SessionDescriptorInput {
  cascadeId: string;
  mtimeMs: number;
  sizeBytes: number;
  stepCount: number;
  lastUserInputStepIndex: number;
  status: string;
  prevFingerprint?: string | null;
  prevSettled?: boolean | null;
}

export interface SessionDiffItem {
  cascadeId: string;
  fingerprint: string;
  statusKind: SnapshotStatusKind;
  transition: SnapshotTransition;
  needsPoll: boolean;
  preferSqlite: boolean;
}

export interface SnapshotDiffOutput {
  dirtyIds: string[];
  newlySettledIds: string[];
  runningIds: string[];
  items: SessionDiffItem[];
}

export interface LedgerTzTransition {
  atMs: number;
  offsetSecs: number;
}

export interface LedgerSummaryQuery {
  directory: string;
  scope: string;
  nowMs: number;
  today: string;
  timeZone: string;
  source: string;
  knownAccounts: Record<string, unknown>;
  fallbackScope?: string | null;
  fixedOffsetSecs?: number | null;
  tzMinMs?: number | null;
  tzMaxMs?: number | null;
  tzTransitions?: LedgerTzTransition[] | null;
  dirtyRelPaths?: string[];
}

export interface LedgerProjectQuery {
  directory: string;
  scope: string;
  timeZone: string;
  fixedOffsetSecs?: number | null;
  tzMinMs?: number | null;
  tzMaxMs?: number | null;
  tzTransitions?: LedgerTzTransition[] | null;
  zeroAtDate: string;
  dirtyRelPaths?: string[];
}

export interface LedgerProjectDayBucket {
  date: string;
  uncached: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  requests: number;
  maxAt: number;
}

export interface LedgerProjectFileSummary {
  fileHash: string;
  docId: string;
  source: string;
  projectName: string;
  note: string;
  days: LedgerProjectDayBucket[];
}

export interface LedgerProjectSummariesResult {
  scope: string;
  timeZone: string;
  files: LedgerProjectFileSummary[];
}

export interface LedgerSharedProjectQuery {
  directory: string;
  scope: string;
  timeZone: string;
  fixedOffsetSecs?: number | null;
  tzMinMs?: number | null;
  tzMaxMs?: number | null;
  tzTransitions?: LedgerTzTransition[] | null;
  zeroAtDate: string;
  knownAccounts: Record<string, unknown>;
  fallbackScope?: string | null;
  targetHashes?: string[] | null;
  dirtyRelPaths?: string[];
}

export interface ReleaseNativeCachesResult {
  released: boolean;
  mode: 'soft' | 'full';
  ledgerCleared: boolean;
  projectCleared: boolean;
}

export interface SanitizerPatternInput {
  pattern: string;
  flags?: string;
  label: string;
}

export interface AuditOpenSourcePrivacyOptions {
  rootDir: string;
  files?: readonly string[];
  excludedDirs: readonly string[];
  excludedRelFiles: readonly string[];
  excludedSuffixes: readonly string[];
  textExtensions: readonly string[];
  patterns: readonly SanitizerPatternInput[];
}

export interface AuditOpenSourcePrivacyResult {
  checked: number;
  findings: string[];
}

export interface SyncAndAuditOpenSourceOptions {
  sourceDir: string;
  destDir: string;
  excludedDirs: readonly string[];
  excludedRelFiles: readonly string[];
  excludedSuffixes: readonly string[];
  textExtensions: readonly string[];
  patterns: readonly SanitizerPatternInput[];
}

export interface SyncAndAuditOpenSourceResult {
  exported: number;
  checked: number;
  findings: string[];
}

interface PulseAccelAddon {
  extractSqliteUsageRecordsJson(dbPath: string, conversationId: string): string | null;
  readSqliteTrajectoryJson(
    dbPath: string,
    conversationId: string,
    modelTimelineEnabled: boolean,
    maxOutputBytes?: number,
  ): string | null;
  readSqliteConversationMetaJson(dbPath: string, conversationId: string): string | null;
  readSqliteConversationSummariesJson?: (dbPath: string) => string | null;
  diffSessionSnapshotsJson?: (inputsJson: string) => string | null;
  queryUsageLedgerSummaryJson?: (queryJson: string) => string | null;
  readLedgerProjectSummariesJson?: (queryJson: string) => string | null;
  readLedgerSharedProjectSummariesJson?: (queryJson: string) => string | null;
  releaseNativeCachesJson?: (mode: string) => string | null;
  auditOpenSourcePrivacyJson?: (optionsJson: string) => string | null;
  syncAndAuditOpenSourceJson?: (optionsJson: string) => string | null;
  rotateLogTailJson?: (logPath: string, maxBytes: number, keepLines: number) => string | null;
  coalesceSwimlanesJson?: (inputJson: string) => string | null;
  compileCatmullRomSvgPathJson?: (inputJson: string) => string | null;
  discoverWin32ProcessesJson?: () => string | null;
  projectTrajectoryJson?: (inputJson: string) => string | null;
  scanTranscriptFileJson?: (inputJson: string) => string | null;
}

let cachedAddon: PulseAccelAddon | null = null;
let cachedPath: string | null = null;
let cachedEnvPath: string | null = null;
const failedPaths = new Set<string>();

function isDisabled(): boolean {
  return process.env.PULSE_DISABLE_NATIVE_ACCEL === '1';
}

function resolveImportMetaUrl(): string | undefined {
  try {
    const metaUrl = typeof import.meta === 'object' ? import.meta.url : undefined;
    return typeof metaUrl === 'string' && metaUrl.length > 0 ? metaUrl : undefined;
  } catch {
    return undefined;
  }
}

function getAddonRequire(): ((id: string) => unknown) | null {
  const metaUrl = resolveImportMetaUrl();
  if (metaUrl) {
    try {
      return createRequire(metaUrl);
    } catch {
      // Fall through to cwd-anchored createRequire.
    }
  }
  try {
    return createRequire(join(process.cwd(), 'package.json'));
  } catch {
    return null;
  }
}

export function platformAddonFilename(
  platform: string = process.platform,
  arch: string = process.arch,
): string {
  return `pulse-accel.${platform}-${arch}.node`;
}

function addonSearchBases(dir: string): string[] {
  return [join(dir, platformAddonFilename()), join(dir, 'pulse-accel.node')];
}

function candidateAddonPaths(): string[] {
  const envPath = process.env.PULSE_ACCEL_PATH?.trim();
  if (envPath) {
    return [resolve(envPath)];
  }
  const candidates: string[] = [];
  const metaUrl = resolveImportMetaUrl();
  if (metaUrl) {
    try {
      const here = dirname(fileURLToPath(metaUrl));
      candidates.push(
        ...addonSearchBases(here),
        ...addonSearchBases(join(here, '..', 'sidecars', 'panel')),
        ...addonSearchBases(join(here, '..', '..', 'sidecars', 'panel')),
      );
    } catch {
      // Ignore URL resolution failures in synthetic VM contexts.
    }
  }
  try {
    candidates.push(...addonSearchBases(join(process.cwd(), 'sidecars', 'panel')));
  } catch {
    // Ignore cwd errors.
  }
  return [...new Set(candidates)];
}

function getAddon(): PulseAccelAddon | null {
  if (isDisabled()) return null;
  const rawEnvPath = process.env.PULSE_ACCEL_PATH?.trim();
  const envPath = rawEnvPath ? resolve(rawEnvPath) : null;
  if (cachedAddon && cachedEnvPath === envPath) {
    return cachedAddon;
  }
  const req = getAddonRequire();
  if (!req) return null;
  for (const candidate of candidateAddonPaths()) {
    if (failedPaths.has(candidate)) continue;
    if (!existsSync(candidate)) continue;
    try {
      const loaded = req(candidate) as Partial<PulseAccelAddon> | null;
      if (
        loaded &&
        typeof loaded.extractSqliteUsageRecordsJson === 'function' &&
        typeof loaded.readSqliteTrajectoryJson === 'function' &&
        typeof loaded.readSqliteConversationMetaJson === 'function'
      ) {
        cachedAddon = loaded as PulseAccelAddon;
        cachedPath = candidate;
        cachedEnvPath = envPath;
        return cachedAddon;
      }
      failedPaths.add(candidate);
    } catch {
      failedPaths.add(candidate);
    }
  }
  cachedAddon = null;
  cachedPath = null;
  cachedEnvPath = null;
  return null;
}

/**
 * Returns true when the Rust `pulse-accel` N-API addon is loaded and enabled.
 */
export function isNativeAccelAvailable(): boolean {
  return getAddon() !== null;
}

/**
 * Extracts normalized `UsageRecord[]` directly from a local Antigravity `.db` SQLite file.
 * Returns `null` if the native addon is unavailable, disabled, or the file cannot be read.
 */
export function extractSqliteUsageRecords<T = unknown>(
  dbPath: string,
  conversationId: string,
): T[] | null {
  if (!dbPath || !conversationId) return null;
  const addon = getAddon();
  if (!addon) return null;
  try {
    const json = addon.extractSqliteUsageRecordsJson(dbPath, conversationId);
    if (typeof json !== 'string' || !json) return null;
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as T[]) : null;
  } catch {
    return null;
  }
}

/**
 * Reads and projects a `TrajectoryResult` directly from a local Antigravity `.db` SQLite file.
 * Returns `null` if the native addon is unavailable, disabled, or the file cannot be read.
 */
export function readSqliteTrajectory<T = unknown>(
  dbPath: string,
  conversationId: string,
  options?: { modelTimelineEnabled?: boolean; maxOutputBytes?: number },
): T | null {
  if (!dbPath || !conversationId) return null;
  const addon = getAddon();
  if (!addon) return null;
  let parsed: unknown;
  try {
    const json = addon.readSqliteTrajectoryJson(
      dbPath,
      conversationId,
      options?.modelTimelineEnabled === true,
      options?.maxOutputBytes,
    );
    if (typeof json !== 'string' || !json) return null;
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (
    parsed &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    (parsed as Record<string, unknown>).__budgetExceeded === true
  ) {
    throw new Error('会话统计数据超过内存预算');
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as T) : null;
}

/**
 * Reads lightweight conversation metadata (parent/root IDs, subagent role/spec, step count)
 * directly from a local Antigravity `.db` SQLite file.
 */
export function readSqliteConversationMeta(
  dbPath: string,
  conversationId: string,
): SqliteConversationMeta | null {
  if (!dbPath || !conversationId) return null;
  const addon = getAddon();
  if (!addon) return null;
  try {
    const json = addon.readSqliteConversationMetaJson(dbPath, conversationId);
    if (typeof json !== 'string' || !json) return null;
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as SqliteConversationMeta)
      : null;
  } catch {
    return null;
  }
}

/**
 * Reads all conversation summary rows from `conversation_summaries.db` via the
 * native SQLite reader, returning `null` when unavailable or invalid.
 */
export function readSqliteConversationSummaries(
  dbPath: string,
): SqliteConversationSummaryRow[] | null {
  if (!dbPath) return null;
  const addon = getAddon();
  const fn = addon?.readSqliteConversationSummariesJson;
  if (typeof fn !== 'function') return null;
  try {
    const json = fn(dbPath);
    if (typeof json !== 'string' || !json) return null;
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as SqliteConversationSummaryRow[]) : null;
  } catch {
    return null;
  }
}

type SingleJsonAddonMethod =
  | 'diffSessionSnapshotsJson'
  | 'queryUsageLedgerSummaryJson'
  | 'readLedgerProjectSummariesJson'
  | 'readLedgerSharedProjectSummariesJson'
  | 'auditOpenSourcePrivacyJson'
  | 'syncAndAuditOpenSourceJson';

function callSingleJsonAddon<T>(
  methodName: SingleJsonAddonMethod,
  payload: unknown,
  validate?: (parsed: Record<string, unknown>) => boolean,
): T | null {
  const addon = getAddon();
  const fn = addon?.[methodName];
  if (typeof fn !== 'function') return null;
  try {
    const json = fn(JSON.stringify(payload));
    if (typeof json !== 'string' || !json) return null;
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (validate && !validate(parsed as Record<string, unknown>)) return null;
    return parsed as T;
  } catch {
    return null;
  }
}

/**
 * Batch-computes 64-bit FNV-1a session fingerprints, status classifications,
 * transitions, and dirty/running/newly-settled IDs in native Rust.
 * Returns `null` if the native addon or entrypoint is unavailable or disabled.
 */
export function diffSessionSnapshots(
  inputs: readonly SessionDescriptorInput[],
): SnapshotDiffOutput | null {
  if (!Array.isArray(inputs)) return null;
  return callSingleJsonAddon<SnapshotDiffOutput>('diffSessionSnapshotsJson', inputs);
}

/**
 * Queries and aggregates a `UsageSummarySnapshot` directly in Rust using the
 * binary sidecar index `ledger-compact-v1.bin`, returning `null` if unavailable or on fallback.
 */
export function queryUsageLedgerSummary<T = unknown>(query: LedgerSummaryQuery): T | null {
  if (!query?.directory || !query?.scope) return null;
  return callSingleJsonAddon<T>('queryUsageLedgerSummaryJson', query);
}

/**
 * Reads and aggregates per-file daily token buckets for project stats in Rust using
 * `project-ledger-v1.bin` + process-local memory cache, returning `null` if unavailable or on fallback.
 */
export function readLedgerProjectSummaries(
  query: LedgerProjectQuery,
): LedgerProjectSummariesResult | null {
  if (!query?.directory || !query?.scope) return null;
  const payload: LedgerProjectQuery = {
    ...query,
    dirtyRelPaths: query.dirtyRelPaths ?? [],
  };
  return callSingleJsonAddon<LedgerProjectSummariesResult>(
    'readLedgerProjectSummariesJson',
    payload,
    (parsed) => Array.isArray(parsed.files),
  );
}

/**
 * Deduplicates and summarizes multi-scope shared ledger files directly in Rust
 * (`PROJECT_MEM_CACHE`), returning `null` if unavailable or on fallback.
 */
export function readLedgerSharedProjectSummaries(
  query: LedgerSharedProjectQuery,
): LedgerProjectSummariesResult | null {
  if (!query?.directory || !query?.scope || !query?.zeroAtDate) return null;
  const payload: LedgerSharedProjectQuery = {
    ...query,
    knownAccounts: query.knownAccounts ?? {},
    dirtyRelPaths: query.dirtyRelPaths ?? [],
  };
  return callSingleJsonAddon<LedgerProjectSummariesResult>(
    'readLedgerSharedProjectSummariesJson',
    payload,
    (parsed) => Array.isArray(parsed.files),
  );
}

/**
 * Releases Rust in-memory ledger and project caches (`'soft'` keeps ledger snapshot + file
 * stamps for < 1 ms unchanged reads; `'full'` clears all native caches).
 */
export function releaseNativeCaches(
  mode: 'soft' | 'full',
): ReleaseNativeCachesResult | null {
  if (mode !== 'soft' && mode !== 'full') return null;
  const addon = getAddon();
  const fn = addon?.releaseNativeCachesJson;
  if (typeof fn !== 'function') return null;
  try {
    const json = fn(mode);
    if (typeof json !== 'string' || !json) return null;
    const parsed = JSON.parse(json) as Partial<ReleaseNativeCachesResult> | null;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.released !== 'boolean' ||
      (parsed.mode !== 'soft' && parsed.mode !== 'full') ||
      typeof parsed.ledgerCleared !== 'boolean' ||
      typeof parsed.projectCleared !== 'boolean'
    ) {
      return null;
    }
    return parsed as ReleaseNativeCachesResult;
  } catch {
    return null;
  }
}

/**
 * Runs parallel file-tree walk and privacy regex audit in Rust `pulse-accel`.
 * Returns `null` when native acceleration is disabled/unavailable or any pattern
 * uses JS-only regex features (such as lookarounds or backreferences).
 */
export function auditOpenSourcePrivacy(
  options: AuditOpenSourcePrivacyOptions,
): AuditOpenSourcePrivacyResult | null {
  if (!options?.rootDir) return null;
  return callSingleJsonAddon<AuditOpenSourcePrivacyResult>(
    'auditOpenSourcePrivacyJson',
    options,
    (parsed) => Array.isArray(parsed.findings),
  );
}

/**
 * Syncs open-source safe files, applies sanitizer transforms, prunes stale entries,
 * and audits the destination tree in Rust `pulse-accel`.
 * Returns `null` when native acceleration is disabled/unavailable or patterns require JS fallback.
 */
export function syncAndAuditOpenSource(
  options: SyncAndAuditOpenSourceOptions,
): SyncAndAuditOpenSourceResult | null {
  if (!options?.sourceDir || !options?.destDir) return null;
  return callSingleJsonAddon<SyncAndAuditOpenSourceResult>(
    'syncAndAuditOpenSourceJson',
    options,
    (parsed) => Array.isArray(parsed.findings),
  );
}

/**
 * Truncates `logPath` to at most the last `keepLines` lines whenever its byte size
 * exceeds `maxBytes`. Returns `null` if the native addon or entrypoint is unavailable.
 */
export function rotateLogTailNative(
  logPath: string,
  maxBytes: number,
  keepLines: number,
): boolean | null {
  if (
    !logPath ||
    !Number.isFinite(maxBytes) ||
    maxBytes < 0 ||
    !Number.isFinite(keepLines) ||
    keepLines < 0
  ) {
    return null;
  }
  const addon = getAddon();
  if (!addon || typeof addon.rotateLogTailJson !== 'function') return null;
  try {
    const json = addon.rotateLogTailJson(
      logPath,
      Math.floor(maxBytes),
      Math.floor(keepLines),
    );
    if (typeof json !== 'string' || !json) return null;
    const parsed = JSON.parse(json) as { rotated?: unknown };
    return typeof parsed?.rotated === 'boolean' ? parsed.rotated : null;
  } catch {
    return null;
  }
}

type RawStringAddonMethod =
  | 'coalesceSwimlanesJson'
  | 'scanTranscriptFileJson';

function callRawSingleStringAddon(methodName: RawStringAddonMethod, inputJson: string): string | null {
  if (!inputJson) return null;
  const addon = getAddon();
  const fn = addon?.[methodName];
  if (typeof fn !== 'function') return null;
  try {
    const out = fn(inputJson);
    return typeof out === 'string' && out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** Coalesces timeline swimlanes in Rust `pulse-accel`, returning raw JSON or `null`. */
export function tryCoalesceSwimlanesJson(inputJson: string): string | null {
  return callRawSingleStringAddon('coalesceSwimlanesJson', inputJson);
}

/** Scans a JSONL transcript file directly in Rust `pulse-accel`, returning raw JSON or `null`. */
export function tryScanTranscriptFileJson(inputJson: string): string | null {
  return callRawSingleStringAddon('scanTranscriptFileJson', inputJson);
}

/** Discovers Win32 Antigravity `language_server` processes and listening TCP ports in Rust. */
export function tryDiscoverWin32ProcessesJson(): string | null {
  const addon = getAddon();
  const fn = addon?.discoverWin32ProcessesJson;
  if (typeof fn !== 'function') return null;
  try {
    const out = fn();
    return typeof out === 'string' && out.length > 0 ? out : null;
  } catch {
    return null;
  }
}
