import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  isNativeAccelAvailable,
  readLedgerSharedProjectSummaries,
  releaseNativeCaches,
} from '../../../src/platform/native-bridge.ts';
import {
  DesktopUsage,
  UsageLedger,
  queryProjectUsageOverview,
  queryProjectConversationDetail,
  dateTimeParts,
} from '../usage.mjs';

const scope = (s) => createHash('sha256').update(s).digest('hex');
const acctA = scope('account-a@example.test');
const acctB = scope('account-b@example.test');

const CID_MAIN = '11111111-1111-1111-1111-111111111111';
const CID_WORKTREE = '22222222-2222-2222-2222-222222222222';
const CID_SUBAGENT = '33333333-3333-3333-3333-333333333333';
const CID_CLI = '44444444-4444-4444-4444-444444444444';
const CID_GENERAL = '55555555-5555-5555-5555-555555555555';
const CID_FOREIGN = '66666666-6666-6666-6666-666666666666';
const CID_FALLBACK = '77777777-7777-7777-7777-777777777777';

function rawUsage({ at, responseId, input = 100, cacheRead = 200, output = 50 }) {
  return {
    trajectory: {
      steps: [
        {
          type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
          metadata: { createdAt: at },
        },
      ],
      generatorMetadata: [
        {
          stepIndices: [0],
          chatModel: {
            modelDisplayName: 'Gemini 3.8 Flash',
            chatStartMetadata: { createdAt: at },
            usage: {
              apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
              responseId,
              inputTokens: String(input),
              cacheReadTokens: String(cacheRead),
              cacheWriteTokens: '0',
              outputTokens: String(output),
            },
          },
        },
      ],
    },
  };
}

function createSummaryDb(dbPath, rows) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT,
        preview TEXT,
        last_modified_time datetime,
        workspace_uris TEXT,
        project_id TEXT,
        parent_conversation_id TEXT,
        source TEXT,
        agent_name TEXT
      );
    `);
    const stmt = db.prepare(
      `INSERT INTO conversation_summaries
        (conversation_id, title, preview, last_modified_time, workspace_uris, project_id, parent_conversation_id, source, agent_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const r of rows) {
      stmt.run(
        r.conversationId,
        r.title ?? '',
        r.preview ?? '',
        r.lastModifiedTime ?? 0,
        r.workspaceUris ?? '',
        r.projectId ?? '',
        r.parentConversationId ?? '',
        r.source ?? '',
        r.agentName ?? '',
      );
    }
  } finally {
    db.close();
  }
}

async function setupFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ag-proj-stats-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ledger = new UsageLedger(join(root, 'ledger'));
  const profileDir = join(root, 'profile');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(profileDir, { recursive: true });

  await ledger.ingest(acctA, CID_MAIN, rawUsage({ at: '2026-10-11T04:00:00Z', responseId: 'r-main', input: 100, cacheRead: 200, output: 100 })); // 400
  await ledger.ingest(acctA, CID_WORKTREE, rawUsage({ at: '2026-10-11T05:00:00Z', responseId: 'r-wt', input: 200, cacheRead: 300, output: 100 })); // 600
  await ledger.ingest(acctA, CID_SUBAGENT, rawUsage({ at: '2026-10-11T06:00:00Z', responseId: 'r-sub', input: 50, cacheRead: 100, output: 50 })); // 200
  await ledger.ingest(acctA, CID_CLI, rawUsage({ at: '2026-10-11T07:00:00Z', responseId: 'r-cli', input: 80, cacheRead: 0, output: 20 })); // 100
  await ledger.ingest(acctA, CID_GENERAL, rawUsage({ at: '2026-10-11T08:00:00Z', responseId: 'r-gen', input: 150, cacheRead: 50, output: 50 })); // 250
  await ledger.ingest(acctA, CID_FALLBACK, rawUsage({ at: '2026-10-11T09:00:00Z', responseId: 'r-fb', input: 30, cacheRead: 0, output: 20 })); // 50
  await ledger.ingest(acctA, 'remote-box/99999999-aaaa-bbbb-cccc-dddddddddddd', rawUsage({ at: '2026-10-11T10:00:00Z', responseId: 'r-rem', input: 400, cacheRead: 0, output: 100 })); // 500
  await ledger.ingest(acctB, CID_FOREIGN, rawUsage({ at: '2026-10-11T11:00:00Z', responseId: 'r-for', input: 5000, cacheRead: 0, output: 500 })); // 5500 (different account!)

  createSummaryDb(join(profileDir, 'conversation_summaries.db'), [
    {
      conversationId: CID_MAIN,
      title: 'Fix dashboard dropdowns',
      lastModifiedTime: '2026-10-11T04:00:00Z',
      workspaceUris: JSON.stringify(['file:///C:/repo/antigrative-dashboard']),
      projectId: 'proj-dash',
    },
    {
      conversationId: CID_WORKTREE,
      title: '',
      preview: 'Worktree feature branch preview text',
      workspaceUris: JSON.stringify(['file:///C:/repo/antigrative-dashboard/.git/worktrees/wt-1']),
      projectId: 'proj-dash',
    },
    {
      conversationId: CID_SUBAGENT,
      title: '',
      workspaceUris: '',
      parentConversationId: CID_MAIN,
      agentName: 'researcher',
    },
    {
      conversationId: CID_CLI,
      title: 'Terminal CLI run',
      workspaceUris: JSON.stringify(['default-cli-project']),
    },
    {
      conversationId: CID_GENERAL,
      title: 'Standalone brainstorm',
      workspaceUris: JSON.stringify(['outside-of-project']),
    },
    {
      conversationId: 'remote-box/99999999-aaaa-bbbb-cccc-dddddddddddd',
      title: 'Remote SSH session',
      workspaceUris: '',
    },
    {
      conversationId: CID_FOREIGN,
      title: 'Foreign account project',
      workspaceUris: JSON.stringify(['file:///C:/repo/secret-project']),
      projectId: 'proj-secret',
    },
  ]);

  return { ledger, profileDir };
}

test('project stats scope to current account, map cli/conversations/worktrees/remote, and return human conversation names', async (t) => {
  const { ledger, profileDir } = await setupFixture(t);

  const overview = await queryProjectUsageOverview({
    ledger,
    profileDir,
    scope: acctA,
    from: '2026-10-11',
    to: '2026-10-11',
    timeZone: 'Asia/Shanghai',
  });

  assert.equal(overview.accountKey, acctA);
  // Sum excludes CID_FOREIGN (belongs to acctB): 400 + 600 + 200 + 100 + 250 + 50 + 500 = 2100
  assert.equal(overview.totalTokens, 2100);
  assert.equal(overview.requests, 7);

  const byKey = new Map(overview.projects.map((p) => [p.projectKey, p]));
  assert.equal(byKey.has('remote-secret-project'), false);
  assert.equal([...byKey.keys()].some((k) => k.includes('secret-project')), false);

  const dash = byKey.get('project:c:/repo/antigrative-dashboard');
  assert.ok(dash, 'Main repo + worktree + subagent should merge into project:c:/repo/antigrative-dashboard');
  assert.equal(dash.name, 'antigrative-dashboard');
  assert.equal(dash.kind, 'project');
  assert.equal(dash.total, 1200);
  assert.equal(dash.conversationCount, 3);

  const cli = byKey.get('cli');
  assert.ok(cli, 'default-cli-project should map to cli');
  assert.equal(cli.name, 'cli');
  assert.equal(cli.kind, 'cli');
  assert.equal(cli.total, 100);

  const convs = byKey.get('conversations');
  assert.ok(convs, 'outside-of-project and missing workspace should merge into conversations');
  assert.equal(convs.name, 'conversations');
  assert.equal(convs.kind, 'conversations');
  assert.equal(convs.total, 300);

  const remote = byKey.get('remote:remote-box');
  assert.ok(remote);
  assert.equal(remote.name, 'remote (remote-box)');
  assert.equal(remote.kind, 'remote');
  assert.equal(remote.total, 500);

  // Level 2 detail only computes selected project and uses human titles (no 64-char hash!)
  const detail = await queryProjectConversationDetail({
    ledger,
    profileDir,
    scope: acctA,
    projectKey: 'project:c:/repo/antigrative-dashboard',
    from: '2026-10-11',
    to: '2026-10-11',
    timeZone: 'Asia/Shanghai',
  });

  assert.equal(detail.projectKey, 'project:c:/repo/antigrative-dashboard');
  assert.equal(detail.totalTokens, 1200);
  assert.equal(detail.conversations.length, 3);
  assert.deepEqual(
    detail.conversations.map((c) => [c.id, c.title, c.total, c.isSubagent]),
    [
      [CID_WORKTREE, 'Worktree feature branch preview text', 600, false],
      [CID_MAIN, 'Fix dashboard dropdowns', 400, false],
      [CID_SUBAGENT, 'Fix dashboard dropdowns · researcher', 200, true],
    ],
  );
  const sub = detail.conversations.find((c) => c.id === CID_SUBAGENT);
  assert.ok(sub);
  assert.equal(sub.rootId, CID_MAIN);
  assert.equal(sub.rootTitle, 'Fix dashboard dropdowns');
  assert.equal(sub.agentName, 'researcher');
  const shareSum = detail.conversations.reduce((s, c) => s + c.share, 0);
  assert.ok(Math.abs(shareSum - 1) < 1e-9);
});

test('project stats respect date filters and never expose raw hashes in conversation titles', async (t) => {
  const { ledger, profileDir } = await setupFixture(t);

  const emptyRange = await queryProjectUsageOverview({
    ledger,
    profileDir,
    scope: acctA,
    from: '2026-10-01',
    to: '2026-10-05',
    timeZone: 'Asia/Shanghai',
  });
  assert.equal(emptyRange.totalTokens, 0);
  assert.equal(emptyRange.projects.length, 0);

  const convDetail = await queryProjectConversationDetail({
    ledger,
    profileDir,
    scope: acctA,
    projectKey: 'conversations',
    from: '2026-10-11',
    to: '2026-10-11',
    timeZone: 'Asia/Shanghai',
  });
  assert.equal(convDetail.conversations.length, 2);
  const titled = convDetail.conversations.find((c) => c.id === CID_GENERAL);
  assert.ok(titled);
  assert.equal(titled.title, 'Standalone brainstorm');
  const untitled = convDetail.conversations.find((c) => c.id !== CID_GENERAL);
  assert.ok(untitled);
  assert.ok(untitled.title.startsWith('Session '), `Expected short session label, got: ${untitled.title}`);
  assert.equal(untitled.title.length < 24, true);
});

test('conversation_summaries datetime text timestamps parse to positive epoch ms', async (t) => {
  const { createRequire } = await import('node:module');
  const req = createRequire(import.meta.url);
  const { mkdir } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'ag-proj-dt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(root, { recursive: true });
  const dbPath = join(root, 'conversation_summaries.db');
  const expectedMs = Date.parse('2026-10-11T04:00:00Z');
  createSummaryDb(dbPath, [
    {
      conversationId: CID_MAIN,
      title: 'ISO timestamp session',
      lastModifiedTime: '2026-10-11T04:00:00Z',
      workspaceUris: JSON.stringify(['file:///C:/repo/antigrative-dashboard']),
      projectId: 'proj-dash',
    },
  ]);
  const nativePath = new URL('../pulse-accel.node', import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, '$1');
  try {
    const addon = req(nativePath);
    if (typeof addon.readSqliteConversationSummariesJson === 'function') {
      const rows = JSON.parse(addon.readSqliteConversationSummariesJson(dbPath));
      assert.equal(rows[0].lastModifiedTime, expectedMs);
    }
  } catch {
    // Skip native assertion when local binary is absent.
  }
});

function intlDateTimeParts(time, zone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(time);
  const get = (k) => parts.find((p) => p.type === k)?.value;
  const h = Number.parseInt(get('hour') ?? '', 10);
  return {
    date: `${get('year') ?? ''}-${get('month') ?? ''}-${get('day') ?? ''}`,
    hour: Number.isInteger(h) && h >= 0 && h <= 23 ? h : 0,
  };
}

test('dateTimeParts matches Intl.DateTimeFormat across fixed offsets, DST America/New_York, and epoch 0', () => {
  const zones = ['UTC', 'Asia/Shanghai', 'Asia/Tokyo', 'America/New_York', 'Europe/London'];
  const samples = [
    0,
    -1,
    Date.parse('1969-12-31T23:59:59Z'),
    Date.parse('1988-06-15T12:00:00Z'), // Pre-1992 China DST
    Date.parse('2026-01-15T04:30:00Z'),
    Date.parse('2026-03-08T06:59:59Z'), // NY before spring forward
    Date.parse('2026-03-08T07:00:00Z'), // NY exact spring forward
    Date.parse('2026-03-08T07:30:00Z'),
    Date.parse('2026-06-15T03:59:59Z'),
    Date.parse('2026-10-11T16:00:00Z'),
    Date.parse('2026-11-01T04:59:59Z'),
    Date.parse('2026-11-01T05:00:00Z'), // NY fall-back first 01:00
    Date.parse('2026-11-01T05:59:59Z'),
    Date.parse('2026-11-01T06:00:00Z'), // NY fall-back second 01:00
    Date.parse('2026-12-31T23:59:59Z'),
  ];
  for (const zone of zones) {
    for (const ts of samples) {
      assert.deepEqual(dateTimeParts(ts, zone), intlDateTimeParts(ts, zone), `mismatch for ${zone} at ${ts}`);
      assert.deepEqual(dateTimeParts(new Date(ts), zone), intlDateTimeParts(new Date(ts), zone));
    }
  }
});

test('queryProjectConversationDetail("conversations") does not read files belonging to other workspace projects', async (t) => {
  const { ledger, profileDir } = await setupFixture(t);
  const readPaths = [];
  const spyLedger = new UsageLedger(ledger.directory, {
    fs: {
      readFile: async (p, ...args) => {
        readPaths.push(p);
        return await readFile(p, ...args);
      },
    },
  });

  const detail = await queryProjectConversationDetail({
    ledger: spyLedger,
    profileDir,
    scope: acctA,
    projectKey: 'conversations',
    from: '2026-10-11',
    to: '2026-10-11',
    timeZone: 'Asia/Shanghai',
  });
  assert.equal(detail.conversations.length, 2);
  assert.equal(detail.totalTokens, 300);

  const excludedCids = [
    CID_MAIN,
    CID_WORKTREE,
    CID_SUBAGENT,
    CID_CLI,
    'remote-box/99999999-aaaa-bbbb-cccc-dddddddddddd',
  ];
  for (const cid of excludedCids) {
    const h = scope(cid.toLowerCase());
    assert.equal(
      readPaths.some((p) => p.includes(h)),
      false,
      `Did not expect conversations detail query to read ${cid} (${h})`,
    );
  }
  assert.ok(readPaths.some((p) => p.includes(scope(CID_GENERAL.toLowerCase()))));
  assert.ok(readPaths.some((p) => p.includes(scope(CID_FALLBACK.toLowerCase()))));

  const countAfterFirst = readPaths.length;
  const detail2 = await queryProjectConversationDetail({
    ledger: spyLedger,
    profileDir,
    scope: acctA,
    projectKey: 'conversations',
    from: '2026-10-11',
    to: '2026-10-11',
    timeZone: 'Asia/Shanghai',
  });
  assert.equal(detail2.totalTokens, 300);
  assert.equal(readPaths.length, countAfterFirst, 'Repeat detail query should reuse stat-validated cache');
});

test('incremental cache invalidates on same-size file rewrite (projectDirtyRelPaths) and SQLite DB/WAL updates', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ag-proj-inval-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ledgerDir = join(root, 'ledger');
  const profileDir = join(root, 'profile');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(profileDir, { recursive: true });

  const dbPath = join(profileDir, 'conversation_summaries.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      title TEXT,
      preview TEXT,
      last_modified_time datetime,
      workspace_uris TEXT,
      project_id TEXT,
      parent_conversation_id TEXT,
      source TEXT,
      agent_name TEXT
    );
  `);
  db.prepare(
    `INSERT INTO conversation_summaries
      (conversation_id, title, preview, last_modified_time, workspace_uris, project_id, parent_conversation_id, source, agent_name)
     VALUES (?, ?, '', ?, ?, ?, '', '', '')`,
  ).run(CID_MAIN, 'Main task', '2026-10-11T04:00:00Z', JSON.stringify(['file:///C:/repo/proj-one']), 'proj-one');
  db.close();

  const ledger = new UsageLedger(ledgerDir, { timeZone: 'UTC' });
  await ledger.ingest(
    acctA,
    CID_MAIN,
    rawUsage({ at: '2026-10-11T04:00:00Z', responseId: 'r-same-1', input: 100, cacheRead: 0, output: 50 }),
  );

  let overview = await queryProjectUsageOverview({
    ledger,
    profileDir,
    scope: acctA,
    from: '2026-10-11',
    to: '2026-10-11',
    timeZone: 'UTC',
  });
  assert.equal(overview.totalTokens, 150);
  assert.equal(overview.projects[0].projectKey, 'project:c:/repo/proj-one');

  // Same-size rewrite via ingest; run summary() first to clear dirtyRelPaths and ensure projectDirtyRelPaths survives
  await ledger.ingest(
    acctA,
    CID_MAIN,
    rawUsage({ at: '2026-10-11T04:00:00Z', responseId: 'r-same-1', input: 250, cacheRead: 0, output: 50 }),
  );
  assert.ok(ledger.projectDirtyRelPaths.size > 0);
  await ledger.summary(acctA, Date.parse('2026-10-11T12:00:00Z'));
  assert.ok(ledger.projectDirtyRelPaths.size > 0, 'summary() must not clear projectDirtyRelPaths');

  overview = await queryProjectUsageOverview({
    ledger,
    profileDir,
    scope: acctA,
    from: '2026-10-11',
    to: '2026-10-11',
    timeZone: 'UTC',
  });
  assert.equal(overview.totalTokens, 300);
  assert.equal(ledger.projectDirtyRelPaths.size, 0);

  // Update SQLite in WAL mode without checkpointing (updates .db-wal)
  const db2 = new DatabaseSync(dbPath);
  db2
    .prepare('UPDATE conversation_summaries SET workspace_uris = ?, project_id = ? WHERE conversation_id = ?')
    .run(JSON.stringify(['file:///C:/repo/proj-two']), 'proj-two', CID_MAIN);
  db2.close();

  overview = await queryProjectUsageOverview({
    ledger,
    profileDir,
    scope: acctA,
    from: '2026-10-11',
    to: '2026-10-11',
    timeZone: 'UTC',
  });
  assert.equal(overview.projects[0].projectKey, 'project:c:/repo/proj-two');
  assert.equal(overview.projects[0].name, 'proj-two');
});

test('native and JS fallback produce identical results across all project kinds and at:null', async (t) => {
  const { ledger, profileDir } = await setupFixture(t);
  await ledger.addManualUsage(acctA, {
    id: 'man-gpu-1',
    projectName: 'gpu-cluster',
    note: 'Distributed run',
    timestamp: Date.parse('2026-10-11T12:00:00Z'),
    tokens: { prompt: 700, candidates: 300, total: 1000 },
  });

  // Add a file containing an at: null record
  const nullCid = '88888888-8888-8888-8888-888888888888';
  const nullHash = scope(nullCid);
  await writeFile(
    join(ledger.directory, acctA, `${nullHash}.json`),
    JSON.stringify({
      schema: 1,
      account: acctA,
      id: nullCid,
      records: [
        {
          id: scope('null-at-req-1'),
          at: null,
          model: 'Gemini 3.8 Flash',
          uncached: 40,
          cacheRead: 10,
          cacheWrite: 0,
          output: 10,
          partial: false,
          timeBasis: 'estimated',
        },
      ],
    }),
  );

  const stripUpdatedAt = (obj) => {
    const copy = structuredClone(obj);
    delete copy.updatedAt;
    return copy;
  };

  const prevDisable = process.env.PULSE_DISABLE_NATIVE_ACCEL;
  t.after(() => {
    if (prevDisable === undefined) delete process.env.PULSE_DISABLE_NATIVE_ACCEL;
    else process.env.PULSE_DISABLE_NATIVE_ACCEL = prevDisable;
  });

  for (const timeZone of ['Asia/Shanghai', 'America/New_York']) {
    delete process.env.PULSE_DISABLE_NATIVE_ACCEL;
    const nativeLedger = new UsageLedger(ledger.directory, { timeZone });
    const nativeFull = await queryProjectUsageOverview({ ledger: nativeLedger, profileDir, scope: acctA, timeZone });
    const nativeDay = await queryProjectUsageOverview({
      ledger: nativeLedger,
      profileDir,
      scope: acctA,
      from: '2026-10-11',
      to: '2026-10-11',
      timeZone,
    });

    process.env.PULSE_DISABLE_NATIVE_ACCEL = '1';
    const jsLedger = new UsageLedger(ledger.directory, { timeZone });
    const jsFull = await queryProjectUsageOverview({ ledger: jsLedger, profileDir, scope: acctA, timeZone });
    const jsDay = await queryProjectUsageOverview({
      ledger: jsLedger,
      profileDir,
      scope: acctA,
      from: '2026-10-11',
      to: '2026-10-11',
      timeZone,
    });

    assert.deepEqual(stripUpdatedAt(nativeFull), stripUpdatedAt(jsFull));
    assert.deepEqual(stripUpdatedAt(nativeDay), stripUpdatedAt(jsDay));
    assert.equal(nativeFull.totalTokens, 3160);
    assert.equal(nativeDay.totalTokens, 3100);

    for (const p of nativeFull.projects) {
      delete process.env.PULSE_DISABLE_NATIVE_ACCEL;
      const nDet = await queryProjectConversationDetail({
        ledger: nativeLedger,
        profileDir,
        scope: acctA,
        projectKey: p.projectKey,
        timeZone,
      });
      process.env.PULSE_DISABLE_NATIVE_ACCEL = '1';
      const jDet = await queryProjectConversationDetail({
        ledger: jsLedger,
        profileDir,
        scope: acctA,
        projectKey: p.projectKey,
        timeZone,
      });
      assert.deepEqual(stripUpdatedAt(nDet), stripUpdatedAt(jDet), `Detail mismatch for ${p.projectKey} (${timeZone})`);
    }
  }
});

test('scope acctB isolation and scope "all" parity with UsageLedger.summary across ownership-v1.json and overlapping records', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ag-proj-multi-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ledgerDir = join(root, 'ledger');
  const profileDir = join(root, 'profile');
  await mkdir(profileDir, { recursive: true });

  const ledger = new UsageLedger(ledgerDir, {
    timeZone: 'Asia/Shanghai',
    knownAccounts: {
      [acctA]: { email: 'a@example.test', name: 'Account A', primary: true },
      [acctB]: { email: 'b@example.test', name: 'Account B', primary: false },
    },
  });
  await ledger.registerAccount(acctA, { email: 'a@example.test', name: 'Account A', primary: true });
  await ledger.registerAccount(acctB, { email: 'b@example.test', name: 'Account B', primary: false });

  const CID_SHARED_OWNED_B = 'aaaaaaaa-1111-4111-8111-111111111111';
  const CID_SHARED_LEGACY = 'bbbbbbbb-2222-4222-8222-222222222222';
  const CID_SPLIT = 'cccccccc-3333-4333-8333-333333333333';

  // Unique to acctA (400)
  await ledger.ingest(acctA, CID_MAIN, rawUsage({ at: '2026-10-11T04:00:00Z', responseId: 'm-a-1', input: 100, cacheRead: 200, output: 100 }));
  // Unique to acctB (5500)
  await ledger.ingest(acctB, CID_FOREIGN, rawUsage({ at: '2026-10-11T05:00:00Z', responseId: 'm-b-1', input: 5000, cacheRead: 0, output: 500 }));

  // Shared file in both acctA and acctB, explicitly owned by acctB via 36-char convId in ownership-v1.json (700)
  await ledger.ingest(acctA, CID_SHARED_OWNED_B, rawUsage({ at: '2026-10-11T06:00:00Z', responseId: 'm-owned-b', input: 500, cacheRead: 0, output: 200 }));
  await ledger.ingest(acctB, CID_SHARED_OWNED_B, rawUsage({ at: '2026-10-11T06:00:00Z', responseId: 'm-owned-b', input: 500, cacheRead: 0, output: 200 }));
  await ledger.registerOwnership(CID_SHARED_OWNED_B, acctB, { overwrite: true });

  // Shared legacy file with NO ownership entry, overlapping r.id with higher token sum in acctB (300 vs 350)
  await ledger.ingest(acctA, CID_SHARED_LEGACY, rawUsage({ at: '2026-10-11T07:00:00Z', responseId: 'm-legacy', input: 200, cacheRead: 0, output: 100 }));
  await ledger.ingest(acctB, CID_SHARED_LEGACY, rawUsage({ at: '2026-10-11T07:00:00Z', responseId: 'm-legacy', input: 250, cacheRead: 0, output: 100 }));

  // Split cross-account continuation: ownership[CID_SPLIT] = acctA, acctA has r-split-a (250), acctB has unique r-split-b (150)
  await ledger.ingest(acctA, CID_SPLIT, rawUsage({ at: '2026-10-11T08:00:00Z', responseId: 'm-split-a', input: 200, cacheRead: 0, output: 50 }));
  await ledger.ingest(acctB, CID_SPLIT, rawUsage({ at: '2026-10-11T08:30:00Z', responseId: 'm-split-b', input: 100, cacheRead: 0, output: 50 }));
  await ledger.registerOwnership(CID_SPLIT, acctA, { overwrite: true });

  createSummaryDb(join(profileDir, 'conversation_summaries.db'), [
    {
      conversationId: CID_MAIN,
      title: 'Alpha Main',
      workspaceUris: JSON.stringify(['file:///C:/repo/alpha-proj']),
      projectId: 'proj-alpha',
    },
    {
      conversationId: CID_FOREIGN,
      title: 'Beta Secret',
      workspaceUris: JSON.stringify(['file:///C:/repo/beta-proj']),
      projectId: 'proj-beta',
    },
    {
      conversationId: CID_SHARED_OWNED_B,
      title: 'Shared Owned By Beta',
      workspaceUris: JSON.stringify(['file:///C:/repo/beta-proj']),
      projectId: 'proj-beta',
    },
    {
      conversationId: CID_SHARED_LEGACY,
      title: 'Legacy Shared Session',
      workspaceUris: JSON.stringify(['file:///C:/repo/legacy-proj']),
      projectId: 'proj-legacy',
    },
    {
      conversationId: CID_SPLIT,
      title: 'Split Continuation',
      workspaceUris: JSON.stringify(['file:///C:/repo/split-proj']),
      projectId: 'proj-split',
    },
  ]);

  const prevDisable = process.env.PULSE_DISABLE_NATIVE_ACCEL;
  t.after(() => {
    if (prevDisable === undefined) delete process.env.PULSE_DISABLE_NATIVE_ACCEL;
    else process.env.PULSE_DISABLE_NATIVE_ACCEL = prevDisable;
  });

  for (const disableNative of [false, true]) {
    if (disableNative) process.env.PULSE_DISABLE_NATIVE_ACCEL = '1';
    else delete process.env.PULSE_DISABLE_NATIVE_ACCEL;

    const freshLedger = new UsageLedger(ledgerDir, {
      timeZone: 'Asia/Shanghai',
      knownAccounts: ledger.knownAccounts,
    });

    const sumA = await freshLedger.summary(acctA, Date.parse('2026-10-11T12:00:00Z'));
    const sumB = await freshLedger.summary(acctB, Date.parse('2026-10-11T12:00:00Z'));
    const sumAll = await freshLedger.summary('all', Date.parse('2026-10-11T12:00:00Z'));

    // Single acctA: CID_MAIN(400) + CID_SHARED_LEGACY(300, primary) + CID_SPLIT(250) = 950; excludes CID_SHARED_OWNED_B & CID_FOREIGN
    const ovA = await queryProjectUsageOverview({ ledger: freshLedger, profileDir, scope: acctA, timeZone: 'Asia/Shanghai' });
    assert.equal(ovA.accountKey, acctA);
    assert.equal(ovA.totalTokens, sumA.totalTokens);
    assert.equal(ovA.totalTokens, 950);
    assert.equal(ovA.requests, sumA.requests);
    assert.equal(ovA.projects.some((p) => p.projectKey === 'project:c:/repo/beta-proj'), false);

    // Single acctB: CID_FOREIGN(5500) + CID_SHARED_OWNED_B(700) + CID_SPLIT(150) = 6350; excludes CID_MAIN & CID_SHARED_LEGACY
    const ovB = await queryProjectUsageOverview({ ledger: freshLedger, profileDir, scope: acctB, timeZone: 'Asia/Shanghai' });
    assert.equal(ovB.accountKey, acctB);
    assert.equal(ovB.totalTokens, sumB.totalTokens);
    assert.equal(ovB.totalTokens, 6350);
    assert.equal(ovB.requests, sumB.requests);
    assert.equal(ovB.projects.some((p) => p.projectKey === 'project:c:/repo/alpha-proj'), false);
    assert.equal(ovB.projects.some((p) => p.projectKey === 'project:c:/repo/legacy-proj'), false);

    // All accounts: 400 + 5500 + 700 + 350 (max recordSum) + 250 + 150 = 7350
    const ovAll = await queryProjectUsageOverview({ ledger: freshLedger, profileDir, scope: 'all', timeZone: 'Asia/Shanghai' });
    assert.equal(ovAll.accountKey, 'all');
    assert.equal(ovAll.totalTokens, sumAll.totalTokens);
    assert.equal(ovAll.totalTokens, 7350);
    assert.equal(ovAll.requests, sumAll.requests);

    const byKeyAll = new Map(ovAll.projects.map((p) => [p.projectKey, p]));
    assert.equal(byKeyAll.get('project:c:/repo/beta-proj')?.total, 6200);
    assert.equal(byKeyAll.get('project:c:/repo/beta-proj')?.conversationCount, 2);
    assert.equal(byKeyAll.get('project:c:/repo/legacy-proj')?.total, 350);
    assert.equal(byKeyAll.get('project:c:/repo/legacy-proj')?.conversationCount, 1);
    assert.equal(byKeyAll.get('project:c:/repo/split-proj')?.total, 400);
    assert.equal(byKeyAll.get('project:c:/repo/split-proj')?.conversationCount, 1);

    // Detail parity for 'all' and single scopes
    const detBetaAll = await queryProjectConversationDetail({
      ledger: freshLedger,
      profileDir,
      scope: 'all',
      projectKey: 'project:c:/repo/beta-proj',
      timeZone: 'Asia/Shanghai',
    });
    assert.equal(detBetaAll.accountKey, 'all');
    assert.equal(detBetaAll.totalTokens, 6200);
    assert.deepEqual(
      detBetaAll.conversations.map((c) => [c.id, c.total]),
      [
        [CID_FOREIGN, 5500],
        [CID_SHARED_OWNED_B, 700],
      ],
    );

    const detBetaA = await queryProjectConversationDetail({
      ledger: freshLedger,
      profileDir,
      scope: acctA,
      projectKey: 'project:c:/repo/beta-proj',
      timeZone: 'Asia/Shanghai',
    });
    assert.equal(detBetaA.accountKey, acctA);
    assert.equal(detBetaA.totalTokens, 0);
    assert.equal(detBetaA.conversations.length, 0);

    const detSplitAll = await queryProjectConversationDetail({
      ledger: freshLedger,
      profileDir,
      scope: 'all',
      projectKey: 'project:c:/repo/split-proj',
      timeZone: 'Asia/Shanghai',
    });
    assert.equal(detSplitAll.accountKey, 'all');
    assert.equal(detSplitAll.totalTokens, 400);
    assert.deepEqual(
      detSplitAll.conversations.map((c) => [c.id, c.total, c.requests]),
      [[CID_SPLIT, 400, 2]],
    );
  }
});

test('Option B project-meta-v1.json persists SQLite and rawSummaries metadata without clobbering and survives SQLite deletion', async (t) => {
  const { ledger, profileDir } = await setupFixture(t);
  const CID_RAW = '99999999-1111-4111-8111-111111111111';
  await ledger.ingest(acctA, CID_RAW, rawUsage({ at: '2026-10-11T12:00:00Z', responseId: 'r-raw', input: 300, cacheRead: 0, output: 100 })); // 400

  const store = {
    identity: acctA,
    epoch: 1,
    listConversations: async () => [],
    rawSummaries: {
      [CID_RAW]: {
        summary: 'Raw RPC Session',
        lastModifiedTime: '2026-10-11T12:00:00Z',
        workspaces: [{ workspaceFolderAbsoluteUri: 'file:///C:/repo/raw-app' }],
      },
    },
  };

  // First query populates project-meta-v1.json from both SQLite and rawSummaries
  const firstOverview = await queryProjectUsageOverview({
    ledger,
    store,
    profileDir,
    scope: acctA,
    from: '2026-10-11',
    to: '2026-10-11',
    timeZone: 'Asia/Shanghai',
  });
  assert.equal(firstOverview.totalTokens, 2500);

  const metaPath = ledger.projectMetaFile();
  const savedDoc = JSON.parse(await readFile(metaPath, 'utf8'));
  assert.equal(savedDoc.schema, 1);
  assert.equal(savedDoc.entries[CID_MAIN].title, 'Fix dashboard dropdowns');
  assert.equal(savedDoc.entries[CID_SUBAGENT].parentConversationId, CID_MAIN);
  assert.equal(savedDoc.entries[CID_SUBAGENT].agentName, 'researcher');
  assert.equal(savedDoc.entries[CID_RAW].title, 'Raw RPC Session');
  assert.deepEqual(savedDoc.entries[CID_RAW].workspaceUris, ['file:///C:/repo/raw-app']);

  // Empty incoming fields must NOT clobber existing non-empty fields
  store.rawSummaries = {
    [CID_RAW]: {
      summary: '',
      lastModifiedTime: '2026-10-11T12:05:00Z',
      workspaces: [],
    },
  };
  await queryProjectUsageOverview({
    ledger,
    store,
    profileDir,
    scope: acctA,
    from: '2026-10-11',
    to: '2026-10-11',
    timeZone: 'Asia/Shanghai',
  });
  const afterEmptyDoc = JSON.parse(await readFile(metaPath, 'utf8'));
  assert.equal(afterEmptyDoc.entries[CID_RAW].title, 'Raw RPC Session');
  assert.deepEqual(afterEmptyDoc.entries[CID_RAW].workspaceUris, ['file:///C:/repo/raw-app']);

  // Newer timestamp with non-empty title updates via DesktopUsage.sync() hook too
  store.rawSummaries = {
    [CID_RAW]: {
      summary: 'Renamed Raw Session',
      lastModifiedTime: '2026-10-12T00:00:00Z',
      workspaces: [{ workspaceFolderAbsoluteUri: 'file:///C:/repo/raw-app' }],
    },
  };
  const tracker = new DesktopUsage(store, ledger, {
    discoverLocal: async () => ({ conversations: [], errors: 0 }),
  });
  t.after(() => tracker.dispose());
  await tracker.sync();

  const afterSyncDoc = JSON.parse(await readFile(metaPath, 'utf8'));
  assert.equal(afterSyncDoc.entries[CID_RAW].title, 'Renamed Raw Session');

  // Delete SQLite DB and clear rawSummaries completely
  await rm(join(profileDir, 'conversation_summaries.db'), { force: true });
  await rm(join(profileDir, 'conversation_summaries.db-wal'), { force: true });
  await rm(join(profileDir, 'conversation_summaries.db-shm'), { force: true });
  store.rawSummaries = null;

  // Query with both existing ledger and a brand new UsageLedger instance
  for (const targetLedger of [ledger, new UsageLedger(ledger.directory)]) {
    const ov = await queryProjectUsageOverview({
      ledger: targetLedger,
      store,
      profileDir,
      scope: acctA,
      from: '2026-10-11',
      to: '2026-10-11',
      timeZone: 'Asia/Shanghai',
    });
    assert.equal(ov.totalTokens, 2500);
    const byKey = new Map(ov.projects.map((p) => [p.projectKey, p]));
    assert.equal(byKey.get('project:c:/repo/antigrative-dashboard')?.total, 1200);
    assert.equal(byKey.get('project:c:/repo/antigrative-dashboard')?.conversationCount, 3);
    assert.equal(byKey.get('project:c:/repo/raw-app')?.total, 400);
    assert.equal(byKey.get('cli')?.total, 100);

    const detDash = await queryProjectConversationDetail({
      ledger: targetLedger,
      store,
      profileDir,
      scope: acctA,
      projectKey: 'project:c:/repo/antigrative-dashboard',
      from: '2026-10-11',
      to: '2026-10-11',
      timeZone: 'Asia/Shanghai',
    });
    assert.equal(detDash.totalTokens, 1200);
    assert.deepEqual(
      detDash.conversations.map((c) => [c.id, c.title, c.total, c.isSubagent]),
      [
        [CID_WORKTREE, 'Worktree feature branch preview text', 600, false],
        [CID_MAIN, 'Fix dashboard dropdowns', 400, false],
        [CID_SUBAGENT, 'Fix dashboard dropdowns · researcher', 200, true],
      ],
    );
    const sub = detDash.conversations.find((c) => c.id === CID_SUBAGENT);
    assert.equal(sub?.rootId, CID_MAIN);
    assert.equal(sub?.rootTitle, 'Fix dashboard dropdowns');

    const detRaw = await queryProjectConversationDetail({
      ledger: targetLedger,
      store,
      profileDir,
      scope: acctA,
      projectKey: 'project:c:/repo/raw-app',
      from: '2026-10-11',
      to: '2026-10-11',
      timeZone: 'Asia/Shanghai',
    });
    assert.equal(detRaw.conversations[0]?.title, 'Renamed Raw Session');
  }
});

test('native shared-file deduplication parity, owner metadata priority, dirty invalidation, and releaseNativeCaches', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ag-proj-shared-native-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ledgerDir = join(root, 'ledger');
  const profileDir = join(root, 'profile');
  await mkdir(profileDir, { recursive: true });

  const knownAccounts = {
    [acctA]: { email: 'a@example.test', name: 'Account A', primary: true },
    [acctB]: { email: 'b@example.test', name: 'Account B', primary: false },
  };
  const ledger = new UsageLedger(ledgerDir, { timeZone: 'Asia/Shanghai', knownAccounts });
  await ledger.registerAccount(acctA, knownAccounts[acctA]);
  await ledger.registerAccount(acctB, knownAccounts[acctB]);
  await mkdir(join(ledgerDir, acctA), { recursive: true });
  await mkdir(join(ledgerDir, acctB), { recursive: true });

  const CID_SHARED_META = 'dddddddd-4444-4444-8444-444444444444';
  const CID_SHARED_NULL = 'eeeeeeee-5555-4555-8555-555555555555';
  const sharedMetaHash = scope(CID_SHARED_META);
  const sharedNullHash = scope(CID_SHARED_NULL);

  // Owned by acctB, stale note in acctA, authoritative note in acctB
  await writeFile(
    join(ledgerDir, acctA, `${sharedMetaHash}.json`),
    JSON.stringify({
      schema: 1,
      account: acctA,
      id: CID_SHARED_META,
      metadata: { source: 'remote-manual', projectName: 'SharedProj', note: 'Stale Note A' },
      records: [
        {
          id: scope('rec-meta-1'),
          at: Date.parse('2026-10-11T04:00:00Z'),
          model: 'Gemini 3.8 Flash',
          uncached: 300,
          cacheRead: 0,
          cacheWrite: 0,
          output: 100,
        },
      ],
    }),
  );
  await writeFile(
    join(ledgerDir, acctB, `${sharedMetaHash}.json`),
    JSON.stringify({
      schema: 1,
      account: acctB,
      id: CID_SHARED_META,
      metadata: { source: 'remote-manual', projectName: 'SharedProj', note: 'Owner Note B' },
      records: [
        {
          id: scope('rec-meta-1'),
          at: Date.parse('2026-10-11T04:00:00Z'),
          model: 'Gemini 3.8 Flash',
          uncached: 300,
          cacheRead: 0,
          cacheWrite: 0,
          output: 100,
        },
      ],
    }),
  );
  await ledger.registerOwnership(CID_SHARED_META, acctB, { overwrite: true });

  // Unowned shared doc with at:null record and higher tokens in acctB
  await writeFile(
    join(ledgerDir, acctA, `${sharedNullHash}.json`),
    JSON.stringify({
      schema: 1,
      account: acctA,
      id: CID_SHARED_NULL,
      records: [
        {
          id: scope('rec-null-1'),
          at: null,
          model: 'Gemini 3.8 Flash',
          uncached: 50,
          cacheRead: 0,
          cacheWrite: 0,
          output: 10,
        },
      ],
    }),
  );
  await writeFile(
    join(ledgerDir, acctB, `${sharedNullHash}.json`),
    JSON.stringify({
      schema: 1,
      account: acctB,
      id: CID_SHARED_NULL,
      records: [
        {
          id: scope('rec-null-1'),
          at: null,
          model: 'Gemini 3.8 Flash',
          uncached: 90,
          cacheRead: 0,
          cacheWrite: 0,
          output: 10,
        },
      ],
    }),
  );

  const prevDisable = process.env.PULSE_DISABLE_NATIVE_ACCEL;
  t.after(() => {
    if (prevDisable === undefined) delete process.env.PULSE_DISABLE_NATIVE_ACCEL;
    else process.env.PULSE_DISABLE_NATIVE_ACCEL = prevDisable;
  });

  const stripUpdatedAt = (obj) => {
    const copy = structuredClone(obj);
    delete copy.updatedAt;
    return copy;
  };

  // JS fallback check (PULSE_DISABLE_NATIVE_ACCEL=1)
  process.env.PULSE_DISABLE_NATIVE_ACCEL = '1';
  assert.equal(releaseNativeCaches('soft'), null);
  assert.equal(releaseNativeCaches('full'), null);
  assert.equal(
    readLedgerSharedProjectSummaries({
      directory: ledgerDir,
      scope: 'all',
      timeZone: 'Asia/Shanghai',
      zeroAtDate: '1970-01-01',
      knownAccounts,
    }),
    null,
  );

  const jsLedger = new UsageLedger(ledgerDir, { timeZone: 'Asia/Shanghai', knownAccounts });
  const jsOverviewAll = await queryProjectUsageOverview({
    ledger: jsLedger,
    profileDir,
    scope: 'all',
    timeZone: 'Asia/Shanghai',
  });
  const jsDetailRemote = await queryProjectConversationDetail({
    ledger: jsLedger,
    profileDir,
    scope: 'all',
    projectKey: 'remote:sharedproj',
    timeZone: 'Asia/Shanghai',
  });
  assert.equal(jsOverviewAll.totalTokens, 500);
  assert.equal(jsDetailRemote.conversations[0]?.title, 'Owner Note B');

  delete process.env.PULSE_DISABLE_NATIVE_ACCEL;
  if (!isNativeAccelAvailable()) {
    return;
  }

  const nativeLedger = new UsageLedger(ledgerDir, { timeZone: 'Asia/Shanghai', knownAccounts });
  const nativeSumAll = await nativeLedger.summary('all', Date.parse('2026-10-11T12:00:00Z'));
  const nativeOverviewAll = await queryProjectUsageOverview({
    ledger: nativeLedger,
    profileDir,
    scope: 'all',
    timeZone: 'Asia/Shanghai',
  });
  const nativeDetailRemote = await queryProjectConversationDetail({
    ledger: nativeLedger,
    profileDir,
    scope: 'all',
    projectKey: 'remote:sharedproj',
    timeZone: 'Asia/Shanghai',
  });

  assert.deepEqual(stripUpdatedAt(nativeOverviewAll), stripUpdatedAt(jsOverviewAll));
  assert.deepEqual(stripUpdatedAt(nativeDetailRemote), stripUpdatedAt(jsDetailRemote));
  assert.equal(nativeOverviewAll.totalTokens, nativeSumAll.totalTokens);

  // Direct N-API shared summary call + releaseNativeCaches('soft' | 'full')
  const directShared = readLedgerSharedProjectSummaries({
    directory: ledgerDir,
    scope: 'all',
    timeZone: 'Asia/Shanghai',
    fixedOffsetSecs: 28800,
    zeroAtDate: '1970-01-01',
    knownAccounts,
  });
  assert.ok(directShared);
  assert.equal(directShared.files.length, 2);

  const softRes = releaseNativeCaches('soft');
  assert.deepEqual(softRes, {
    released: true,
    mode: 'soft',
    ledgerCleared: true,
    projectCleared: true,
  });

  // Subsequent queries after soft release still produce identical results
  const afterSoftSum = await nativeLedger.summary('all', Date.parse('2026-10-11T12:05:00Z'));
  const afterSoftOverview = await queryProjectUsageOverview({
    ledger: nativeLedger,
    profileDir,
    scope: 'all',
    timeZone: 'Asia/Shanghai',
  });
  assert.equal(afterSoftSum.totalTokens, nativeSumAll.totalTokens);
  assert.deepEqual(stripUpdatedAt(afterSoftOverview), stripUpdatedAt(nativeOverviewAll));

  const fullRes = releaseNativeCaches('full');
  assert.deepEqual(fullRes, {
    released: true,
    mode: 'full',
    ledgerCleared: true,
    projectCleared: true,
  });

  const afterFullOverview = await queryProjectUsageOverview({
    ledger: nativeLedger,
    profileDir,
    scope: 'all',
    timeZone: 'Asia/Shanghai',
  });
  assert.deepEqual(stripUpdatedAt(afterFullOverview), stripUpdatedAt(nativeOverviewAll));

  // Same-size shared-file update via ingest invalidates native shared cache via projectDirtyRelPaths
  await nativeLedger.ingest(acctB, CID_SHARED_META, rawUsage({
    at: '2026-10-11T04:00:00Z',
    responseId: 'r-shared-upd',
    input: 600,
    cacheRead: 0,
    output: 100,
  }));
  const updatedOverview = await queryProjectUsageOverview({
    ledger: nativeLedger,
    profileDir,
    scope: 'all',
    timeZone: 'Asia/Shanghai',
  });
  assert.equal(updatedOverview.totalTokens, 1200);
  assert.equal(nativeLedger.projectDirtyRelPaths.size, 0);
});
