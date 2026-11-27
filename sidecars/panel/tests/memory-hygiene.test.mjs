import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isNativeAccelAvailable } from '../../../src/platform/native-bridge.ts';
import { DesktopUsage, UsageLedger } from '../../../src/telemetry/ledger/index.ts';
import { startPreviewServer } from '../../../src/telemetry/preview-server.ts';
import { DelegatedUsage } from '../../../src/telemetry/delegation/delegated-usage.ts';
import { TrajectoryReader } from '../../../src/telemetry/reader/trajectory-reader.ts';
import { TranscriptReader } from '../../../src/telemetry/reader/transcript.ts';
import { SessionHistory } from '../../../src/telemetry/store/history.ts';
import { MetricsStore } from '../../../src/telemetry/store/metrics-store.ts';
import { RATE_VERSION } from '../../../src/telemetry/rate-quality.ts';
import { TimelineStore } from '../../../src/telemetry/timeline/store.ts';
import { dispatchBindingCall } from '../../../src/ui/runtime-ui/binding-dispatch.ts';
import { handleCdpEvent } from '../../../src/ui/runtime-ui/event-handler.ts';
import { bindWindowFactory } from '../../../src/ui/runtime-ui/index.ts';
import { validatedInput } from '../../../src/ui/runtime-ui/renderer-bridge.ts';
import { RuntimeUi } from '../../../src/ui/runtime-ui/runtime-ui.ts';
import { attachTargetSession } from '../../../src/ui/runtime-ui/session-lifecycle.ts';

const SCOPE = 'a'.repeat(64);
const uuid = (n) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const hexId = (n) => String(n).padStart(64, 'b');

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ag-pulse-hygiene-'));
  return Promise.resolve().then(() => fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function sampleMetrics(id, tps = 50) {
  return {
    conversationId: id, steps: 2, rounds: 1, requests: 1, measuredRequests: 1, missingTiming: 0,
    tps, latestTps: tps, streamingSeconds: 1, modelSeconds: 1, toolSeconds: 0, ttftSeconds: 0.2,
    excludedTiming: 0, rateWarnings: 0, rateVersion: RATE_VERSION, latestRateStatus: 'ok', rateBasis: 'all-output',
    complete: true, timingReasons: {},
    counts: { input: 100, output: 50, responseOutput: 50, thinkingOutput: 0, cacheRead: 20, cacheWrite: 0 },
    cache: {
      inputTokens: 120, cachedTokens: 20, cacheWriteTokens: 0, uncachedTokens: 100, outputTokens: 50,
      measuredRequests: 1, missingRequests: 0, totalTokens: 170, hitRate: 20 / 120, complete: true,
    },
    tokens: {
      inputTokens: 120, cachedTokens: 20, cacheWriteTokens: 0, uncachedTokens: 100, outputTokens: 50,
      measuredRequests: 1, inputRequests: 1, outputRequests: 1, missingInputRequests: 0, missingOutputRequests: 0,
      totalTokens: 170, outputAvailable: true, complete: true,
    },
  };
}

function sampleTimeline(id, label = 'Turn 1') {
  return {
    enabled: true, cascadeId: id, totalDurationMs: 100, totalTokens: 150,
    nodes: [{ id: 'turn-1', kind: 'turn', time: '2026-06-01T00:00:00.000Z', durationMs: 100, event: label, children: [] }],
    swimlane: [],
  };
}

test('LedgerStorage skips fileIndex on write when native is available and tracks activity', async () => {
  await withTempDir(async (dir) => {
    const row = { id: hexId(1), at: Date.now(), model: 'Gemini 2.5 Pro', uncached: 100, cacheRead: 20, cacheWrite: 0, output: 50, partial: false, timeBasis: 'request-start' };
    const defaultLedger = new UsageLedger(join(dir, 'native'));
    defaultLedger.cache = { stamp: 'stale', value: {} };
    await defaultLedger.ingestRows(SCOPE, uuid(1), [row]);
    assert.ok(defaultLedger.lastUsageActivityAt > 0);
    assert.equal(defaultLedger.revision, 1);
    assert.equal(defaultLedger.cache, null);
    assert.equal(defaultLedger.keyVersions.size, 1);
    assert.equal(defaultLedger.dirtyRelPaths.size, 1);
    assert.equal(defaultLedger.projectDirtyRelPaths.size, 1);
    if (isNativeAccelAvailable()) assert.equal(defaultLedger.fileIndex.size, 0);

    const customLedger = new UsageLedger(join(dir, 'custom'), { fs: {} });
    await customLedger.ingestRows(SCOPE, uuid(2), [{ ...row, id: hexId(2) }]);
    assert.equal(customLedger.fileIndex.get(SCOPE)?.size, 1);
  });
});

test('MetricsStore caps sessions at 16 LRU and prunes baseMetrics on non-recent entries', async () => {
  await withTempDir(async (dir) => {
    const summaries = {};
    for (let i = 1; i <= 20; i++) {
      summaries[uuid(i)] = { summary: `S${i}`, stepCount: 1, status: 'CASCADE_RUN_STATUS_IDLE', lastModifiedTime: new Date().toISOString() };
    }
    const client = {
      server: { pid: 1, port: 1, csrf: 'x' },
      now: () => 10_000,
      discover: async () => client.server,
      summaries: async () => ({ trajectorySummaries: summaries }),
      trajectory: async (id) => ({
        trajectory: { cascadeId: id, steps: [{ type: 'CORTEX_STEP_TYPE_USER_INPUT', metadata: { createdAt: '2026-06-01T00:00:00Z' } }], generatorMetadata: [] },
        numTotalSteps: 1, numTotalGeneratorMetadata: 0, status: 'CASCADE_RUN_STATUS_IDLE',
      }),
      reader: { summaries: {} },
    };
    const store = new MetricsStore(client, { history: new SessionHistory(join(dir, 'h')), timelineStore: null, dataDir: dir });
    store.identity = SCOPE;
    await store.session(uuid(1), true);
    store.lastActiveConversationId = uuid(1);
    store.sessions.set(uuid(2), { pending: new Promise(() => {}), baseMetrics: sampleMetrics(uuid(2)) });

    for (let i = 3; i <= 20; i++) await store.session(uuid(i), true);
    assert.equal(store.sessions.size, 16);
    assert.ok(store.sessions.has(uuid(1)), 'lastActiveConversationId must be retained');
    assert.ok(store.sessions.has(uuid(2)), 'pending session must be retained');
    assert.ok(!store.sessions.has(uuid(3)), 'oldest unprotected session evicted');

    // Touch an older surviving session so LRU spares it on next insertion.
    const touchedId = uuid(7);
    store.touchSession(touchedId, store.sessions.get(touchedId));
    await store.session(uuid(21), true);
    assert.equal(store.sessions.size, 16);
    assert.ok(store.sessions.has(touchedId));
    assert.ok(!store.sessions.has(uuid(8)));

    // Only the 2 most recent (or pending) retain baseMetrics unless rawWeak is dead.
    const recentIds = [...store.sessions.keys()].slice(-2);
    for (const [id, entry] of store.sessions) entry.baseMetrics = sampleMetrics(id);
    store.pruneBaseMetrics();
    for (const [id, entry] of store.sessions) {
      if (recentIds.includes(id) || entry.pending) assert.ok(entry.baseMetrics);
      else assert.equal(entry.baseMetrics, null);
    }
    const newest = store.sessions.get(recentIds[1]);
    newest.rawWeak = { deref: () => undefined };
    newest.rawRev = 1;
    store.pruneBaseMetrics();
    assert.equal(newest.baseMetrics, null);
    assert.equal(newest.rawWeak, null);
  });
});

test('TrajectoryReader, DelegatedUsage, and TranscriptReader trimIdle protect active entries and enforce caps', async () => {
  let clock = 1_000_000;
  const bigText = 'x'.repeat(1_050_000);
  const client = {
    server: { pid: 1, port: 1, csrf: 'x' },
    now: () => clock,
    discover: async () => client.server,
    call: async (method, body) => {
      if (method === 'GetCascadeTrajectorySteps') {
        const size = body.cascadeId === uuid(1) ? 3 : 1;
        return { steps: Array.from({ length: size }, (_, i) => ({ type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', metadata: { createdAt: '2026-06-01T00:00:00Z' }, plannerResponse: { response: i === 0 ? bigText : 'ok' } })) };
      }
      if (method === 'GetCascadeTrajectoryGeneratorMetadata') return { generatorMetadata: [] };
      return { trajectorySummaries: {} };
    },
    trajectory: async () => ({ trajectory: { steps: [], generatorMetadata: [] }, numTotalSteps: 0, numTotalGeneratorMetadata: 0 }),
  };
  const reader = new TrajectoryReader(client, { budgetBytes: 8 * 1024 * 1024 });
  const idleSummary = { status: 'CASCADE_RUN_STATUS_IDLE', stepCount: 1, modifiedTime: new Date().toISOString() };
  await reader.read(uuid(1), { summary: { ...idleSummary, stepCount: 3 } }); // ~3 MiB kept
  await reader.read(uuid(2), { summary: idleSummary }); // stale idle
  clock += 200_000;
  await reader.read(uuid(3), { summary: idleSummary }); // ~1 MiB fresh inactive
  await reader.read(uuid(4), { summary: idleSummary }); // ~1 MiB fresh inactive
  await reader.read(uuid(5), { summary: idleSummary }); // ~1 MiB fresh inactive
  reader.entries.set(uuid(6), { data: null, bytes: 1024, pending: Promise.resolve(), verifiedAt: 0, lastAccessedAt: 0 });
  const evicted = reader.trimIdle(180_000, new Set([uuid(1)]));
  assert.ok(evicted >= 2);
  assert.ok(reader.entries.has(uuid(1)), 'keepIds active > 2 MiB stays intact under 8 MiB budget');
  assert.ok(!reader.entries.has(uuid(2)), 'expired inactive entry evicted');
  assert.ok(reader.entries.has(uuid(6)), 'pending entry never evicted');
  let inactiveBytes = 0;
  for (const [k, e] of reader.entries) {
    if (k !== uuid(1) && !e.pending && !e.backfilling) inactiveBytes += e.bytes;
  }
  assert.ok(inactiveBytes <= 2 * 1024 * 1024, `inactiveBytes ${inactiveBytes} exceeded 2 MiB`);

  const delegated = new DelegatedUsage(client, { now: () => clock });
  delegated.request(SCOPE, uuid(1), { trajectory: { steps: [] } }, { knownIds: [uuid(10)] });
  delegated.request(SCOPE, uuid(2), { trajectory: { steps: [] } }, { knownIds: [uuid(11)] });
  await delegated.idle();
  clock += 200_000;
  delegated.tasks.get(uuid(2)).collecting = true;
  delegated.request(SCOPE, uuid(3), { trajectory: { steps: [] } }, { knownIds: [uuid(12)] });
  await delegated.idle(); // uuid(3) accessed at current clock
  delegated.tasks.set(uuid(4), { ...delegated.tasks.get(uuid(3)), id: uuid(4), bytes: 500, requested: false, collecting: false, lastAccessedAt: clock - 190_000, lastAt: clock - 190_000 });
  delegated.bytes += 500;
  assert.equal(delegated.trimIdle(180_000, new Set([uuid(1)])), 1);
  assert.ok(delegated.tasks.has(uuid(1)));
  assert.ok(delegated.tasks.has(uuid(2)));
  assert.ok(delegated.tasks.has(uuid(3)));
  assert.ok(!delegated.tasks.has(uuid(4)));

  const transcripts = new TranscriptReader({ now: () => clock });
  const baseEntry = { state: null, error: null, requested: false, continuing: false, lastAccessedAt: clock - 200_000 };
  transcripts.entries.set(`${SCOPE}:${uuid(1)}`, { ...baseEntry, key: `${SCOPE}:${uuid(1)}`, id: uuid(1) });
  transcripts.entries.set(`${SCOPE}:${uuid(2)}`, { ...baseEntry, key: `${SCOPE}:${uuid(2)}`, id: uuid(2), continuing: true });
  transcripts.entries.set(`${SCOPE}:${uuid(3)}`, { ...baseEntry, key: `${SCOPE}:${uuid(3)}`, id: uuid(3) });
  assert.equal(transcripts.trimIdle(180_000, new Set([uuid(1)])), 1);
  assert.ok(transcripts.entries.has(`${SCOPE}:${uuid(1)}`));
  assert.ok(transcripts.entries.has(`${SCOPE}:${uuid(2)}`));
  assert.ok(!transcripts.entries.has(`${SCOPE}:${uuid(3)}`));
});

test('SessionHistory & TimelineStore store SHA-256 hashes and enforce 16 / 8 writeCache caps', async () => {
  await withTempDir(async (dir) => {
    const history = new SessionHistory(join(dir, 'history'));
    let atomicWrites = 0;
    const origWrite = history.write.bind(history);
    history.write = async (...args) => { atomicWrites++; return origWrite(...args); };
    for (let i = 1; i <= 18; i++) await history.save(SCOPE, uuid(i), sampleMetrics(uuid(i), 40 + i));
    assert.equal(history.writeCache.size, 16);
    for (const entry of history.writeCache.values()) {
      assert.match(entry.metricsHash, /^[a-f0-9]{64}$/);
      assert.equal('metricsJson' in entry, false);
    }
    const targetFile = history.file(SCOPE, uuid(18));
    const diskBefore = readFileSync(targetFile, 'utf8');
    const deduped = await history.save(SCOPE, uuid(18), sampleMetrics(uuid(18), 58));
    assert.equal(deduped.savedAt, JSON.parse(diskBefore).savedAt);
    assert.equal(readFileSync(targetFile, 'utf8'), diskBefore);
    await history.save(SCOPE, uuid(18), sampleMetrics(uuid(18), 99));
    assert.equal(JSON.parse(readFileSync(targetFile, 'utf8')).metrics.tps, 99);
    assert.equal(atomicWrites, 20);

    const timeline = new TimelineStore(join(dir, 'timeline'));
    for (let i = 1; i <= 10; i++) await timeline.save(SCOPE, uuid(i), sampleTimeline(uuid(i), `T${i}`));
    assert.equal(timeline.writeCache.size, 8);
    for (const entry of timeline.writeCache.values()) {
      assert.match(entry.bodyHash, /^[a-f0-9]{64}$/);
      assert.equal('bodyKey' in entry, false);
    }
    const tFile = timeline.file(SCOPE, uuid(10));
    const tBefore = readFileSync(tFile, 'utf8');
    await timeline.save(SCOPE, uuid(10), sampleTimeline(uuid(10), 'T10'));
    assert.equal(readFileSync(tFile, 'utf8'), tBefore);
    await timeline.save(SCOPE, uuid(10), sampleTimeline(uuid(10), 'Updated'));
    assert.notEqual(readFileSync(tFile, 'utf8'), tBefore);
  });
});

test('RuntimeUi.setHealth throttles identical writes to 60s and guardedSource uses a lazy getter', async () => {
  await withTempDir(async (dir) => {
    let clock = 500_000;
    const ui = new RuntimeUi({ dataDir: dir, now: () => clock, healthWriteThrottleMs: 60_000, discover: async () => [] });
    const stateFile = join(dir, 'integration-state.json');
    await ui.setHealth('waiting', 'Waiting');
    const first = readFileSync(stateFile, 'utf8');
    clock += 5_000;
    writeFileSync(stateFile, 'sentinel', 'utf8');
    await ui.setHealth('waiting', 'Waiting');
    assert.equal(readFileSync(stateFile, 'utf8'), 'sentinel', 'identical state within 60s skips write');
    await ui.setHealth('mounted', 'Mounted');
    assert.notEqual(readFileSync(stateFile, 'utf8'), 'sentinel', 'state change writes immediately');
    assert.notEqual(readFileSync(stateFile, 'utf8'), first);
    clock += 60_000;
    writeFileSync(stateFile, 'sentinel2', 'utf8');
    await ui.setHealth('mounted', 'Mounted');
    assert.notEqual(readFileSync(stateFile, 'utf8'), 'sentinel2', '>= 60s refreshes state file');
    clock += 1_000;
    writeFileSync(stateFile, 'sentinel3', 'utf8');
    await ui.stop();
    assert.notEqual(readFileSync(stateFile, 'utf8'), 'sentinel3', 'stop() force-flushes health state');

    const conn = {
      closed: false,
      open: async () => {},
      close: () => { conn.closed = true; },
      command: async (method) => method === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'f1' } } } : { identifier: 's1' },
    };
    const attached = await attachTargetSession(
      { source: 'console.log(1)', owner: 'o', binding: '__b', stopping: false, owns: () => true, targetOrigin: () => 'https://app.local', connect: () => conn, onEvent: () => {}, rendererGuard: (e) => e },
      { webSocketDebuggerUrl: 'ws://127.0.0.1:9/p', url: 'https://app.local/index.html', title: 'app' },
    );
    const desc = Object.getOwnPropertyDescriptor(attached, 'guardedSource');
    assert.equal(desc?.value, undefined);
    assert.equal(typeof desc?.get, 'function');
    assert.equal(attached.guardedSource, 'if (location.origin === "https://app.local") {console.log(1)}');
  });
});

test('DesktopUsage.totalsSnapshot caches by (revision, today, scope) and still triggers sync()', async () => {
  await withTempDir(async (dir) => {
    const ledger = new UsageLedger(join(dir, 'usage'));
    const dayMs = Date.UTC(2026, 5, 10, 8, 0, 0);
    await ledger.ingestRows(SCOPE, uuid(1), [{
      id: hexId(1), at: dayMs, model: 'Gemini 2.5 Pro', uncached: 100, cacheRead: 25, cacheWrite: 0, output: 50, partial: false, timeBasis: 'request-start',
    }]);
    let summaryCalls = 0;
    const origSummary = ledger.summary.bind(ledger);
    ledger.summary = async (scope, at) => { summaryCalls++; return origSummary(scope, at); };

    let syncClock = 100_000;
    let syncCalls = 0;
    const store = { identity: SCOPE, epoch: 1 };
    const usage = new DesktopUsage(store, ledger, { now: () => syncClock });
    usage.sync = async () => { syncCalls++; return null; };

    const a = await usage.totalsSnapshot(SCOPE, dayMs);
    assert.equal(a?.todayTokens, 175);
    assert.equal(a?.monthTokens, 175);
    assert.equal(summaryCalls, 1);
    assert.equal(syncCalls, 1);

    const prevActivity = ledger.lastUsageActivityAt;
    syncClock += 70_000;
    const b = await usage.totalsSnapshot(SCOPE, dayMs);
    assert.deepEqual(b, a);
    assert.equal(summaryCalls, 1, 'cached totalsSnapshot avoids ledger.summary');
    assert.equal(syncCalls, 2, 'cached totalsSnapshot still schedules sync after 60s');
    assert.equal(ledger.lastUsageActivityAt, prevActivity, 'cache hit does not bump activity timestamp');

    const nextDay = dayMs + 24 * 60 * 60 * 1000;
    const c = await usage.totalsSnapshot(SCOPE, nextDay);
    assert.equal(c?.todayTokens, 0);
    assert.equal(c?.monthTokens, 175);
    assert.equal(summaryCalls, 2, 'date rollover invalidates totalsCache');
  });
});

test('binding-dispatch single-stringifies and preview server exposes /usage-ui.js + compact /api/metrics', async () => {
  assert.deepEqual(validatedInput({ conversationId: null, force: 1 }), { conversationId: null, force: false });
  assert.deepEqual(validatedInput({ conversationId: null, force: false, includeUsage: false }), { conversationId: null, force: false, includeUsage: false });

  const calls = [];
  const conn = {
    origin: 'https://app.local', frameId: 'f1', contexts: new Set([1]),
    command: async (method, params) => { calls.push({ method, params }); return {}; },
    close: () => {}, open: async () => {},
  };
  let stringifyCalls = 0;
  const origStringify = JSON.stringify;
  JSON.stringify = function (...args) { stringifyCalls++; return origStringify.apply(this, args); };
  try {
    const out = await dispatchBindingCall({ enabled: () => true, snapshot: async () => ({ connection: 'live', speed: null, groups: [] }) }, conn, { id: 1, type: 'metrics', input: { includeUsage: false } });
    assert.equal(stringifyCalls, 1);
    assert.equal(out.serializedResult, origStringify(out.result));

    stringifyCalls = 0;
    await handleCdpEvent(
      { binding: '__b', stopping: false, owns: () => true, rendererGuard: (e) => e, enabled: () => true, snapshot: async () => ({ connection: 'live', speed: null, groups: [], serverTime: 't' }) },
      conn,
      { method: 'Runtime.bindingCalled', params: { name: '__b', executionContextId: 1, payload: '{"id":2,"type":"metrics","input":{"includeUsage":false}}' } },
    );
    assert.equal(stringifyCalls, 1, 'handleCdpEvent uses serializedResult without a second JSON.stringify');
  } finally {
    JSON.stringify = origStringify;
  }

  const bigOutcome = await dispatchBindingCall(
    { enabled: () => true, snapshot: async () => ({ blob: 'z'.repeat(1_100_000) }) },
    conn,
    { id: 3, type: 'metrics', input: {} },
  );
  assert.equal(bigOutcome.result.connection, 'offline');
  assert.equal(bigOutcome.result.error, 'Metrics response too large');

  const usageJs = bindWindowFactory('__agPulseUsageFactory', readFileSync(join(process.cwd(), 'compat', 'usage-ui.cjs'), 'utf8'), 'usage-ui');
  const fakeWin = {};
  new Function('window', usageJs)(fakeWin);
  assert.equal(typeof fakeWin.__agPulseUsageFactory, 'function');

  const seenInputs = [];
  const server = startPreviewServer({
    here: join(process.cwd(), 'sidecars', 'panel'),
    port: 0,
    guidPattern: /^[0-9a-f-]{36}$/i,
    staticFiles: { '/': ['index.html', 'text/html'] },
    livePreferences: { get: async () => ({}), snapshot: async () => ({}), set: async () => ({}) },
    store: { clearTimeline: async () => ({ cleared: true }) },
    metrics: async (input) => { seenInputs.push(input); return { connection: 'live', speed: null, groups: [], usageTotals: { todayTokens: 1, monthTokens: 2 } }; },
    getHealth: () => ({ state: 'mounted', mode: 'live', message: 'ok', windows: 1 }),
    i18nModule: () => '', themeModule: () => '', themeCss: () => '', inlineSource: () => '',
    usageUiModule: () => usageJs,
  });
  try {
    await new Promise((resolve) => server.listening ? resolve() : server.once('listening', resolve));
    const port = server.address().port;
    const jsRes = await fetch(`http://127.0.0.1:${port}/usage-ui.js`);
    assert.equal(jsRes.status, 200);
    assert.match(jsRes.headers.get('content-type') || '', /application\/javascript/);
    assert.ok((await jsRes.text()).includes('__agPulseUsageFactory'));

    const mRes = await fetch(`http://127.0.0.1:${port}/api/metrics?includeUsage=0`);
    assert.equal(mRes.status, 200);
    assert.equal(seenInputs[0].includeUsage, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
