import { readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { UsageRecord } from '../../contracts/usage.ts';
import { atomicWriteFile, formatStatStamp, type FileStatLike } from '../../shared/atomic-fs.ts';
import { isNativeAccelAvailable } from '../../platform/native-bridge.ts';
import { platformPaths } from '../../platform/paths.ts';
import { isErrno, sha256, uniqueRecordIds, validRow } from './helpers.ts';
import {
  GUID_RE,
  HASH_RE,
  MAX_LEDGER_JSON_BYTES,
  RECORD_KEYS,
  type BackfillEntry,
  type BackfillHost,
  type DirentLike,
  type FileIndexEntry,
  type KnownAccountInfo,
  type LedgerDocument,
  type LedgerFsOverrides,
  type StampCache,
  type SummaryCacheEntry,
  type UsageLedgerOptions,
} from './types.ts';

/**
 * Loads known account metadata from `.data/usage-accounts.local.json` (or `file`),
 * returning `{}` if missing, unreadable, or malformed.
 */
export function loadKnownAccounts(
  file: string = fileURLToPath(new URL('../../.data/usage-accounts.local.json', import.meta.url)),
): Record<string, KnownAccountInfo> {
  try {
    const val = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!val || typeof val !== 'object' || Array.isArray(val)) return {};
    const obj = val as Record<string, unknown>;
    const raw =
      obj.accounts && typeof obj.accounts === 'object' && !Array.isArray(obj.accounts)
        ? (obj.accounts as Record<string, unknown>)
        : obj;
    return Object.fromEntries(
      Object.entries(raw).filter(
        ([k, v]) => HASH_RE.test(k) && Boolean(v) && typeof v === 'object' && !Array.isArray(v),
      ),
    ) as Record<string, KnownAccountInfo>;
  } catch {
    return {};
  }
}

export const KNOWN_ACCOUNTS: Record<string, KnownAccountInfo> = loadKnownAccounts();

export class LedgerStorage {
  readonly directory: string;
  timeZone: string;
  readonly source: string;
  readonly knownAccounts: Record<string, KnownAccountInfo>;
  readonly fs: Required<LedgerFsOverrides>;
  readonly hasCustomFs: boolean;
  scope?: string | null;

  writeQueue: Promise<unknown> = Promise.resolve();
  revision = 0;
  lastUsageActivityAt = 0;
  cache: SummaryCacheEntry | null = null;
  fileIndex = new Map<string, Map<string, FileIndexEntry>>();
  dirtyRelPaths = new Set<string>();
  projectDirtyRelPaths = new Set<string>();
  keyVersions = new Map<string, number>();
  metaCache: StampCache<Record<string, KnownAccountInfo>> | null = null;
  metaVersion = 0;
  ownershipCache: StampCache<Record<string, string>> | null = null;
  ownershipVersion = 0;

  constructor(
    directory: string = join(platformPaths().data, 'usage-v1'),
    { timeZone = 'Asia/Shanghai', source = 'desktop-local', knownAccounts = KNOWN_ACCOUNTS, fs = null }: UsageLedgerOptions = {},
  ) {
    this.directory = directory;
    this.timeZone = timeZone;
    this.source = source;
    this.knownAccounts = knownAccounts && typeof knownAccounts === 'object' ? knownAccounts : {};
    this.hasCustomFs = Boolean(fs);
    this.fs = {
      readFile: readFile as Required<LedgerFsOverrides>['readFile'],
      writeFile: writeFile as Required<LedgerFsOverrides>['writeFile'],
      mkdir: mkdir as Required<LedgerFsOverrides>['mkdir'],
      rename,
      readdir: readdir as Required<LedgerFsOverrides>['readdir'],
      unlink,
      stat: stat as Required<LedgerFsOverrides>['stat'],
      ...(fs || {}),
    };
  }

  get queue(): Promise<unknown> {
    return this.writeQueue;
  }

  touchUsageActivity(now: number = Date.now()): void {
    if (now > this.lastUsageActivityAt) this.lastUsageActivityAt = now;
  }

  enqueueWrite<T>(fn: () => Promise<T>): Promise<T> {
    this.touchUsageActivity();
    const run = () => fn();
    const pending = this.writeQueue.then(run, run);
    this.writeQueue = pending.catch(() => {});
    return pending;
  }

  async _stat(file: string): Promise<FileStatLike | null> {
    try {
      return await this.fs.stat(file, { bigint: true });
    } catch (error) {
      if (isErrno(error, 'ENOENT', 'ENOTDIR')) return null;
      if (error instanceof TypeError) {
        try {
          return await this.fs.stat(file);
        } catch (retryError) {
          if (isErrno(retryError, 'ENOENT', 'ENOTDIR')) return null;
          throw retryError;
        }
      }
      throw error;
    }
  }

  async _atomicWrite(_dir: string, file: string, data: string): Promise<void> {
    await atomicWriteFile(file, data, { fs: this.fs, mode: 0o600 });
  }

  _markDirtyRelPath(scope: string, name: string): void {
    const rel = `${scope}/${name}`;
    this.dirtyRelPaths.add(rel);
    this.projectDirtyRelPaths.add(rel);
    this.touchUsageActivity();
  }

  _bumpKeyVersion(scope: string, name: string): void {
    const key = `${scope}/${name}`;
    this.keyVersions.set(key, (this.keyVersions.get(key) || 0) + 1);
    this.touchUsageActivity();
  }

  async _setFileIndexFromWrite(scope: string, name: string, file: string, record: LedgerDocument): Promise<void> {
    this._bumpKeyVersion(scope, name);
    this._markDirtyRelPath(scope, name);
    if (this.hasCustomFs || !isNativeAccelAvailable()) {
      let st: FileStatLike | null = null;
      try {
        st = await this._stat(file);
      } catch {
        // Ignore stat errors after successful atomic rename.
      }
      let scopeMap = this.fileIndex.get(scope);
      if (!scopeMap) {
        scopeMap = new Map<string, FileIndexEntry>();
        this.fileIndex.set(scope, scopeMap);
      }
      const stamp = formatStatStamp(st);
      if (stamp) scopeMap.set(name, { stamp, unreadable: false, record, recordIds: uniqueRecordIds(record.records) });
      else scopeMap.delete(name);
    }
    this.revision++;
    this.cache = null;
  }

  file(scope: string, id: string): string {
    if (!HASH_RE.test(scope) || !GUID_RE.test(id)) throw Error('Invalid usage scope');
    return join(this.directory, scope, `${sha256(id.toLowerCase())}.json`);
  }

  ownershipFile(): string {
    return join(this.directory, 'ownership-v1.json');
  }

  accountsFile(): string {
    return join(this.directory, 'accounts-v1.json');
  }

  projectMetaFile(): string {
    return join(this.directory, 'project-meta-v1.json');
  }

  async backfillState(scope: string, host: BackfillHost): Promise<Record<string, BackfillEntry>> {
    if (!HASH_RE.test(scope) || !['app', 'ide'].includes(host)) throw Error('Invalid backfill scope');
    try {
      const content = await this.fs.readFile(join(this.directory, scope, 'backfill-v1.json'), 'utf8');
      if (content.length > MAX_LEDGER_JSON_BYTES) return {};
      const value = JSON.parse(content) as Record<string, unknown>;
      if (value.schema !== 1 || value.account !== scope || value.host !== host || !value.entries || typeof value.entries !== 'object' || Array.isArray(value.entries)) {
        return {};
      }
      return Object.fromEntries(
        Object.entries(value.entries as Record<string, unknown>).filter(([id, e]) => {
          if (!HASH_RE.test(id) || !e || typeof e !== 'object') return false;
          const entry = e as Record<string, unknown>;
          return (
            typeof entry.signature === 'string' &&
            HASH_RE.test(entry.signature) &&
            (entry.state === 'complete' || entry.state === 'retry') &&
            typeof entry.failures === 'number' &&
            Number.isSafeInteger(entry.failures) &&
            entry.failures >= 0 &&
            typeof entry.retryAt === 'number' &&
            Number.isSafeInteger(entry.retryAt) &&
            entry.retryAt >= 0
          );
        }),
      ) as Record<string, BackfillEntry>;
    } catch (error) {
      if (isErrno(error, 'ENOENT') || error instanceof SyntaxError) return {};
      throw error;
    }
  }

  saveBackfillState(scope: string, host: BackfillHost, entries: Record<string, BackfillEntry>): Promise<void> {
    if (!HASH_RE.test(scope) || !['app', 'ide'].includes(host)) throw Error('Invalid backfill scope');
    const dir = join(this.directory, scope);
    const file = join(dir, 'backfill-v1.json');
    return this.enqueueWrite(() => this._atomicWrite(dir, file, JSON.stringify({ schema: 1, account: scope, host, entries })));
  }

  async _loadStampCachedJson<T extends Record<string, unknown>>(
    file: string,
    getCache: () => StampCache<T> | null,
    setCache: (next: StampCache<T>) => void,
    getVersion: () => number,
    extract: (parsed: Record<string, unknown>) => T,
  ): Promise<{ stamp: string; value: T }> {
    const ver = getVersion();
    const st = await this._stat(file);
    const stamp = formatStatStamp(st) ?? 'ENOENT';
    const cached = getCache();
    if (cached && cached.stamp === stamp) return { stamp, value: { ...cached.value } };
    let value = {} as T;
    if (st) {
      try {
        const content = await this.fs.readFile(file, 'utf8');
        if (content.length <= MAX_LEDGER_JSON_BYTES) {
          const parsed = JSON.parse(content) as unknown;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) value = extract(parsed as Record<string, unknown>);
        }
      } catch (error) {
        if (!isErrno(error, 'ENOENT') && !(error instanceof SyntaxError)) throw error;
      }
    }
    if (getVersion() === ver) setCache({ stamp, value });
    return { stamp, value: { ...value } };
  }

  async scopeDirectories(): Promise<string[]> {
    const scopes: string[] = [];
    try {
      const entries = (await this.fs.readdir(this.directory, { withFileTypes: true })) as DirentLike[];
      for (const entry of entries) if (entry.isDirectory() && HASH_RE.test(entry.name)) scopes.push(entry.name);
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error;
    }
    scopes.sort();
    return scopes;
  }

  ingestRows(scope: string, id: string, rows: readonly UsageRecord[]): Promise<void> {
    if (!scope) return Promise.resolve();
    const file = this.file(scope, id);
    const fileName = basename(file);
    return this.enqueueWrite(async () => {
      let previous: LedgerDocument | undefined;
      try {
        previous = JSON.parse(await this.fs.readFile(file, 'utf8')) as LedgerDocument;
      } catch (error) {
        if (!isErrno(error, 'ENOENT')) throw Error('Usage ledger cannot be read');
      }
      if (previous && (previous.schema !== 1 || previous.account !== scope || !Array.isArray(previous.records) || !previous.records.every(validRow))) {
        throw Error('Invalid usage ledger');
      }
      const merged = new Map<string, UsageRecord>((previous?.records || []).map((r) => [r.id, r]));
      for (const row of rows) {
        const old = merged.get(row.id);
        const record: UsageRecord = {
          ...row,
          at: row.at ?? old?.at ?? null,
          timeBasis: row.at === null && old?.at !== null && old?.at !== undefined ? old.timeBasis : row.timeBasis,
        };
        for (const key of RECORD_KEYS) record[key] = row[key] ?? old?.[key] ?? null;
        merged.set(row.id, record);
      }
      const records = [...merged.values()].sort((a, b) => a.id.localeCompare(b.id));
      if (previous && JSON.stringify(previous.records) === JSON.stringify(records)) return;
      const nextDoc: LedgerDocument = { schema: 1, account: scope, records };
      this._markDirtyRelPath(scope, fileName);
      await this._atomicWrite(join(this.directory, scope), file, JSON.stringify(nextDoc));
      await this._setFileIndexFromWrite(scope, fileName, file, nextDoc);
    });
  }
}
