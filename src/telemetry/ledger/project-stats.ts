import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type {
  ProjectConversationDetail,
  ProjectConversationItem,
  ProjectKind,
  ProjectUsageDayBucket,
  ProjectUsageItem,
  ProjectUsageOverview,
  UsageBucketCounts,
  UsageRecord,
} from '../../contracts/usage.ts';
import {
  isNativeAccelAvailable,
  readLedgerProjectSummaries,
  readLedgerSharedProjectSummaries,
  readSqliteConversationSummaries,
  type LedgerProjectDayBucket,
  type LedgerProjectFileSummary,
  type SqliteConversationSummaryRow,
} from '../../platform/native-bridge.ts';
import { formatStatStamp, statStamp, type FileStatLike } from '../../shared/atomic-fs.ts';
import { isErrno, mapPool, recordSum, sha256, validRow } from './helpers.ts';
import type { UsageLedger } from './summary.ts';
import { dateTimeParts, resolveTimeZoneSpec } from './timezone.ts';
import {
  HASH_RE,
  LEDGER_FILE_RE,
  MAX_RECORD_FILE_BYTES,
  type KnownAccountInfo,
  type LedgerDocument,
} from './types.ts';

export interface ProjectStatsStoreLike {
  identity?: { accountScope?: string | null; email?: string | null } | string | null;
  rawSummaries?: Record<string, unknown> | null;
}

export interface ProjectUsageQueryOptions {
  ledger: UsageLedger;
  store?: ProjectStatsStoreLike | null;
  profileDir?: string | null;
  scope?: string | null;
  from?: string | null;
  to?: string | null;
  timeZone?: string | null;
  readSummaries?: ((dbPath: string) => SqliteConversationSummaryRow[] | null) | null;
}

export interface ProjectDetailQueryOptions extends ProjectUsageQueryOptions {
  projectKey: string;
}

interface SummaryMetaEntry {
  cid: string;
  title: string;
  preview: string;
  lastModifiedTime: number;
  workspaceUris: string[];
  projectId: string;
  parentConversationId: string;
  source: string;
  agentName: string;
}

interface ResolvedProject {
  projectKey: string;
  name: string;
  kind: ProjectKind;
  workspacePath?: string;
}

interface DirentLike {
  name: string;
  isFile(): boolean;
}

const MAX_PARENT_HOPS = 16;
const WORKTREE_RE =
  /(?:^|\/)(?:\.gemini\/antigravity|\.antigravity|\.git)\/worktrees\/([^/]+)(?:\/|$)/i;
const GENERIC_WORKTREE_RE = /\/worktrees\/([^/]+)\//i;

function addDayBucket(target: UsageBucketCounts, day: LedgerProjectDayBucket): void {
  const total = day.uncached + day.cacheRead + day.cacheWrite + day.output;
  target.uncached += day.uncached;
  target.cacheRead += day.cacheRead;
  target.cacheWrite += day.cacheWrite;
  target.output += day.output;
  target.total += total;
  target.requests += day.requests;
}

function emptyBucket(): UsageBucketCounts {
  return { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0, requests: 0 };
}

function cleanText(raw: string | undefined | null): string {
  return typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
}

function truncateLabel(text: string, maxLen = 64): string {
  return text.length > maxLen ? `${text.slice(0, maxLen - 1)}…` : text;
}

function parseWorkspaceUris(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((v) => String(v || '').trim()).filter(Boolean);
  }
  if (typeof raw !== 'string') return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map((v) => String(v || '').trim()).filter(Boolean);
    } catch {
      // Fall through to delimiter splitting.
    }
  }
  return trimmed
    .split(/[\r\n,]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

function normalizeUriPath(uri: string): string {
  let out = uri.trim();
  if (!out || out === 'outside-of-project' || out === 'default-cli-project') return '';
  if (out.startsWith('file://')) {
    out = out.slice('file://'.length);
    if (out.startsWith('/') && /^\/[a-zA-Z](?:%3A|:)/.test(out)) {
      out = out.slice(1);
    }
    try {
      out = decodeURIComponent(out);
    } catch {
      // Keep original string if URI percent-encoding is malformed.
    }
  }
  out = out.replace(/\\/g, '/').replace(/\/+$/, '');
  if (/^[a-zA-Z]:/.test(out)) {
    out = `${out[0].toLowerCase()}${out.slice(1)}`;
  }
  return out;
}

function extractWorktreeRepo(normalizedPath: string): string {
  const m1 = WORKTREE_RE.exec(normalizedPath);
  if (m1?.[1]) return m1[1];
  const m2 = GENERIC_WORKTREE_RE.exec(normalizedPath);
  return m2?.[1] || '';
}

function pathBasename(pathStr: string): string {
  const cleaned = pathStr.replace(/\/+$/, '');
  const idx = cleaned.lastIndexOf('/');
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

function normalizeMs(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
  if (typeof raw === 'string' && raw) {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

async function readDbWithNodeSqlite(dbPath: string): Promise<SqliteConversationSummaryRow[] | null> {
  if (!dbPath || !existsSync(dbPath)) return null;
  try {
    const req = createRequire(import.meta.url);
    const mod = req('node:sqlite') as { DatabaseSync?: new (path: string, opts?: { readOnly?: boolean }) => { prepare(sql: string): { all(): Array<Record<string, unknown>> }; close(): void } };
    const DatabaseSync = mod.DatabaseSync;
    if (typeof DatabaseSync !== 'function') return null;
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db
        .prepare(
          `SELECT conversation_id, COALESCE(title, '') AS title, COALESCE(preview, '') AS preview,
                  COALESCE(last_modified_time, 0) AS last_modified_time, COALESCE(workspace_uris, '') AS workspace_uris,
                  COALESCE(project_id, '') AS project_id, COALESCE(parent_conversation_id, '') AS parent_conversation_id,
                  COALESCE(source, '') AS source, COALESCE(agent_name, '') AS agent_name
           FROM conversation_summaries`,
        )
        .all() as Array<Record<string, unknown>>;
      return rows.map((r) => {
        const vals = Object.values(r);
        return {
          conversationId: String(r.conversation_id ?? vals[0] ?? ''),
          title: String(r.title ?? vals[1] ?? ''),
          preview: String(r.preview ?? vals[2] ?? ''),
          lastModifiedTime: normalizeMs(r.last_modified_time ?? vals[3]),
          workspaceUris: String(r.workspace_uris ?? vals[4] ?? ''),
          projectId: String(r.project_id ?? vals[5] ?? ''),
          parentConversationId: String(r.parent_conversation_id ?? vals[6] ?? ''),
          source: String(r.source ?? vals[7] ?? ''),
          agentName: String(r.agent_name ?? vals[8] ?? ''),
        };
      });
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function hasNonEmptyMeta(e: SummaryMetaEntry): boolean {
  return Boolean(
    e.title ||
      e.preview ||
      e.workspaceUris.length > 0 ||
      e.projectId ||
      e.parentConversationId ||
      e.source ||
      e.agentName ||
      e.lastModifiedTime > 0,
  );
}

function normalizeMetaEntry(fallbackCid: string, raw: unknown): SummaryMetaEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const cid = cleanText(typeof obj.cid === 'string' ? obj.cid : '') || cleanText(fallbackCid);
  if (!cid) return null;
  const entry: SummaryMetaEntry = {
    cid,
    title: cleanText(typeof obj.title === 'string' ? obj.title : ''),
    preview: cleanText(typeof obj.preview === 'string' ? obj.preview : ''),
    lastModifiedTime: normalizeMs(obj.lastModifiedTime),
    workspaceUris: parseWorkspaceUris(obj.workspaceUris),
    projectId: cleanText(typeof obj.projectId === 'string' ? obj.projectId : ''),
    parentConversationId: cleanText(
      typeof obj.parentConversationId === 'string' ? obj.parentConversationId : '',
    ),
    source: cleanText(typeof obj.source === 'string' ? obj.source : ''),
    agentName: cleanText(typeof obj.agentName === 'string' ? obj.agentName : ''),
  };
  return hasNonEmptyMeta(entry) ? entry : null;
}

function parseRawSummaryEntry(cid: string, val: unknown): SummaryMetaEntry | null {
  const cleanedCid = cleanText(cid);
  if (!cleanedCid || !val || typeof val !== 'object') return null;
  const obj = val as Record<string, unknown>;
  const tMeta =
    obj.trajectoryMetadata && typeof obj.trajectoryMetadata === 'object'
      ? (obj.trajectoryMetadata as Record<string, unknown>)
      : null;
  const spec =
    tMeta?.subagentSpec && typeof tMeta.subagentSpec === 'object'
      ? (tMeta.subagentSpec as Record<string, unknown>)
      : null;
  const urisFromRaw = Array.isArray(obj.workspaces)
    ? obj.workspaces
        .map((w) =>
          w && typeof w === 'object'
            ? String((w as Record<string, unknown>).workspaceFolderAbsoluteUri || '').trim()
            : '',
        )
        .filter(Boolean)
    : [];
  return {
    cid: cleanedCid,
    title: cleanText(obj.summary as string),
    preview: '',
    lastModifiedTime: normalizeMs(obj.lastModifiedTime),
    workspaceUris: urisFromRaw,
    projectId: '',
    parentConversationId: cleanText(tMeta?.parentConversationId as string),
    source: '',
    agentName: cleanText(spec?.role as string),
  };
}

function mergeSummaryMetaEntry(
  existing: SummaryMetaEntry | undefined,
  incoming: SummaryMetaEntry,
  preferIncomingOnEqualMtime: boolean,
): SummaryMetaEntry {
  if (!existing) return incoming;
  const incomingIsNewer = incoming.lastModifiedTime > existing.lastModifiedTime;
  const incomingCanUpdate =
    incomingIsNewer ||
    (preferIncomingOnEqualMtime && incoming.lastModifiedTime >= existing.lastModifiedTime);
  const pickStr = (oldVal: string, newVal: string): string => {
    if (!newVal) return oldVal;
    if (!oldVal) return newVal;
    return incomingCanUpdate ? newVal : oldVal;
  };
  const pickUris = (oldUris: string[], newUris: string[]): string[] => {
    if (newUris.length === 0) return oldUris;
    if (oldUris.length === 0) return newUris;
    return incomingCanUpdate ? [...newUris] : [...oldUris];
  };
  return {
    cid: incoming.cid || existing.cid,
    title: pickStr(existing.title, incoming.title),
    preview: pickStr(existing.preview, incoming.preview),
    lastModifiedTime: Math.max(existing.lastModifiedTime, incoming.lastModifiedTime),
    workspaceUris: pickUris(existing.workspaceUris, incoming.workspaceUris),
    projectId: pickStr(existing.projectId, incoming.projectId),
    parentConversationId: pickStr(existing.parentConversationId, incoming.parentConversationId),
    source: pickStr(existing.source, incoming.source),
    agentName: pickStr(existing.agentName, incoming.agentName),
  };
}

function metaEntryEquals(a: SummaryMetaEntry, b: SummaryMetaEntry): boolean {
  if (
    a.cid !== b.cid ||
    a.title !== b.title ||
    a.preview !== b.preview ||
    a.lastModifiedTime !== b.lastModifiedTime ||
    a.projectId !== b.projectId ||
    a.parentConversationId !== b.parentConversationId ||
    a.source !== b.source ||
    a.agentName !== b.agentName ||
    a.workspaceUris.length !== b.workspaceUris.length
  ) {
    return false;
  }
  for (let i = 0; i < a.workspaceUris.length; i++) {
    if (a.workspaceUris[i] !== b.workspaceUris[i]) return false;
  }
  return true;
}

async function statProjectMetaStamp(ledger: UsageLedger): Promise<string> {
  try {
    const st = await ledger._stat(ledger.projectMetaFile());
    return formatStatStamp(st) ?? 'ENOENT';
  } catch {
    return 'ERR';
  }
}

async function readPersistedProjectMeta(ledger: UsageLedger): Promise<{
  stamp: string;
  entries: Map<string, SummaryMetaEntry>;
}> {
  const file = ledger.projectMetaFile();
  const entries = new Map<string, SummaryMetaEntry>();
  let stamp = 'ENOENT';
  try {
    const st = await ledger._stat(file);
    stamp = formatStatStamp(st) ?? 'ENOENT';
    if (!st) return { stamp, entries };
    const text = await ledger.fs.readFile(file, 'utf8');
    if (text.length <= MAX_RECORD_FILE_BYTES) {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>;
        const rawEntries =
          obj.schema === 1 && obj.entries && typeof obj.entries === 'object' && !Array.isArray(obj.entries)
            ? (obj.entries as Record<string, unknown>)
            : null;
        if (rawEntries) {
          for (const [key, val] of Object.entries(rawEntries)) {
            const norm = normalizeMetaEntry(key, val);
            if (norm) entries.set(norm.cid.toLowerCase(), norm);
          }
        }
      }
    }
  } catch (error) {
    if (isErrno(error, 'ENOENT', 'ENOTDIR')) return { stamp: 'ENOENT', entries };
    if (!(error instanceof SyntaxError)) {
      return { stamp: 'ERR', entries };
    }
  }
  return { stamp, entries };
}

async function mergeAndPersistProjectMeta(
  ledger: UsageLedger,
  liveEntries: ReadonlyMap<string, SummaryMetaEntry>,
): Promise<{ stamp: string; entries: Map<string, SummaryMetaEntry> }> {
  return await ledger.enqueueWrite(async () => {
    const disk = await readPersistedProjectMeta(ledger);
    const mergedMap = new Map(disk.entries);
    let changed = false;
    for (const [key, live] of liveEntries) {
      if (!hasNonEmptyMeta(live)) continue;
      const prev = mergedMap.get(key);
      const merged = mergeSummaryMetaEntry(prev, live, true);
      if (!prev || !metaEntryEquals(prev, merged)) {
        mergedMap.set(key, merged);
        changed = true;
      }
    }
    if (!changed) {
      return { stamp: disk.stamp, entries: mergedMap };
    }
    const sortedEntries: Record<string, SummaryMetaEntry> = {};
    for (const key of [...mergedMap.keys()].sort()) {
      sortedEntries[key] = mergedMap.get(key)!;
    }
    const file = ledger.projectMetaFile();
    await ledger._atomicWrite(
      ledger.directory,
      file,
      JSON.stringify({ schema: 1, entries: sortedEntries }),
    );
    const nextStamp = await statProjectMetaStamp(ledger);
    return { stamp: nextStamp, entries: mergedMap };
  });
}

/**
 * Persists non-empty conversation metadata from `store.rawSummaries` into
 * `project-meta-v1.json` without clobbering existing fields or writing when unchanged.
 */
export async function persistProjectMetaFromRawSummaries(
  ledger: UsageLedger,
  rawSummaries: Record<string, unknown> | null | undefined,
): Promise<void> {
  if (!rawSummaries || typeof rawSummaries !== 'object') return;
  const live = new Map<string, SummaryMetaEntry>();
  for (const [cid, val] of Object.entries(rawSummaries)) {
    const entry = parseRawSummaryEntry(cid, val);
    if (entry && hasNonEmptyMeta(entry)) {
      live.set(entry.cid.toLowerCase(), entry);
    }
  }
  if (live.size === 0) return;
  const disk = await readPersistedProjectMeta(ledger);
  let needsPersist = false;
  for (const [key, entry] of live) {
    const prev = disk.entries.get(key);
    const merged = mergeSummaryMetaEntry(prev, entry, true);
    if (!prev || !metaEntryEquals(prev, merged)) {
      needsPersist = true;
      break;
    }
  }
  if (needsPersist) {
    await mergeAndPersistProjectMeta(ledger, live);
  }
}

async function loadSummaryMeta(
  ledger: UsageLedger,
  dbPath: string | null,
  rawSummaries: Record<string, unknown> | null | undefined,
  customReader?: ((dbPath: string) => SqliteConversationSummaryRow[] | null) | null,
): Promise<{ metaByCid: Map<string, SummaryMetaEntry>; projectMetaStamp: string }> {
  const liveByCid = new Map<string, SummaryMetaEntry>();
  let dbRows: SqliteConversationSummaryRow[] | null = null;
  if (dbPath && existsSync(dbPath)) {
    dbRows = customReader ? customReader(dbPath) : readSqliteConversationSummaries(dbPath);
    if (dbRows === null && !customReader) {
      dbRows = await readDbWithNodeSqlite(dbPath);
    }
  }
  for (const row of dbRows || []) {
    const cid = cleanText(row.conversationId);
    if (!cid) continue;
    liveByCid.set(cid.toLowerCase(), {
      cid,
      title: cleanText(row.title),
      preview: cleanText(row.preview),
      lastModifiedTime: normalizeMs(row.lastModifiedTime),
      workspaceUris: parseWorkspaceUris(row.workspaceUris),
      projectId: cleanText(row.projectId),
      parentConversationId: cleanText(row.parentConversationId),
      source: cleanText(row.source),
      agentName: cleanText(row.agentName),
    });
  }
  if (rawSummaries && typeof rawSummaries === 'object') {
    for (const [cid, val] of Object.entries(rawSummaries)) {
      const rawEntry = parseRawSummaryEntry(cid, val);
      if (!rawEntry) continue;
      const key = rawEntry.cid.toLowerCase();
      liveByCid.set(key, mergeSummaryMetaEntry(liveByCid.get(key), rawEntry, false));
    }
  }

  const disk = await readPersistedProjectMeta(ledger);
  const persistableLive = new Map<string, SummaryMetaEntry>();
  let needsPersist = false;
  for (const [key, live] of liveByCid) {
    if (!hasNonEmptyMeta(live)) continue;
    persistableLive.set(key, live);
    const prev = disk.entries.get(key);
    const merged = mergeSummaryMetaEntry(prev, live, true);
    if (!prev || !metaEntryEquals(prev, merged)) {
      needsPersist = true;
    }
  }

  let persisted = disk;
  if (needsPersist) {
    try {
      persisted = await mergeAndPersistProjectMeta(ledger, persistableLive);
    } catch {
      // Keep query resilient even if metadata persistence fails.
      const fallbackEntries = new Map(disk.entries);
      for (const [key, live] of persistableLive) {
        fallbackEntries.set(key, mergeSummaryMetaEntry(fallbackEntries.get(key), live, true));
      }
      persisted = { stamp: 'ERR', entries: fallbackEntries };
    }
  }

  const metaByCid = new Map(persisted.entries);
  for (const [key, live] of liveByCid) {
    if (!metaByCid.has(key)) {
      metaByCid.set(key, live);
    }
  }
  return { metaByCid, projectMetaStamp: persisted.stamp };
}

function buildProjectResolver(metaByCid: Map<string, SummaryMetaEntry>) {
  const canonicalPathByProjectId = new Map<string, string>();
  const canonicalPathByBasename = new Map<string, string>();
  const resolvedCache = new Map<string, ResolvedProject>();

  for (const meta of metaByCid.values()) {
    for (const uri of meta.workspaceUris) {
      const normalized = normalizeUriPath(uri);
      if (!normalized || extractWorktreeRepo(normalized)) continue;
      const base = pathBasename(normalized).toLowerCase();
      if (base && !canonicalPathByBasename.has(base)) {
        canonicalPathByBasename.set(base, normalized);
      }
      if (
        meta.projectId &&
        meta.projectId !== 'outside-of-project' &&
        meta.projectId !== 'default-cli-project' &&
        !canonicalPathByProjectId.has(meta.projectId)
      ) {
        canonicalPathByProjectId.set(meta.projectId, normalized);
      }
    }
  }

  function resolve(cid: string, doc?: LedgerDocument | null): ResolvedProject {
    const key = cid.toLowerCase();
    const cached = resolvedCache.get(key);
    if (cached && !doc) return cached;

    if (doc?.metadata?.source === 'remote-manual') {
      const name = cleanText(doc.metadata.projectName) || 'remote';
      return { projectKey: `remote:${name.toLowerCase()}`, name, kind: 'remote' };
    }

    let chosenMeta: SummaryMetaEntry | undefined = metaByCid.get(key);
    let projectId = chosenMeta?.projectId || '';
    let source = chosenMeta?.source || '';
    let uris = chosenMeta?.workspaceUris || [];

    // Inherit workspace/project from parent chain when a subagent omits them.
    let cursor = chosenMeta?.parentConversationId;
    const seen = new Set<string>([key]);
    let hops = 0;
    while (cursor && hops < MAX_PARENT_HOPS) {
      const pKey = cursor.toLowerCase();
      if (seen.has(pKey)) break;
      seen.add(pKey);
      const pMeta = metaByCid.get(pKey);
      if (!pMeta) break;
      if (!uris.length && pMeta.workspaceUris.length) uris = pMeta.workspaceUris;
      if (!projectId && pMeta.projectId) projectId = pMeta.projectId;
      if (!source && pMeta.source) source = pMeta.source;
      if (uris.length && projectId) break;
      cursor = pMeta.parentConversationId;
      hops += 1;
    }

    const isRemote = cid.includes('/');
    let out: ResolvedProject;
    if (
      projectId === 'default-cli-project' ||
      source === 'CORTEX_TRAJECTORY_SOURCE_CLI' ||
      uris.some((u) => u.trim() === 'default-cli-project')
    ) {
      out = { projectKey: 'cli', name: 'cli', kind: 'cli' };
    } else {
      const normalizedList = uris.map(normalizeUriPath).filter(Boolean);
      const primaryNonWorktree = normalizedList.find((p) => !extractWorktreeRepo(p));
      const mappedFromProjectId = projectId ? canonicalPathByProjectId.get(projectId) : undefined;
      const resolvedPath = primaryNonWorktree || mappedFromProjectId;

      if (resolvedPath) {
        out = {
          projectKey: `project:${resolvedPath.toLowerCase()}`,
          name: pathBasename(resolvedPath) || resolvedPath,
          kind: isRemote ? 'remote' : 'project',
          workspacePath: resolvedPath,
        };
      } else {
        const worktreeRepo = normalizedList.map(extractWorktreeRepo).find(Boolean);
        if (worktreeRepo) {
          const matchedPath = canonicalPathByBasename.get(worktreeRepo.toLowerCase());
          if (matchedPath) {
            out = {
              projectKey: `project:${matchedPath.toLowerCase()}`,
              name: pathBasename(matchedPath) || worktreeRepo,
              kind: 'project',
              workspacePath: matchedPath,
            };
          } else {
            out = {
              projectKey: `project:worktree:${worktreeRepo.toLowerCase()}`,
              name: worktreeRepo,
              kind: 'project',
            };
          }
        } else if (isRemote) {
          const prefix = cid.slice(0, cid.indexOf('/'));
          const cleanPid =
            projectId && projectId !== 'outside-of-project' ? projectId : '';
          out = {
            projectKey: `remote:${(cleanPid || prefix).toLowerCase()}`,
            name: cleanPid || `remote (${prefix})`,
            kind: 'remote',
          };
        } else {
          out = { projectKey: 'conversations', name: 'conversations', kind: 'conversations' };
        }
      }
    }

    if (!doc) resolvedCache.set(key, out);
    return out;
  }

  return { resolve };
}

function resolveRootAncestor(
  cid: string,
  metaByCid: Map<string, SummaryMetaEntry>,
): { rootId: string | null; rootTitle: string | null } {
  const meta = metaByCid.get(cid.toLowerCase());
  if (!meta?.parentConversationId) return { rootId: null, rootTitle: null };

  let current = meta.parentConversationId;
  let rootKey = current.toLowerCase();
  const seen = new Set<string>([cid.toLowerCase()]);
  for (let i = 0; i < MAX_PARENT_HOPS && current; i++) {
    const key = current.toLowerCase();
    if (seen.has(key)) break;
    seen.add(key);
    rootKey = key;
    const pMeta = metaByCid.get(key);
    if (!pMeta?.parentConversationId) break;
    current = pMeta.parentConversationId;
  }

  const rootMeta = metaByCid.get(rootKey);
  const rootId = rootMeta?.cid || current || rootKey;
  const rootTitle = rootMeta
    ? rootMeta.title || (rootMeta.preview ? truncateLabel(rootMeta.preview, 64) : null)
    : null;
  return { rootId, rootTitle };
}

function resolveConversationTitle(
  cid: string,
  metaByCid: Map<string, SummaryMetaEntry>,
  file?: Pick<LedgerProjectFileSummary, 'note' | 'projectName'> | null,
): string {
  const meta = metaByCid.get(cid.toLowerCase());
  if (meta?.title) return meta.title;
  if (meta?.preview) return truncateLabel(meta.preview, 64);

  if (meta?.parentConversationId) {
    let cursor: string | undefined = meta.parentConversationId;
    const seen = new Set<string>([cid.toLowerCase()]);
    for (let i = 0; i < MAX_PARENT_HOPS && cursor; i++) {
      const pKey = cursor.toLowerCase();
      if (seen.has(pKey)) break;
      seen.add(pKey);
      const pMeta = metaByCid.get(pKey);
      if (!pMeta) break;
      const pTitle = pMeta.title || (pMeta.preview ? truncateLabel(pMeta.preview, 40) : '');
      if (pTitle) {
        return meta.agentName ? `${pTitle} · ${meta.agentName}` : `${pTitle} · subagent`;
      }
      cursor = pMeta.parentConversationId;
    }
    if (meta.agentName) return `${meta.agentName} (${cid.slice(0, 8)})`;
  }

  const docNote = cleanText(file?.note);
  if (docNote && !HASH_RE.test(docNote)) return truncateLabel(docNote, 64);
  const docProj = cleanText(file?.projectName);
  if (docProj && !HASH_RE.test(docProj)) return truncateLabel(docProj, 64);

  if (meta?.projectId === 'default-cli-project' || meta?.source === 'CORTEX_TRAJECTORY_SOURCE_CLI') {
    return `cli · ${cid.slice(0, 8)}`;
  }
  if (cid.includes('/')) {
    const slash = cid.indexOf('/');
    const prefix = cid.slice(0, slash);
    const tail = cid.slice(slash + 1);
    return `${prefix} · ${tail.slice(0, 8)}`;
  }
  return `Session ${cid.slice(0, 8)}`;
}

interface SummaryMetaCacheEntry {
  dbPath: string | null;
  dbStamp: string;
  walStamp: string;
  projectMetaStamp: string;
  rawSummariesRef: Record<string, unknown> | null | undefined;
  customReader: ((dbPath: string) => SqliteConversationSummaryRow[] | null) | null;
  metaByCid: Map<string, SummaryMetaEntry>;
  cidByHash: Map<string, string>;
  resolver: ReturnType<typeof buildProjectResolver>;
}

interface ScopeFileCacheEntry {
  stamp: string;
  summary: LedgerProjectFileSummary | null;
}

interface ScopeTimeZoneCacheEntry {
  filesByHash: Map<string, ScopeFileCacheEntry>;
}

interface ProjectStatsCache {
  summaryMeta: SummaryMetaCacheEntry | null;
  scopes: Map<string, ScopeTimeZoneCacheEntry>;
}

const projectStatsCache = new WeakMap<object, ProjectStatsCache>();

function getProjectStatsCache(ledger: UsageLedger): ProjectStatsCache {
  let entry = projectStatsCache.get(ledger);
  if (!entry) {
    entry = { summaryMeta: null, scopes: new Map() };
    projectStatsCache.set(ledger, entry);
  }
  return entry;
}

function getScopeTimeZoneCache(
  cache: ProjectStatsCache,
  scope: string,
  timeZone: string,
): ScopeTimeZoneCacheEntry {
  const key = `${scope}\0${timeZone}`;
  let entry = cache.scopes.get(key);
  if (!entry) {
    entry = { filesByHash: new Map() };
    cache.scopes.set(key, entry);
  }
  return entry;
}

async function getSummaryMetaState(
  cache: ProjectStatsCache,
  ledger: UsageLedger,
  dbPath: string | null,
  rawSummaries: Record<string, unknown> | null | undefined,
  customReader?: ((dbPath: string) => SqliteConversationSummaryRow[] | null) | null,
): Promise<SummaryMetaCacheEntry> {
  const normalizedReader = customReader ?? null;
  let dbStamp = 'NONE';
  let walStamp = 'NONE';
  const [projectMetaStamp, dbStamps] = await Promise.all([
    statProjectMetaStamp(ledger),
    dbPath
      ? Promise.all([statStamp(dbPath), statStamp(`${dbPath}-wal`)])
      : Promise.resolve<[string | null | undefined, string | null | undefined]>(['NONE', 'NONE']),
  ]);
  if (dbPath) {
    const [dbRaw, walRaw] = dbStamps;
    dbStamp = dbRaw === undefined ? 'ERR' : dbRaw ?? 'ENOENT';
    walStamp = walRaw === undefined ? 'ERR' : walRaw ?? 'ENOENT';
  }
  const cached = cache.summaryMeta;
  if (
    cached &&
    dbStamp !== 'ERR' &&
    walStamp !== 'ERR' &&
    projectMetaStamp !== 'ERR' &&
    cached.dbPath === dbPath &&
    cached.dbStamp === dbStamp &&
    cached.walStamp === walStamp &&
    cached.projectMetaStamp === projectMetaStamp &&
    cached.rawSummariesRef === rawSummaries &&
    cached.customReader === normalizedReader
  ) {
    return cached;
  }

  const { metaByCid, projectMetaStamp: finalProjectMetaStamp } = await loadSummaryMeta(
    ledger,
    dbPath,
    rawSummaries,
    normalizedReader,
  );
  const cidByHash = new Map<string, string>();
  for (const meta of metaByCid.values()) {
    if (!meta.cid) continue;
    cidByHash.set(sha256(meta.cid), meta.cid);
    cidByHash.set(sha256(meta.cid.toLowerCase()), meta.cid);
  }
  const resolver = buildProjectResolver(metaByCid);
  const next: SummaryMetaCacheEntry = {
    dbPath,
    dbStamp,
    walStamp,
    projectMetaStamp: finalProjectMetaStamp,
    rawSummariesRef: rawSummaries,
    customReader: normalizedReader,
    metaByCid,
    cidByHash,
    resolver,
  };
  if (dbStamp !== 'ERR' && walStamp !== 'ERR' && finalProjectMetaStamp !== 'ERR') {
    cache.summaryMeta = next;
  }
  return next;
}

function summarizeLedgerDoc(
  fileHash: string,
  doc: LedgerDocument,
  timeZone: string,
  zeroAtDate: string,
): LedgerProjectFileSummary {
  const dayBuckets = new Map<string, LedgerProjectDayBucket>();
  for (const rec of doc.records) {
    if (!validRow(rec)) continue;
    const at = typeof rec.at === 'number' ? rec.at : 0;
    const date = at === 0 ? zeroAtDate : dateTimeParts(at, timeZone).date;
    let bucket = dayBuckets.get(date);
    if (!bucket) {
      bucket = {
        date,
        uncached: 0,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0,
        requests: 0,
        maxAt: 0,
      };
      dayBuckets.set(date, bucket);
    }
    bucket.uncached += rec.uncached ?? 0;
    bucket.cacheRead += rec.cacheRead ?? 0;
    bucket.cacheWrite += rec.cacheWrite ?? 0;
    bucket.output += rec.output ?? 0;
    bucket.requests += 1;
    if (at > bucket.maxAt) bucket.maxAt = at;
  }
  return {
    fileHash,
    docId: typeof doc.id === 'string' ? doc.id : '',
    source: typeof doc.metadata?.source === 'string' ? doc.metadata.source : '',
    projectName: typeof doc.metadata?.projectName === 'string' ? doc.metadata.projectName : '',
    note: typeof doc.metadata?.note === 'string' ? doc.metadata.note : '',
    days: Array.from(dayBuckets.values()),
  };
}

async function readAndSummarizeLedgerFile(
  ledger: UsageLedger,
  fileHash: string,
  filePath: string,
  st: FileStatLike,
  timeZone: string,
  zeroAtDate: string,
): Promise<{ cacheable: boolean; enoent: boolean; summary: LedgerProjectFileSummary | null }> {
  if (Number(st.size) > MAX_RECORD_FILE_BYTES) {
    return { cacheable: true, enoent: false, summary: null };
  }
  try {
    const text = await ledger.fs.readFile(filePath, 'utf8');
    if (text.length > MAX_RECORD_FILE_BYTES) {
      return { cacheable: true, enoent: false, summary: null };
    }
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { cacheable: true, enoent: false, summary: null };
    }
    const doc = parsed as LedgerDocument;
    if (!Array.isArray(doc.records)) {
      return { cacheable: true, enoent: false, summary: null };
    }
    return {
      cacheable: true,
      enoent: false,
      summary: summarizeLedgerDoc(fileHash, doc, timeZone, zeroAtDate),
    };
  } catch (err) {
    if (isErrno(err, 'ENOENT', 'ENOTDIR')) {
      return { cacheable: false, enoent: true, summary: null };
    }
    if (err instanceof SyntaxError) {
      return { cacheable: true, enoent: false, summary: null };
    }
    return { cacheable: false, enoent: false, summary: null };
  }
}

function consumeDirtyRelPathsForScope(
  ledger: UsageLedger,
  dirtySnapshot: readonly string[],
  scope: string,
): void {
  const prefix = `${scope}/`;
  for (const rel of dirtySnapshot) {
    if (rel.startsWith(prefix)) {
      ledger.projectDirtyRelPaths.delete(rel);
    }
  }
}

function tryReadNativeScopeSummaries(
  ledger: UsageLedger,
  scope: string,
  timeZone: string,
  zeroAtDate: string,
  scopeCache: ScopeTimeZoneCacheEntry,
): LedgerProjectFileSummary[] | null {
  if (ledger.hasCustomFs || !isNativeAccelAvailable()) return null;
  const dirtySnapshot = [...ledger.projectDirtyRelPaths];
  const tzSpec = resolveTimeZoneSpec(timeZone, Date.now());
  const res = readLedgerProjectSummaries({
    directory: ledger.directory,
    scope,
    timeZone,
    ...tzSpec,
    zeroAtDate,
    dirtyRelPaths: dirtySnapshot,
  });
  if (!res) return null;
  consumeDirtyRelPathsForScope(ledger, dirtySnapshot, scope);
  scopeCache.filesByHash.clear();
  return res.files;
}

async function loadAllScopeFileSummariesJs(
  ledger: UsageLedger,
  scope: string,
  timeZone: string,
  zeroAtDate: string,
  scopeCache: ScopeTimeZoneCacheEntry,
  allFiles: ReadonlyArray<{ fileHash: string; filePath: string }>,
  sharedHashes: ReadonlySet<string>,
): Promise<LedgerProjectFileSummary[]> {
  const presentHashes = new Set<string>();
  for (const f of allFiles) presentHashes.add(f.fileHash);
  for (const oldHash of [...scopeCache.filesByHash.keys()]) {
    if (!presentHashes.has(oldHash)) {
      scopeCache.filesByHash.delete(oldHash);
    }
  }

  const eligible = allFiles.filter(({ fileHash }) => !sharedHashes.has(fileHash));
  const prefix = `${scope}/`;
  const dirtySnapshot = [...ledger.projectDirtyRelPaths].filter((rel) => rel.startsWith(prefix));
  const dirtyHashes = new Set(dirtySnapshot.map((rel) => rel.slice(prefix.length, -5)));
  let hadTransientError = false;

  const summaries = await mapPool(eligible, 16, async ({ fileHash, filePath }) => {
    let st: FileStatLike | null;
    try {
      st = await ledger._stat(filePath);
    } catch {
      hadTransientError = true;
      return null;
    }
    const stamp = formatStatStamp(st);
    if (!st || !stamp) {
      scopeCache.filesByHash.delete(fileHash);
      return null;
    }
    const isDirty = dirtyHashes.has(fileHash);
    const cached = scopeCache.filesByHash.get(fileHash);
    if (!isDirty && cached && cached.stamp === stamp) {
      return cached.summary;
    }
    const res = await readAndSummarizeLedgerFile(ledger, fileHash, filePath, st, timeZone, zeroAtDate);
    if (res.cacheable) {
      scopeCache.filesByHash.set(fileHash, { stamp, summary: res.summary });
    } else {
      scopeCache.filesByHash.delete(fileHash);
      if (!res.enoent) hadTransientError = true;
    }
    return res.summary;
  });

  if (!hadTransientError && eligible.length === allFiles.length) {
    consumeDirtyRelPathsForScope(ledger, dirtySnapshot, scope);
  } else if (!hadTransientError) {
    const eligibleHashes = new Set(eligible.map((f) => f.fileHash));
    for (const rel of dirtySnapshot) {
      const h = rel.slice(prefix.length, -5);
      if (eligibleHashes.has(h)) ledger.projectDirtyRelPaths.delete(rel);
    }
  }
  return summaries.filter((s): s is LedgerProjectFileSummary => s !== null);
}

async function loadCandidateFileSummariesJs(
  ledger: UsageLedger,
  scope: string,
  timeZone: string,
  zeroAtDate: string,
  scopeCache: ScopeTimeZoneCacheEntry,
  candidates: ReadonlyArray<{ fileHash: string; filePath: string }>,
): Promise<LedgerProjectFileSummary[]> {
  const prefix = `${scope}/`;
  const dirtySnapshot = [...ledger.projectDirtyRelPaths].filter((rel) => rel.startsWith(prefix));
  const dirtyHashes = new Set(dirtySnapshot.map((rel) => rel.slice(prefix.length, -5)));
  const consumedDirtyRels: string[] = [];

  const summaries = await mapPool(candidates, 16, async ({ fileHash, filePath }) => {
    let st: FileStatLike | null;
    try {
      st = await ledger._stat(filePath);
    } catch {
      return null;
    }
    const stamp = formatStatStamp(st);
    if (!st || !stamp) {
      scopeCache.filesByHash.delete(fileHash);
      if (dirtyHashes.has(fileHash)) consumedDirtyRels.push(`${prefix}${fileHash}.json`);
      return null;
    }
    const isDirty = dirtyHashes.has(fileHash);
    const cached = scopeCache.filesByHash.get(fileHash);
    if (!isDirty && cached && cached.stamp === stamp) {
      return cached.summary;
    }
    const res = await readAndSummarizeLedgerFile(ledger, fileHash, filePath, st, timeZone, zeroAtDate);
    if (res.cacheable) {
      scopeCache.filesByHash.set(fileHash, { stamp, summary: res.summary });
      if (isDirty) consumedDirtyRels.push(`${prefix}${fileHash}.json`);
    } else if (res.enoent) {
      scopeCache.filesByHash.delete(fileHash);
      if (isDirty) consumedDirtyRels.push(`${prefix}${fileHash}.json`);
    }
    return res.summary;
  });

  for (const rel of consumedDirtyRels) {
    ledger.projectDirtyRelPaths.delete(rel);
  }
  return summaries.filter((s): s is LedgerProjectFileSummary => s !== null);
}

function buildOwnerByHash(ownership: Record<string, string>): Map<string, string> {
  const ownerByHash = new Map<string, string>();
  for (const [convId, ownerScope] of Object.entries(ownership || {})) {
    if (convId && HASH_RE.test(ownerScope)) {
      ownerByHash.set(sha256(convId.toLowerCase()), ownerScope);
    }
  }
  return ownerByHash;
}

function buildPrimaryPicker(
  meta: Record<string, KnownAccountInfo>,
  knownAccounts: Record<string, KnownAccountInfo>,
): (scopesList: string[]) => string | null {
  const knownKeys = Object.keys(knownAccounts);
  const primaryRank = (s: string): number => {
    const m = meta[s];
    const k = knownAccounts[s];
    if (m?.primary === true || k?.primary === true) return 0;
    if (
      m?.primary === false ||
      k?.primary === false ||
      m?.secondary === true ||
      k?.secondary === true
    ) {
      return 2;
    }
    if (k && knownKeys.indexOf(s) > 0) return 2;
    return 1;
  };
  return (scopesList: string[]): string | null => {
    if (!scopesList.length) return null;
    return [...scopesList].sort((a, b) => {
      const ra = primaryRank(a);
      const rb = primaryRank(b);
      if (ra !== rb) return ra - rb;
      const ta = meta[a]?.addedAt ?? meta[a]?.createdAt ?? Number.MAX_SAFE_INTEGER;
      const tb = meta[b]?.addedAt ?? meta[b]?.createdAt ?? Number.MAX_SAFE_INTEGER;
      if (ta !== tb) return ta - tb;
      const ia = knownKeys.indexOf(a);
      const ib = knownKeys.indexOf(b);
      if (ia !== -1 && ib !== -1 && ia !== ib) return ia - ib;
      return a.localeCompare(b);
    })[0];
  };
}

async function readValidatedLedgerDoc(
  ledger: UsageLedger,
  scope: string,
  filePath: string,
): Promise<{ doc: LedgerDocument | null; transientError: boolean }> {
  let st: FileStatLike | null;
  try {
    st = await ledger._stat(filePath);
  } catch {
    return { doc: null, transientError: true };
  }
  if (!st || Number(st.size) > MAX_RECORD_FILE_BYTES) {
    return { doc: null, transientError: false };
  }
  try {
    const text = await ledger.fs.readFile(filePath, 'utf8');
    if (text.length > MAX_RECORD_FILE_BYTES) {
      return { doc: null, transientError: false };
    }
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { doc: null, transientError: false };
    }
    const doc = parsed as LedgerDocument;
    if (
      doc.schema !== 1 ||
      doc.account !== scope ||
      !Array.isArray(doc.records) ||
      !doc.records.every(validRow)
    ) {
      return { doc: null, transientError: false };
    }
    return { doc, transientError: false };
  } catch (err) {
    if (isErrno(err, 'ENOENT', 'ENOTDIR') || err instanceof SyntaxError) {
      return { doc: null, transientError: false };
    }
    return { doc: null, transientError: true };
  }
}

async function loadSharedFileSummariesJs(params: {
  ledger: UsageLedger;
  queryScope: string;
  targetSet: ReadonlySet<string>;
  scanScopes: readonly string[];
  scopesByHash: ReadonlyMap<string, readonly string[]>;
  targetHashes: ReadonlySet<string>;
  ownerByHash: ReadonlyMap<string, string>;
  meta: Record<string, KnownAccountInfo>;
  knownAccounts: Record<string, KnownAccountInfo>;
  timeZone: string;
  zeroAtDate: string;
}): Promise<LedgerProjectFileSummary[]> {
  const {
    ledger,
    queryScope,
    targetSet,
    scanScopes,
    scopesByHash,
    targetHashes,
    ownerByHash,
    meta,
    knownAccounts,
    timeZone,
    zeroAtDate,
  } = params;
  if (targetHashes.size === 0) return [];

  const sortedHashes = [...targetHashes].sort();
  const tasks: Array<{ scope: string; fileHash: string; filePath: string }> = [];
  for (const s of scanScopes) {
    for (const fileHash of sortedHashes) {
      if (scopesByHash.get(fileHash)?.includes(s)) {
        tasks.push({
          scope: s,
          fileHash,
          filePath: join(ledger.directory, s, `${fileHash}.json`),
        });
      }
    }
  }

  const readResults = await mapPool(tasks, 4, async (task) => {
    const res = await readValidatedLedgerDoc(ledger, task.scope, task.filePath);
    if (!res.transientError) {
      ledger.projectDirtyRelPaths.delete(`${task.scope}/${task.fileHash}.json`);
    }
    return { scope: task.scope, fileHash: task.fileHash, doc: res.doc };
  });

  const parsedDocs = readResults.filter(
    (item): item is { scope: string; fileHash: string; doc: LedgerDocument } => item.doc !== null,
  );
  if (parsedDocs.length === 0) return [];

  const recordScopes = new Map<string, string[]>();
  const docByScopeHash = new Map<string, LedgerDocument>();
  for (const { scope: s, fileHash, doc } of parsedDocs) {
    docByScopeHash.set(`${s}\0${fileHash}`, doc);
    for (const r of doc.records) {
      let list = recordScopes.get(r.id);
      if (!list) {
        list = [];
        recordScopes.set(r.id, list);
      }
      if (!list.includes(s)) list.push(s);
    }
  }

  const pickPrimary = buildPrimaryPicker(meta, knownAccounts);
  const seen = new Map<
    string,
    { record: UsageRecord; fileHash: string; doc: LedgerDocument; isLegacy: boolean }
  >();

  for (const { scope: s, fileHash, doc } of parsedDocs) {
    if (!targetSet.has(s)) continue;
    const explicitOwner = ownerByHash.get(fileHash);
    const fileMarkedLegacy = doc.metadata?.isLegacy === true || doc.isLegacy === true;
    for (const r of doc.records) {
      const scopesForRecord = recordScopes.get(r.id) || [s];
      const isDuplicate = scopesForRecord.length > 1;
      const resolvedOwner =
        explicitOwner && scopesForRecord.includes(explicitOwner) ? explicitOwner : null;
      if (queryScope !== 'all') {
        if (resolvedOwner) {
          if (resolvedOwner !== s) continue;
        } else if (isDuplicate && pickPrimary(scopesForRecord) !== s) {
          continue;
        }
      }
      const effectiveOwner = resolvedOwner || (isDuplicate ? null : s);
      const isLegacy = (!effectiveOwner && isDuplicate) || (!resolvedOwner && fileMarkedLegacy);
      const previous = seen.get(r.id);
      if (!previous || recordSum(r) > recordSum(previous.record)) {
        seen.set(r.id, {
          record: r,
          fileHash,
          doc,
          isLegacy: isLegacy || r.isLegacy === true,
        });
      } else if (
        previous &&
        recordSum(r) === recordSum(previous.record) &&
        effectiveOwner === s &&
        previous.isLegacy
      ) {
        seen.set(r.id, {
          record: r,
          fileHash,
          doc,
          isLegacy: false,
        });
      }
    }
  }

  const byHash = new Map<string, { records: UsageRecord[]; docs: LedgerDocument[] }>();
  for (const entry of seen.values()) {
    let group = byHash.get(entry.fileHash);
    if (!group) {
      group = { records: [], docs: [] };
      byHash.set(entry.fileHash, group);
    }
    group.records.push(entry.record);
    if (!group.docs.includes(entry.doc)) group.docs.push(entry.doc);
  }

  const summaries: LedgerProjectFileSummary[] = [];
  for (const [fileHash, group] of byHash) {
    const explicitOwner = ownerByHash.get(fileHash);
    const ownerDoc = explicitOwner ? docByScopeHash.get(`${explicitOwner}\0${fileHash}`) : undefined;
    const metaDocs = ownerDoc ? [ownerDoc, ...group.docs] : group.docs;
    let docId = '';
    let source = '';
    let projectName = '';
    let note = '';
    for (const d of metaDocs) {
      if (!docId && typeof d.id === 'string' && d.id) docId = d.id;
      if (!source && typeof d.metadata?.source === 'string' && d.metadata.source) {
        source = d.metadata.source;
      }
      if (!projectName && typeof d.metadata?.projectName === 'string' && d.metadata.projectName) {
        projectName = d.metadata.projectName;
      }
      if (!note && typeof d.metadata?.note === 'string' && d.metadata.note) {
        note = d.metadata.note;
      }
    }
    summaries.push(
      summarizeLedgerDoc(
        fileHash,
        {
          schema: 1,
          account: '',
          ...(docId ? { id: docId } : {}),
          metadata: { source, projectName, note },
          records: group.records,
        },
        timeZone,
        zeroAtDate,
      ),
    );
  }
  return summaries;
}

function tryReadNativeSharedSummaries(params: {
  ledger: UsageLedger;
  queryScope: string;
  scanScopes: readonly string[];
  scopesByHash: ReadonlyMap<string, readonly string[]>;
  targetHashes: ReadonlySet<string>;
  timeZone: string;
  zeroAtDate: string;
}): LedgerProjectFileSummary[] | null {
  const { ledger, queryScope, scanScopes, scopesByHash, targetHashes, timeZone, zeroAtDate } = params;
  if (ledger.hasCustomFs || !isNativeAccelAvailable()) return null;
  if (targetHashes.size === 0) return [];
  const sortedHashes = [...targetHashes].sort();
  const dirtySnapshot = [...ledger.projectDirtyRelPaths];
  const tzSpec = resolveTimeZoneSpec(timeZone, Date.now());
  const res = readLedgerSharedProjectSummaries({
    directory: ledger.directory,
    scope: queryScope,
    timeZone,
    ...tzSpec,
    zeroAtDate,
    knownAccounts: ledger.knownAccounts || {},
    fallbackScope: ledger.scope ?? null,
    targetHashes: sortedHashes,
    dirtyRelPaths: dirtySnapshot,
  });
  if (!res) return null;
  if (dirtySnapshot.length > 0) {
    const dirtySet = new Set(dirtySnapshot);
    for (const s of scanScopes) {
      for (const fileHash of sortedHashes) {
        if (scopesByHash.get(fileHash)?.includes(s)) {
          const rel = `${s}/${fileHash}.json`;
          if (dirtySet.has(rel)) {
            ledger.projectDirtyRelPaths.delete(rel);
          }
        }
      }
    }
  }
  return res.files;
}

async function loadSharedFileSummaries(params: {
  ledger: UsageLedger;
  queryScope: string;
  targetSet: ReadonlySet<string>;
  scanScopes: readonly string[];
  scopesByHash: ReadonlyMap<string, readonly string[]>;
  targetHashes: ReadonlySet<string>;
  ownerByHash: ReadonlyMap<string, string>;
  timeZone: string;
  zeroAtDate: string;
}): Promise<LedgerProjectFileSummary[]> {
  const nativeShared = tryReadNativeSharedSummaries({
    ledger: params.ledger,
    queryScope: params.queryScope,
    scanScopes: params.scanScopes,
    scopesByHash: params.scopesByHash,
    targetHashes: params.targetHashes,
    timeZone: params.timeZone,
    zeroAtDate: params.zeroAtDate,
  });
  if (nativeShared) return nativeShared;
  const accountsMeta = await params.ledger.accountsMeta().catch(() => ({}));
  return await loadSharedFileSummariesJs({
    ...params,
    meta: accountsMeta,
    knownAccounts: params.ledger.knownAccounts || {},
  });
}

function resolveProjectForSummary(
  resolver: ReturnType<typeof buildProjectResolver>,
  cid: string,
  file: LedgerProjectFileSummary,
): ResolvedProject {
  if (file.source === 'remote-manual') {
    const name = cleanText(file.projectName) || 'remote';
    return { projectKey: `remote:${name.toLowerCase()}`, name, kind: 'remote' };
  }
  return resolver.resolve(cid);
}

async function listScopeLedgerFiles(
  ledger: UsageLedger,
  scope: string,
): Promise<Array<{ fileHash: string; filePath: string }>> {
  const scopeDir = join(ledger.directory, scope);
  try {
    const entries = (await ledger.fs.readdir(scopeDir, { withFileTypes: true })) as DirentLike[];
    const out: Array<{ fileHash: string; filePath: string }> = [];
    for (const ent of entries) {
      if (!ent?.name || !LEDGER_FILE_RE.test(ent.name)) continue;
      if (typeof ent.isFile === 'function' && !ent.isFile()) continue;
      out.push({
        fileHash: ent.name.slice(0, -5),
        filePath: join(scopeDir, ent.name),
      });
    }
    return out;
  } catch (err) {
    if (isErrno(err, 'ENOENT', 'ENOTDIR')) return [];
    throw err;
  }
}

async function buildScopeFilePlan(
  ledger: UsageLedger,
  scope: string,
  ownerByHash: ReadonlyMap<string, string>,
): Promise<{
  targetScopes: string[];
  targetSet: Set<string>;
  scanScopes: string[];
  filesByScope: Map<string, Array<{ fileHash: string; filePath: string }>>;
  scopesByHash: Map<string, string[]>;
  sharedHashes: Set<string>;
}> {
  const allScopes = await ledger.scopeDirectories();
  const targetScopes =
    scope === 'all'
      ? allScopes.length
        ? allScopes
        : ledger.scope && HASH_RE.test(ledger.scope)
          ? [ledger.scope]
          : []
      : [scope];
  const targetSet = new Set(targetScopes);
  const scanScopes =
    allScopes.length > 1 ? [...new Set([...allScopes, ...targetScopes])] : targetScopes;

  const listedEntries = await mapPool(scanScopes, 8, async (s) => ({
    scope: s,
    files: await listScopeLedgerFiles(ledger, s),
  }));
  const filesByScope = new Map<string, Array<{ fileHash: string; filePath: string }>>();
  const scopesByHash = new Map<string, string[]>();
  for (const { scope: s, files } of listedEntries) {
    filesByScope.set(s, files);
    for (const f of files) {
      let list = scopesByHash.get(f.fileHash);
      if (!list) {
        list = [];
        scopesByHash.set(f.fileHash, list);
      }
      list.push(s);
    }
  }

  const sharedHashes = new Set<string>();
  for (const [fileHash, scopesWithFile] of scopesByHash) {
    const explicitOwner = ownerByHash.get(fileHash);
    if (
      scopesWithFile.length > 1 ||
      (explicitOwner !== undefined && scopesWithFile.some((s) => s !== explicitOwner))
    ) {
      sharedHashes.add(fileHash);
    }
  }

  return { targetScopes, targetSet, scanScopes, filesByScope, scopesByHash, sharedHashes };
}

function isValidScope(scope: string | null | undefined): scope is string {
  return Boolean(scope && (scope === 'all' || HASH_RE.test(scope)));
}

function resolveRange(opts: ProjectUsageQueryOptions): { from: string; to: string; timeZone: string } {
  const timeZone = opts.timeZone || opts.ledger.timeZone || 'Asia/Shanghai';
  const today = dateTimeParts(Date.now(), timeZone).date;
  const from = typeof opts.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(opts.from) ? opts.from : '';
  const to = typeof opts.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(opts.to) ? opts.to : from || today;
  return { from: from || to, to: from ? to : today, timeZone };
}

function inDateRange(date: string, from: string, to: string, hasExplicitRange: boolean): boolean {
  if (!hasExplicitRange) return true;
  return date >= from && date <= to;
}

function resolveScope(opts: ProjectUsageQueryOptions): string | null {
  if (opts.scope !== undefined && opts.scope !== null) return opts.scope;
  const id = opts.store?.identity;
  if (typeof id === 'string') return id;
  if (id && typeof id === 'object' && id.accountScope) return id.accountScope;
  return opts.ledger.scope ?? null;
}

/**
 * Queries Level-1 per-project usage aggregated across the requested account
 * scope (`'all'` or 64-hex account hash) within `[from, to]`.
 */
export async function queryProjectUsageOverview(
  opts: ProjectUsageQueryOptions,
): Promise<ProjectUsageOverview> {
  const scope = resolveScope(opts);
  const { from, to, timeZone } = resolveRange(opts);
  const hasExplicitRange = Boolean(
    (typeof opts.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(opts.from)) ||
      (typeof opts.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(opts.to)),
  );
  const updatedAt = new Date().toISOString();

  if (!isValidScope(scope)) {
    return { accountKey: '', from, to, projects: [], days: [], totalTokens: 0, requests: 0, updatedAt };
  }

  const cache = getProjectStatsCache(opts.ledger);
  const dbPath = opts.profileDir ? join(opts.profileDir, 'conversation_summaries.db') : null;
  const rawSummaries = opts.store?.rawSummaries;

  const [summaryMetaState, ownership] = await Promise.all([
    getSummaryMetaState(cache, opts.ledger, dbPath, rawSummaries, opts.readSummaries),
    opts.ledger.ownership().catch(() => ({}) as Record<string, string>),
  ]);
  const { cidByHash, resolver } = summaryMetaState;
  const ownerByHash = buildOwnerByHash(ownership);
  const plan = await buildScopeFilePlan(opts.ledger, scope, ownerByHash);

  if (plan.targetScopes.length === 0) {
    return { accountKey: scope, from, to, projects: [], days: [], totalTokens: 0, requests: 0, updatedAt };
  }

  const zeroAtDate = dateTimeParts(0, timeZone).date;
  const fileSummaries: LedgerProjectFileSummary[] = [];
  const targetSharedHashes = new Set<string>();

  for (const s of plan.targetScopes) {
    const scopeFiles = plan.filesByScope.get(s) || [];
    for (const f of scopeFiles) {
      if (plan.sharedHashes.has(f.fileHash)) {
        targetSharedHashes.add(f.fileHash);
      }
    }
    const scopeCache = getScopeTimeZoneCache(cache, s, timeZone);
    const nativeSummaries = tryReadNativeScopeSummaries(
      opts.ledger,
      s,
      timeZone,
      zeroAtDate,
      scopeCache,
    );
    if (nativeSummaries) {
      for (const file of nativeSummaries) {
        if (!plan.sharedHashes.has(file.fileHash)) {
          fileSummaries.push(file);
        }
      }
    } else {
      const jsSummaries = await loadAllScopeFileSummariesJs(
        opts.ledger,
        s,
        timeZone,
        zeroAtDate,
        scopeCache,
        scopeFiles,
        plan.sharedHashes,
      );
      fileSummaries.push(...jsSummaries);
    }
  }

  if (targetSharedHashes.size > 0) {
    const sharedSummaries = await loadSharedFileSummaries({
      ledger: opts.ledger,
      queryScope: scope,
      targetSet: plan.targetSet,
      scanScopes: plan.scanScopes,
      scopesByHash: plan.scopesByHash,
      targetHashes: targetSharedHashes,
      ownerByHash,
      timeZone,
      zeroAtDate,
    });
    fileSummaries.push(...sharedSummaries);
  }

  const projectMap = new Map<string, ProjectUsageItem & { cids: Set<string> }>();
  const dayMap = new Map<string, Record<string, UsageBucketCounts>>();
  let grandTotal = 0;
  let grandRequests = 0;

  for (const file of fileSummaries) {
    const cid = file.docId || cidByHash.get(file.fileHash) || file.fileHash;
    const proj = resolveProjectForSummary(resolver, cid, file);
    let matchedInFile = false;
    for (const day of file.days) {
      if (!inDateRange(day.date, from, to, hasExplicitRange)) continue;
      matchedInFile = true;

      let pEntry = projectMap.get(proj.projectKey);
      if (!pEntry) {
        pEntry = {
          projectKey: proj.projectKey,
          name: proj.name,
          kind: proj.kind,
          ...(proj.workspacePath ? { workspacePath: proj.workspacePath } : {}),
          conversationCount: 0,
          ...emptyBucket(),
          cids: new Set<string>(),
        };
        projectMap.set(proj.projectKey, pEntry);
      }
      addDayBucket(pEntry, day);

      let dayProjects = dayMap.get(day.date);
      if (!dayProjects) {
        dayProjects = {};
        dayMap.set(day.date, dayProjects);
      }
      const dayBucket = dayProjects[proj.projectKey] || (dayProjects[proj.projectKey] = emptyBucket());
      addDayBucket(dayBucket, day);

      grandTotal += day.uncached + day.cacheRead + day.cacheWrite + day.output;
      grandRequests += day.requests;
    }

    if (matchedInFile) {
      const pEntry = projectMap.get(proj.projectKey);
      if (pEntry) pEntry.cids.add(cid.toLowerCase());
    }
  }

  const projects: ProjectUsageItem[] = Array.from(projectMap.values())
    .filter((p) => p.total > 0 || p.requests > 0)
    .map(({ cids, ...rest }) => ({ ...rest, conversationCount: cids.size }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));

  const days: ProjectUsageDayBucket[] = Array.from(dayMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, projectsByDate]) => ({ date, projects: projectsByDate }));

  return {
    accountKey: scope,
    from,
    to,
    projects,
    days,
    totalTokens: grandTotal,
    requests: grandRequests,
    updatedAt,
  };
}

/**
 * Queries Level-2 per-conversation breakdown on demand for a single selected
 * `projectKey` under the requested account scope (`'all'` or 64-hex account hash).
 */
export async function queryProjectConversationDetail(
  opts: ProjectDetailQueryOptions,
): Promise<ProjectConversationDetail> {
  const scope = resolveScope(opts);
  const { from, to, timeZone } = resolveRange(opts);
  const hasExplicitRange = Boolean(
    (typeof opts.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(opts.from)) ||
      (typeof opts.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(opts.to)),
  );
  const updatedAt = new Date().toISOString();
  const targetKey = opts.projectKey || 'conversations';

  const emptyDetail = (
    accountKey: string,
    name = targetKey,
    kind: ProjectKind = 'project',
  ): ProjectConversationDetail => ({
    accountKey,
    projectKey: targetKey,
    projectName: name,
    kind,
    from,
    to,
    totalTokens: 0,
    requests: 0,
    conversations: [],
    updatedAt,
  });

  if (!isValidScope(scope)) return emptyDetail('');

  const cache = getProjectStatsCache(opts.ledger);
  const dbPath = opts.profileDir ? join(opts.profileDir, 'conversation_summaries.db') : null;
  const rawSummaries = opts.store?.rawSummaries;

  const [summaryMetaState, ownership] = await Promise.all([
    getSummaryMetaState(cache, opts.ledger, dbPath, rawSummaries, opts.readSummaries),
    opts.ledger.ownership().catch(() => ({}) as Record<string, string>),
  ]);
  const { metaByCid, cidByHash, resolver } = summaryMetaState;
  const ownerByHash = buildOwnerByHash(ownership);
  const plan = await buildScopeFilePlan(opts.ledger, scope, ownerByHash);

  let projectName = targetKey;
  let projectKind: ProjectKind =
    targetKey === 'conversations' ? 'conversations' : targetKey === 'cli' ? 'cli' : 'project';

  const candidateHashSet = new Set<string>();
  const excludedHashes = new Set<string>();
  for (const meta of metaByCid.values()) {
    if (!meta.cid) continue;
    const resolved = resolver.resolve(meta.cid);
    const lowerHash = sha256(meta.cid.toLowerCase());
    const altHash = sha256(meta.cid);
    if (resolved.projectKey !== targetKey) {
      excludedHashes.add(lowerHash);
      excludedHashes.add(altHash);
      continue;
    }
    projectName = resolved.name;
    projectKind = resolved.kind;
    candidateHashSet.add(lowerHash);
    candidateHashSet.add(altHash);
  }

  if (plan.targetScopes.length === 0) {
    return emptyDetail(scope, projectName, projectKind);
  }

  const includeUnindexed = targetKey.startsWith('remote:') || targetKey === 'conversations';
  const zeroAtDate = dateTimeParts(0, timeZone).date;
  const fileSummaries: LedgerProjectFileSummary[] = [];
  const targetSharedHashes = new Set<string>();

  for (const s of plan.targetScopes) {
    const scopeFiles = plan.filesByScope.get(s) || [];
    for (const f of scopeFiles) {
      if (!plan.sharedHashes.has(f.fileHash)) continue;
      if (excludedHashes.has(f.fileHash)) continue;
      if (candidateHashSet.has(f.fileHash) || includeUnindexed) {
        targetSharedHashes.add(f.fileHash);
      }
    }

    const scopeCache = getScopeTimeZoneCache(cache, s, timeZone);
    const nativeSummaries = tryReadNativeScopeSummaries(
      opts.ledger,
      s,
      timeZone,
      zeroAtDate,
      scopeCache,
    );
    if (nativeSummaries) {
      for (const file of nativeSummaries) {
        if (!plan.sharedHashes.has(file.fileHash)) {
          fileSummaries.push(file);
        }
      }
    } else {
      const candidateFiles: Array<{ fileHash: string; filePath: string }> = [];
      for (const f of scopeFiles) {
        if (plan.sharedHashes.has(f.fileHash) || excludedHashes.has(f.fileHash)) continue;
        if (candidateHashSet.has(f.fileHash) || includeUnindexed) {
          candidateFiles.push(f);
        }
      }
      const jsSummaries = await loadCandidateFileSummariesJs(
        opts.ledger,
        s,
        timeZone,
        zeroAtDate,
        scopeCache,
        candidateFiles,
      );
      fileSummaries.push(...jsSummaries);
    }
  }

  if (targetSharedHashes.size > 0) {
    const sharedSummaries = await loadSharedFileSummaries({
      ledger: opts.ledger,
      queryScope: scope,
      targetSet: plan.targetSet,
      scanScopes: plan.scanScopes,
      scopesByHash: plan.scopesByHash,
      targetHashes: targetSharedHashes,
      ownerByHash,
      timeZone,
      zeroAtDate,
    });
    fileSummaries.push(...sharedSummaries);
  }

  const items: ProjectConversationItem[] = [];
  let grandTotal = 0;
  let grandRequests = 0;

  for (const file of fileSummaries) {
    const cid = file.docId || cidByHash.get(file.fileHash) || file.fileHash;
    const resolved = resolveProjectForSummary(resolver, cid, file);
    if (resolved.projectKey !== targetKey) continue;
    projectName = resolved.name;
    projectKind = resolved.kind;

    const bucket = emptyBucket();
    let maxAt = 0;
    for (const day of file.days) {
      if (!inDateRange(day.date, from, to, hasExplicitRange)) continue;
      addDayBucket(bucket, day);
      if (day.maxAt > maxAt) maxAt = day.maxAt;
    }
    if (bucket.total === 0 && bucket.requests === 0) continue;

    const meta = metaByCid.get(cid.toLowerCase());
    const { rootId, rootTitle } = resolveRootAncestor(cid, metaByCid);
    items.push({
      id: cid,
      title: resolveConversationTitle(cid, metaByCid, file),
      ...bucket,
      share: 0,
      lastActiveAt: maxAt > 0 ? new Date(maxAt).toISOString() : null,
      isSubagent: Boolean(meta?.parentConversationId),
      isRemote: cid.includes('/') || file.source === 'remote-manual',
      parentId: meta?.parentConversationId || null,
      rootId,
      rootTitle,
      agentName: meta?.agentName || null,
    });
    grandTotal += bucket.total;
    grandRequests += bucket.requests;
  }

  items.sort((a, b) => b.total - a.total || a.title.localeCompare(b.title));
  if (grandTotal > 0) {
    for (const item of items) item.share = item.total / grandTotal;
  }

  return {
    accountKey: scope,
    projectKey: targetKey,
    projectName,
    kind: projectKind,
    from,
    to,
    totalTokens: grandTotal,
    requests: grandRequests,
    conversations: items,
    updatedAt,
  };
}
