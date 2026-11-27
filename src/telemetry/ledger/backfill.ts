import { setImmediate as yieldToLiveRequests } from 'node:timers/promises';
import type { UsageTotalsSnapshot } from '../../contracts/metrics.ts';
import type {
  DesktopUsageSyncStatus,
  ManualUsageInput,
  ManualUsageRecord,
  UsageSummarySnapshot,
} from '../../contracts/usage.ts';
import type { SessionDescriptorInput } from '../../platform/native-bridge.ts';
import { discoverLocalConversations, type DiscoverLocalConversationsResult } from '../reader/local-conversations.ts';
import { diffSessionSnapshotsWithFallback, parseSummaryMtimeMs } from '../snapshot-diff.ts';
import {
  buildRetryEntry,
  buildSyncCandidates,
  candidateMark,
  candidateSignature,
  ingestConversationUsage,
  syncOneCandidate,
  type CandidateConversation,
  type DesktopUsageOptions,
  type DesktopUsageStore,
  type ListedConversationSummary,
  type RunSyncResult,
  type UnrefableTimer,
} from './backfill-sync.ts';
import { sha256 } from './helpers.ts';
import { persistProjectMetaFromRawSummaries } from './project-stats.ts';
import { UsageLedger } from './summary.ts';
import { dateKey } from './timezone.ts';
import { HASH_RE, type BackfillEntry, type BackfillHost, type UsageAccountsResult } from './types.ts';

export type {
  CandidateConversation,
  DesktopUsageOptions,
  DesktopUsageStore,
  ListedConversationSummary,
} from './backfill-sync.ts';

interface SnapshotDiffCacheEntry {
  fingerprint: string;
  settled: boolean;
  signature: string | undefined;
  rawModifiedAt: string | undefined;
  synced: boolean;
}

export class DesktopUsage {
  readonly store: DesktopUsageStore;
  readonly ledger: UsageLedger;
  readonly fingerprints = new Map<string, string>();
  readonly snapshotStates = new Map<string, SnapshotDiffCacheEntry>();
  readonly host: BackfillHost | null;
  readonly conversationsDir: string | null;
  readonly owns: () => boolean;
  now: () => number;
  readonly discoverLocal: () => Promise<DiscoverLocalConversationsResult>;
  readonly sliceMs: number;
  readonly continueDelay: number;
  fullRemaining = new Set<string>();
  readonly passSeen = new Set<string>();
  readonly passFailures = new Set<string>();
  readonly readFailures = new Map<string, number>();

  syncing = false;
  lastSync = 0;
  status: DesktopUsageSyncStatus = 'waiting';
  missingConversations = 0;
  confirmedMissingConversations = 0;
  retryingConversations = 0;
  scope: string | null = null;
  scopeEpoch: number | null = null;
  viewScope = 'all';
  forceQueued = false;
  disposed = false;
  continuation: ReturnType<typeof setTimeout> | null = null;
  pending: Promise<void> | null = null;
  lastPersistedRawSummaries: Record<string, unknown> | null = null;
  totalsCache: {
    revision: number;
    today: string;
    scope: string;
    timeZone: string;
    value: UsageTotalsSnapshot;
  } | null = null;

  constructor(
    store: DesktopUsageStore,
    ledger: UsageLedger = new UsageLedger(),
    {
      host = null,
      conversationsDir = null,
      discoverLocal = null,
      owns = () => true,
      now = Date.now,
      sliceMs = 3000,
      continueDelay = 250,
    }: DesktopUsageOptions = {},
  ) {
    this.store = store;
    this.ledger = ledger;
    this.host = host;
    this.conversationsDir = conversationsDir;
    this.owns = owns;
    this.now = now;
    this.discoverLocal =
      discoverLocal ||
      (() => (host ? discoverLocalConversations({ host }) : Promise.resolve({ conversations: [], errors: 0 })));
    this.sliceMs = sliceMs;
    this.continueDelay = continueDelay;
  }

  async ingest(scope: string | null | undefined, id: string | null | undefined, raw: unknown): Promise<void> {
    if (!scope || !id) return;
    await ingestConversationUsage({ scope, id, raw, ledger: this.ledger, now: this.now });
  }

  sync(forceFull = false): Promise<void> {
    if (this.disposed || !this.owns()) return Promise.resolve();
    if (forceFull) this.forceQueued = true;
    if (this.pending) return this.pending;
    if (!this.continuation) {
      this.passSeen.clear();
      this.passFailures.clear();
    }
    if (this.continuation !== null) clearTimeout(this.continuation);
    this.continuation = null;
    this.syncing = true;
    this.status = 'syncing';
    this.pending = (async () => {
      let result: RunSyncResult;
      do {
        const force = this.forceQueued;
        this.forceQueued = false;
        result = await this.runSync(force);
      } while (this.forceQueued && !this.disposed && this.owns());
      if (!result || !result.current() || !result.completed) return;
      this.lastSync = this.now();
      this.missingConversations = result.missing;
      this.confirmedMissingConversations = result.confirmed;
      this.retryingConversations = result.retrying;
      this.status = result.more ? 'syncing' : result.missing ? 'partial' : 'ready';
      if (result.more) {
        this.continuation = setTimeout(() => void this.sync(), this.continueDelay);
        (this.continuation as unknown as UnrefableTimer).unref?.();
      }
    })()
      .catch(() => {
        this.status = 'offline';
        this.lastSync = this.now();
      })
      .finally(() => {
        this.syncing = false;
        this.pending = null;
      });
    return this.pending;
  }

  async runSync(forceFull: boolean): Promise<RunSyncResult> {
    const scope = this.store.identity;
    const epoch = this.store.epoch;
    const current = (): boolean =>
      !this.disposed && this.owns() && scope === this.store.identity && epoch === this.store.epoch;
    if (!scope) return null;
    if (this.scope !== scope || this.scopeEpoch !== epoch) {
      this.scope = scope;
      this.scopeEpoch = epoch;
      this.fingerprints.clear();
      this.snapshotStates.clear();
      this.fullRemaining.clear();
      this.passSeen.clear();
      this.passFailures.clear();
      this.readFailures.clear();
    }
    let missing = 0;
    let listed: ListedConversationSummary[] = [];
    try {
      listed = await this.store.listConversations(true);
    } catch {
      missing++;
    }
    if (!current()) return { current, completed: false };
    const rawSummaries = (this.store as { rawSummaries?: Record<string, unknown> | null }).rawSummaries;
    if (
      rawSummaries &&
      typeof rawSummaries === 'object' &&
      rawSummaries !== this.lastPersistedRawSummaries
    ) {
      this.lastPersistedRawSummaries = rawSummaries;
      if (Object.keys(rawSummaries).length > 0) {
        await persistProjectMetaFromRawSummaries(this.ledger, rawSummaries).catch(() => {});
      }
    }
    const local = await this.discoverLocal();
    if (!current()) return { current, completed: false };
    missing += local.errors || 0;

    const [journal, ownership, { ownFiles, otherFiles }] = await Promise.all([
      this.host ? this.ledger.backfillState(scope, this.host) : Promise.resolve({} as Record<string, BackfillEntry>),
      this.ledger.ownership(),
      this.ledger.otherScopeFiles(scope),
    ]);
    const candidates = buildSyncCandidates({
      scope,
      listed,
      local,
      ownership,
      ownFiles,
      otherFiles,
      resolveFile: (sc, cid) => this.ledger.file(sc, cid),
    });
    if (forceFull) {
      this.fullRemaining = new Set(candidates.keys());
      this.passSeen.clear();
      this.passFailures.clear();
    }

    const candidateList = [...candidates.values()];
    const descriptors: SessionDescriptorInput[] = new Array(candidateList.length);
    for (let i = 0; i < candidateList.length; i++) {
      const c = candidateList[i];
      const s = c.listed;
      const prevState = this.snapshotStates.get(c.id);
      const sameRawModified = prevState ? prevState.rawModifiedAt === s?.modifiedAt : false;
      descriptors[i] = {
        cascadeId: c.id,
        mtimeMs: parseSummaryMtimeMs(s?.modifiedAt),
        sizeBytes: c.sizeBytes ?? 0,
        stepCount: typeof s?.stepCount === 'number' && Number.isFinite(s.stepCount) ? Math.trunc(s.stepCount) : 0,
        lastUserInputStepIndex:
          typeof s?.lastUserInputStepIndex === 'number' && Number.isFinite(s.lastUserInputStepIndex)
            ? Math.trunc(s.lastUserInputStepIndex)
            : -1,
        status: String(s?.status || ''),
        prevFingerprint: prevState && sameRawModified ? prevState.fingerprint : null,
        prevSettled: prevState ? prevState.settled : null,
      };
    }
    const diffResult = diffSessionSnapshotsWithFallback(descriptors);
    const recordDiffState = (
      c: CandidateConversation,
      diffItem: (typeof diffResult.items)[number] | undefined,
      synced: boolean,
    ): void => {
      if (!diffItem) return;
      this.snapshotStates.set(c.id, {
        fingerprint: diffItem.fingerprint,
        settled: diffItem.statusKind === 'settled',
        signature: c.signature,
        rawModifiedAt: c.listed?.modifiedAt,
        synced,
      });
    };

    const started = this.now();
    let processed = 0;
    let more = false;
    let dirty = false;
    let cancelled = false;

    try {
      for (let i = 0; i < candidateList.length; i++) {
        if (!current()) {
          cancelled = true;
          break;
        }
        const c = candidateList[i];
        const diffItem = diffResult.items[i];
        const s = c.listed;
        const prevState = this.snapshotStates.get(c.id);
        const forced = this.fullRemaining.has(c.id);
        if (!forced && this.passSeen.has(c.id)) continue;
        if (
          !forced &&
          (s || c.signature) &&
          diffItem &&
          diffItem.transition === 'unchanged' &&
          !diffItem.needsPoll &&
          prevState?.synced &&
          prevState.signature === c.signature
        ) {
          continue;
        }
        const key = sha256(c.id);
        const mark = candidateMark(s);
        const signature = candidateSignature(c.signature, mark);
        const old = journal[key];
        const unchanged = old?.signature === signature;
        if (!forced && unchanged && old.state === 'retry' && old.retryAt > this.now()) {
          this.passFailures.add(c.id);
          recordDiffState(c, diffItem, false);
          continue;
        }
        const cached = Boolean(
          s && this.fingerprints.get(c.id) === mark && !/RUNNING|GENERATING|WAITING|QUEUED/i.test(s.status || ''),
        );
        const settled = Boolean(
          s?.modifiedAt && /IDLE|DONE|COMPLETED|CANCELLED|CANCELED|STOPPED|FAILED|ERROR/.test(String(s.status || '')),
        );
        if (!forced && (c.signature ? unchanged && old?.state === 'complete' && (!s || cached || settled) : cached)) {
          recordDiffState(c, diffItem, true);
          continue;
        }
        if (processed && this.now() - started >= this.sliceMs) {
          more = true;
          break;
        }
        processed++;
        this.passSeen.add(c.id);
        this.fullRemaining.delete(c.id);
        try {
          const outcome = await syncOneCandidate({
            candidate: c,
            scope,
            forced,
            store: this.store,
            ledger: this.ledger,
            current,
            conversationsDir: this.conversationsDir,
          });
          if (outcome.cancelled) {
            cancelled = true;
            break;
          }
          this.fingerprints.set(c.id, mark);
          recordDiffState(c, diffItem, true);
          this.passFailures.delete(c.id);
          this.readFailures.delete(c.id);
          if (this.host && c.signature) {
            journal[key] = { signature, state: 'complete', failures: 0, retryAt: 0 };
            dirty = true;
          }
        } catch {
          if (!current()) {
            cancelled = true;
            break;
          }
          recordDiffState(c, diffItem, false);
          this.passFailures.add(c.id);
          const failures = c.signature ? (unchanged ? (old?.failures || 0) + 1 : 1) : (this.readFailures.get(c.id) || 0) + 1;
          this.readFailures.set(c.id, failures);
          if (this.host && c.signature) {
            journal[key] = buildRetryEntry(signature, failures, this.now());
            dirty = true;
          }
        }
        await yieldToLiveRequests();
      }
    } finally {
      // Persist checkpoint once per slice rather than after every conversation.
      if (dirty && this.host) {
        dirty = false;
        await this.ledger.saveBackfillState(scope, this.host, journal);
      }
    }
    if (cancelled) return { current, completed: false };
    const confirmed = [...this.passFailures].filter(
      (id) => (journal[sha256(id)]?.failures || this.readFailures.get(id) || 0) >= 2,
    ).length;
    return { current, completed: true, missing: missing + this.passFailures.size, confirmed, retrying: missing + this.passFailures.size - confirmed, more };
  }

  private prepareSyncAndScope(scopeOverride?: string): string | null {
    const targetScope = scopeOverride || this.viewScope || 'all';
    if (!targetScope && !this.store?.identity) return null;
    if (this.store?.identity && (this.scope !== this.store.identity || this.scopeEpoch !== this.store.epoch)) {
      this.lastSync = 0;
      this.status = 'waiting';
      this.missingConversations = 0;
      this.confirmedMissingConversations = 0;
      this.retryingConversations = 0;
      if (this.pending) this.forceQueued = true;
    }
    if (this.store?.identity && this.now() - this.lastSync > 60000 && !this.continuation) void this.sync();
    return targetScope;
  }

  async totalsSnapshot(scope?: string, now: number = Date.now()): Promise<UsageTotalsSnapshot | null> {
    const effectiveScope = this.prepareSyncAndScope(scope);
    if (!effectiveScope || (!HASH_RE.test(effectiveScope) && effectiveScope !== 'all')) return null;
    const today = dateKey(now, this.ledger.timeZone);
    const startRevision = this.ledger.revision;
    const cached = this.totalsCache;
    if (
      cached &&
      cached.revision === startRevision &&
      cached.today === today &&
      cached.scope === effectiveScope &&
      cached.timeZone === this.ledger.timeZone
    ) {
      return cached.value;
    }
    this.ledger.touchUsageActivity?.(Date.now());
    const value = await this.ledger.summary(effectiveScope, now);
    if (!value) return null;
    const totals: UsageTotalsSnapshot = {
      todayTokens: value.todayTokens,
      monthTokens: value.monthTokens,
    };
    if (this.ledger.revision === startRevision) {
      this.totalsCache = {
        revision: startRevision,
        today,
        scope: effectiveScope,
        timeZone: value.timeZone || this.ledger.timeZone,
        value: totals,
      };
    }
    return totals;
  }

  async snapshot(): Promise<UsageSummarySnapshot | null> {
    const scope = this.prepareSyncAndScope();
    if (!scope) return null;
    this.ledger.touchUsageActivity?.(Date.now());
    const startRevision = this.ledger.revision;
    const [value, accounts] = await Promise.all([this.ledger.summary(scope), this.ledger.getAccounts(scope)]);
    if (value && this.ledger.revision === startRevision) {
      this.totalsCache = {
        revision: startRevision,
        today: value.today,
        scope,
        timeZone: value.timeZone || this.ledger.timeZone,
        value: { todayTokens: value.todayTokens, monthTokens: value.monthTokens },
      };
    }
    return value
      ? {
          ...value,
          viewScope: scope,
          activeAccount: this.store?.identity || scope,
          recordingAccount: this.store?.identity || null,
          localAccountMode: Boolean((this.store as { localFallbackActive?: boolean } | null)?.localFallbackActive),
          accounts,
          syncing: this.syncing || !!this.continuation,
          status: this.status,
          missingConversations: this.missingConversations,
          confirmedMissingConversations: this.confirmedMissingConversations,
          retryingConversations: this.retryingConversations,
          persistenceError: this.store?.usagePersistenceError === true,
        }
      : null;
  }

  async addManualUsage(scope: string, data?: ManualUsageInput): Promise<ManualUsageRecord> { return await this.ledger.addManualUsage(scope, data); }
  async deleteManualUsage(scope: string, id: string): Promise<boolean> { return await this.ledger.deleteManualUsage(scope, id); }
  async getAccounts(): Promise<UsageAccountsResult> {
    this.ledger.touchUsageActivity?.(Date.now());
    return await this.ledger.getAccounts(this.viewScope || 'all');
  }

  async getRecordingAccountState(): Promise<{
    active: string | null;
    selected: string | null;
    localMode: boolean;
    accounts: UsageAccountsResult;
  }> {
    this.ledger.touchUsageActivity?.(Date.now());
    const [selected, accounts] = await Promise.all([
      this.ledger.getActiveLocalAccount(),
      this.ledger.getAccounts(this.store?.identity || null),
    ]);
    return {
      active: this.store?.identity || selected || null,
      selected,
      localMode: Boolean((this.store as { localFallbackActive?: boolean } | null)?.localFallbackActive),
      accounts,
    };
  }

  async setRecordingAccount(
    target: string | { scope?: string | null; account?: string | null; id?: string | null } | null | undefined,
  ): Promise<{
    active: string | null;
    selected: string | null;
    localMode: boolean;
    accounts: UsageAccountsResult;
  }> {
    const raw =
      typeof target === 'string'
        ? target
        : target && typeof target === 'object'
          ? (target.scope ?? target.account ?? target.id ?? null)
          : null;
    const scope = raw === '' || raw === 'auto' ? null : raw;
    if (scope !== null && !HASH_RE.test(scope)) throw new Error('Invalid account scope');
    const saved = await this.ledger.setActiveLocalAccount(scope);
    const storeMut = this.store as { setLocalIdentity?: (next: string | null) => boolean } | null;
    if (saved) {
      storeMut?.setLocalIdentity?.(saved);
    } else if (scope === null) {
      storeMut?.setLocalIdentity?.(null);
    }
    this.lastSync = 0;
    return this.getRecordingAccountState();
  }

  async addLocalAccount(input: { email?: string; name?: string; identifier?: string; activate?: boolean }): Promise<{
    success: true;
    account: { id: string; name: string; email?: string | null; primary?: boolean; active: boolean };
    active: string | null;
    selected: string | null;
    accounts: UsageAccountsResult;
  }> {
    const created = await this.ledger.createLocalAccount(input);
    const activate = input?.activate !== false;
    if (activate) {
      const storeMut = this.store as { setLocalIdentity?: (next: string | null) => boolean } | null;
      storeMut?.setLocalIdentity?.(created.id);
      this.lastSync = 0;
    }
    const state = await this.getRecordingAccountState();
    return {
      success: true,
      account: created,
      active: state.active,
      selected: state.selected,
      accounts: state.accounts,
    };
  }

  async reassignConversation(input: {
    conversationId?: string;
    conversationIds?: string[];
    targetScope: string;
  }): Promise<{ success: true; reassigned: number; targetScope: string; conversationIds: string[] }> {
    const ids = [
      ...(Array.isArray(input?.conversationIds) ? input.conversationIds : []),
      ...(typeof input?.conversationId === 'string' ? [input.conversationId] : []),
    ];
    const result = await this.ledger.reassignConversationOwnership(ids, input?.targetScope || '');
    return { success: true, ...result };
  }

  async switchAccount(
    target: string | { account?: string; id?: string; accountKey?: string } | null | undefined,
  ): Promise<{ success: true; active: string; activeAccount: string }> {
    const scope = typeof target === 'string' ? target : target?.account || target?.id || target?.accountKey;
    if (!scope || (scope !== 'all' && !HASH_RE.test(scope))) throw new Error('Invalid account scope');
    this.viewScope = scope;
    return { success: true, active: scope, activeAccount: this.store?.identity || scope };
  }

  dispose(): void {
    this.disposed = true;
    this.forceQueued = false;
    this.totalsCache = null;
    if (this.continuation !== null) clearTimeout(this.continuation);
    this.continuation = null;
  }
}
