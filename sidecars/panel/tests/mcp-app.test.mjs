import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createPulseMcpHandler } from '../../../mcp/server.mjs';
import { UsageLedger } from '../usage.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SERVER_PATH = join(ROOT, 'mcp', 'server.mjs');
const USAGE_RESOURCE_URI = 'ui://antigravity-pulse/usage.html';
const MCP_APP_MIME = 'text/html;profile=mcp-app';

function createStdioMcpClient(t) {
  const tempRoot = mkdtempSync(join(tmpdir(), 'ag-mcp-app-test-'));
  const home = join(tempRoot, 'home');
  const dataDir = join(tempRoot, 'data');
  mkdirSync(home, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      LOCALAPPDATA: join(home, 'AppData', 'Local'),
      APPDATA: join(home, 'AppData', 'Roaming'),
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_DATA_HOME: join(home, '.local', 'share'),
      ANTIGRAVITY_EXECUTABLE_DATA_DIR: dataDir,
      ANTIGRAVITY_LS_ADDRESS: '',
      ANTIGRAVITY_CSRF_TOKEN: '',
    },
  });

  const pending = new Map();
  const stderrChunks = [];
  const invalidStdoutLines = [];
  let nextId = 1;

  child.stderr.on('data', (chunk) => {
    stderrChunks.push(chunk.toString('utf8'));
  });

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      invalidStdoutLines.push(line);
      return;
    }
    if (msg && Object.prototype.hasOwnProperty.call(msg, 'id') && pending.has(msg.id)) {
      const entry = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(entry.timer);
      entry.resolve(msg);
    }
  });

  child.on('exit', (code, signal) => {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(
        new Error(
          `MCP server exited prematurely (code=${code}, signal=${signal}). stderr:\n${stderrChunks.join('')}`,
        ),
      );
    }
    pending.clear();
  });

  t.after(async () => {
    rl.close();
    if (!child.killed) {
      child.stdin.end();
      await new Promise((resolveExit) => {
        const killTimer = setTimeout(() => {
          try {
            child.kill();
          } catch {}
          resolveExit();
        }, 1500);
        child.once('exit', () => {
          clearTimeout(killTimer);
          resolveExit();
        });
      });
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  function sendRaw(payload) {
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  function request(method, params = undefined, timeoutMs = 15000) {
    const id = nextId++;
    const payload = { jsonrpc: '2.0', id, method };
    if (params !== undefined) payload.params = params;
    return new Promise((resolveReq, rejectReq) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectReq(
          new Error(`Timed out waiting for ${method} (id=${id}). stderr:\n${stderrChunks.join('')}`),
        );
      }, timeoutMs);
      pending.set(id, { resolve: resolveReq, reject: rejectReq, timer });
      sendRaw(payload);
    });
  }

  function notify(method, params = undefined) {
    const payload = { jsonrpc: '2.0', method };
    if (params !== undefined) payload.params = params;
    sendRaw(payload);
  }

  return {
    request,
    notify,
    getInvalidStdoutLines: () => [...invalidStdoutLines],
    getStderr: () => stderrChunks.join(''),
  };
}

test('MCP server stdio handshake, tool metadata, UI resource, and actions work end-to-end', async (t) => {
  const client = createStdioMcpClient(t);

  // 1. initialize + notifications/initialized + ping
  const initRes = await client.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {
      extensions: {
        'io.modelcontextprotocol/ui': { mimeTypes: [MCP_APP_MIME] },
        'com.google.antigravity/ui': {},
      },
    },
    clientInfo: { name: 'mcp-app-test', version: '1.0.0' },
  });
  assert.equal(initRes.error, undefined, `initialize failed: ${JSON.stringify(initRes.error)}`);
  assert.equal(initRes.result.protocolVersion, '2025-06-18');
  assert.ok(initRes.result.capabilities?.tools, 'initialize must advertise tools capability');
  assert.ok(initRes.result.capabilities?.resources, 'initialize must advertise resources capability');

  client.notify('notifications/initialized', {});
  client.notify('notifications/unknown_noop', { ignore: true });

  const pingRes = await client.request('ping');
  assert.equal(pingRes.error, undefined, `ping failed: ${JSON.stringify(pingRes.error)}`);
  assert.deepEqual(pingRes.result, {});

  // 2. tools/list surface and MCP App metadata
  const toolsRes = await client.request('tools/list');
  assert.equal(toolsRes.error, undefined);
  const tools = toolsRes.result?.tools ?? [];
  const toolNames = tools.map((item) => item.name).sort();
  assert.deepEqual(toolNames, [
    'get_quota_and_session',
    'open_usage_dashboard',
    'pulse_usage_action',
    'query_usage_stats',
  ]);

  const openTool = tools.find((item) => item.name === 'open_usage_dashboard');
  assert.equal(openTool._meta?.ui?.resourceUri, USAGE_RESOURCE_URI);
  const entrypoints = openTool._meta?.['com.google.antigravity/ui']?.entrypoints ?? [];
  assert.ok(
    entrypoints.some((ep) => ep && ep.type === 'global' && ep.title === 'Token Usage'),
    `Expected global Token Usage entrypoint, got ${JSON.stringify(entrypoints)}`,
  );
  assert.deepEqual(openTool.inputSchema?.required ?? [], []);

  const actionTool = tools.find((item) => item.name === 'pulse_usage_action');
  assert.deepEqual(actionTool._meta?.ui?.visibility, ['app']);

  // 3. resources/list and resources/read for single-file usage HTML
  const resourcesRes = await client.request('resources/list');
  assert.equal(resourcesRes.error, undefined);
  const usageResource = (resourcesRes.result?.resources ?? []).find(
    (item) => item.uri === USAGE_RESOURCE_URI,
  );
  assert.ok(usageResource, `Expected ${USAGE_RESOURCE_URI} in resources/list`);
  assert.equal(usageResource.mimeType, MCP_APP_MIME);

  const readRes = await client.request('resources/read', { uri: USAGE_RESOURCE_URI });
  assert.equal(readRes.error, undefined);
  const contentItem = readRes.result?.contents?.[0];
  assert.ok(contentItem, 'resources/read must return at least one content item');
  assert.equal(contentItem.uri, USAGE_RESOURCE_URI);
  assert.equal(contentItem.mimeType, MCP_APP_MIME);
  assert.equal(typeof contentItem.text, 'string');
  const htmlBytes = Buffer.byteLength(contentItem.text, 'utf8');
  assert.ok(htmlBytes > 0, 'usage.html must be non-empty');
  assert.ok(htmlBytes < 1024 * 1024, `usage.html must be < 1 MiB, got ${htmlBytes} bytes`);
  assert.match(contentItem.text, /<!doctype html>/i);
  assert.doesNotMatch(contentItem.text, /<script\b[^>]*\bsrc\s*=/i);
  assert.doesNotMatch(contentItem.text, /<link\b[^>]*\bhref\s*=/i);

  // 4. open_usage_dashboard with empty arguments {}
  const openRes = await client.request('tools/call', {
    name: 'open_usage_dashboard',
    arguments: {},
  });
  assert.equal(openRes.error, undefined);
  assert.notEqual(openRes.result?.isError, true);
  assert.ok(openRes.result?.content?.[0]?.text?.length > 0);
  assert.equal(openRes.result?.structuredContent?.ok, true);
  assert.ok(
    openRes.result.structuredContent.deferred === true ||
      Boolean(openRes.result.structuredContent.initial?.usage),
    'open_usage_dashboard must return initial payload or deferred: true',
  );

  // 5. query_usage_stats
  const statsRes = await client.request('tools/call', {
    name: 'query_usage_stats',
    arguments: { period: 'month', dimension: 'model' },
  });
  assert.equal(statsRes.error, undefined);
  assert.notEqual(statsRes.result?.isError, true);
  assert.ok(statsRes.result?.content?.[0]?.text?.length > 0);
  assert.equal(typeof statsRes.result?.structuredContent, 'object');

  // 6. get_quota_and_session
  const quotaRes = await client.request('tools/call', {
    name: 'get_quota_and_session',
    arguments: {},
  });
  assert.equal(quotaRes.error, undefined);
  assert.notEqual(quotaRes.result?.isError, true);
  assert.ok(quotaRes.result?.content?.[0]?.text?.length > 0);
  assert.equal(typeof quotaRes.result?.structuredContent, 'object');
  assert.ok('connection' in quotaRes.result.structuredContent);

  // 7. pulse_usage_action: get_snapshot, preferences round-trip, manual usage CRUD, get_accounts
  const snapRes = await client.request('tools/call', {
    name: 'pulse_usage_action',
    arguments: { action: 'get_snapshot', payload: {} },
  });
  assert.equal(snapRes.error, undefined);
  assert.notEqual(snapRes.result?.isError, true);
  assert.equal(snapRes.result?.structuredContent?.ok, true);
  assert.ok(snapRes.result?.structuredContent?.data?.usage);
  assert.ok(snapRes.result?.structuredContent?.data?.preferences);
  assert.ok(snapRes.result?.structuredContent?.data?.theme);

  const setPrefRes = await client.request('tools/call', {
    name: 'pulse_usage_action',
    arguments: {
      action: 'set_preferences',
      payload: { language: 'en', usageFontScale: 1.05 },
    },
  });
  assert.equal(setPrefRes.error, undefined);
  assert.notEqual(setPrefRes.result?.isError, true, JSON.stringify(setPrefRes.result));
  assert.equal(setPrefRes.result?.structuredContent?.ok, true);

  const getPrefRes = await client.request('tools/call', {
    name: 'pulse_usage_action',
    arguments: { action: 'get_preferences' },
  });
  assert.equal(getPrefRes.error, undefined);
  assert.notEqual(getPrefRes.result?.isError, true, JSON.stringify(getPrefRes.result));
  assert.equal(getPrefRes.result?.structuredContent?.ok, true);
  assert.equal(getPrefRes.result?.structuredContent?.data?.language, 'en');
  assert.equal(getPrefRes.result?.structuredContent?.data?.usageFontScale, 1.05);

  const accountsRes = await client.request('tools/call', {
    name: 'pulse_usage_action',
    arguments: { action: 'get_accounts' },
  });
  assert.equal(accountsRes.error, undefined);
  assert.notEqual(accountsRes.result?.isError, true);
  assert.equal(accountsRes.result?.structuredContent?.ok, true);

  const addManualRes = await client.request('tools/call', {
    name: 'pulse_usage_action',
    arguments: {
      action: 'add_manual_usage',
      payload: {
        model: 'Gemini 2.5 Pro',
        prompt: 1200,
        output: 300,
        projectName: 'mcp-test-project',
        note: 'automated-test',
        timestamp: Date.now(),
      },
    },
  });
  assert.equal(addManualRes.error, undefined);
  assert.notEqual(addManualRes.result?.isError, true);
  assert.equal(addManualRes.result?.structuredContent?.ok, true);

  const snapAfterAdd = await client.request('tools/call', {
    name: 'pulse_usage_action',
    arguments: { action: 'get_snapshot', payload: {} },
  });
  const manualEntries = snapAfterAdd.result?.structuredContent?.data?.usage?.manualEntries ?? [];
  const added = manualEntries.find((entry) => entry.note === 'automated-test');
  assert.ok(added?.id, `Expected manual usage entry in snapshot, got ${JSON.stringify(manualEntries)}`);

  const delManualRes = await client.request('tools/call', {
    name: 'pulse_usage_action',
    arguments: {
      action: 'delete_manual_usage',
      payload: { id: added.id, scope: added.account || '' },
    },
  });
  assert.equal(delManualRes.error, undefined);
  assert.notEqual(delManualRes.result?.isError, true);
  assert.equal(delManualRes.result?.structuredContent?.ok, true);

  const snapAfterDel = await client.request('tools/call', {
    name: 'pulse_usage_action',
    arguments: { action: 'get_snapshot', payload: {} },
  });
  const remaining = snapAfterDel.result?.structuredContent?.data?.usage?.manualEntries ?? [];
  assert.equal(
    remaining.some((entry) => entry.id === added.id),
    false,
    'Deleted manual usage entry should no longer appear in snapshot',
  );

  // Unknown action returns structured isError
  const badActionRes = await client.request('tools/call', {
    name: 'pulse_usage_action',
    arguments: { action: 'nonexistent_action_xyz' },
  });
  assert.equal(badActionRes.error, undefined);
  assert.equal(badActionRes.result?.isError, true);
  assert.equal(badActionRes.result?.structuredContent?.ok, false);

  // Strict stdout hygiene: zero non-JSON lines emitted to stdout
  assert.deepEqual(client.getInvalidStdoutLines(), []);
});

function createIsolatedPaths(rootDir) {
  const home = join(rootDir, 'home');
  const data = join(rootDir, 'data');
  const settings = join(rootDir, 'settings', 'settings.json');
  const pluginConfig = join(rootDir, 'plugin', 'config.json');
  mkdirSync(home, { recursive: true });
  mkdirSync(data, { recursive: true });
  mkdirSync(dirname(settings), { recursive: true });
  mkdirSync(dirname(pluginConfig), { recursive: true });
  return {
    home,
    local: data,
    config: dirname(settings),
    profile: 'mcp-test-profile',
    log: join(data, 'pulse.log'),
    logCandidates: [],
    settings,
    backups: join(data, 'backups'),
    appAsar: '',
    pluginDir: join(rootDir, 'plugin'),
    pluginConfig,
    data,
    isIsolatedVertex: false,
  };
}

test('initialize, tools/list, and resources/list load zero heavy modules; open_usage_dashboard & query_usage_stats avoid MetricsStore', async (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'ag-mcp-lazy-'));
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }));
  const paths = createIsolatedPaths(tempRoot);

  const script = `
    import { registerHooks } from 'node:module';
    const loadedUrls = [];
    registerHooks({
      resolve(specifier, context, nextResolve) {
        const res = nextResolve(specifier, context);
        if (!res.url.startsWith('node:')) loadedUrls.push(res.url);
        return res;
      },
    });
    const { createPulseMcpHandler } = await import(${JSON.stringify(pathToFileURL(SERVER_PATH).href)});
    const handler = createPulseMcpHandler({
      paths: ${JSON.stringify(paths)},
      readTheme: async () => ({}),
      idleDisposeMs: 0,
    });
    const initRes = await handler.handleMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {} },
    });
    await handler.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const toolsRes = await handler.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const resourcesRes = await handler.handleMessage({ jsonrpc: '2.0', id: 3, method: 'resources/list' });
    const afterDiscovery = [...loadedUrls];

    const openRes = await handler.handleMessage({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'open_usage_dashboard', arguments: {} },
    });
    const statsModelRes = await handler.handleMessage({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'query_usage_stats', arguments: { period: 'month', dimension: 'model' } },
    });
    const statsProjectRes = await handler.handleMessage({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'query_usage_stats', arguments: { period: 'month', dimension: 'project' } },
    });
    const afterUsageCalls = [...loadedUrls];

    handler.dispose();
    console.log(JSON.stringify({
      initOk: !initRes.error,
      toolCount: toolsRes.result?.tools?.length ?? 0,
      resourceCount: resourcesRes.result?.resources?.length ?? 0,
      openOk: openRes.result?.structuredContent?.ok === true,
      statsModelOk: statsModelRes.result?.structuredContent?.ok === true,
      statsProjectOk: statsProjectRes.result?.structuredContent?.ok === true,
      afterDiscovery,
      afterUsageCalls,
    }));
  `;

  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: paths.home,
      USERPROFILE: paths.home,
      ANTIGRAVITY_EXECUTABLE_DATA_DIR: paths.data,
      PULSE_DISABLE_NATIVE_ACCEL: '1',
    },
  });
  assert.equal(res.status, 0, `Child failed: ${res.stderr}`);
  const summary = JSON.parse(res.stdout.trim().split(/\r?\n/).pop());
  assert.equal(summary.initOk, true);
  assert.equal(summary.toolCount, 4);
  assert.equal(summary.resourceCount, 1);
  assert.equal(summary.openOk, true);
  assert.equal(summary.statsModelOk, true);
  assert.equal(summary.statsProjectOk, true);

  const heavyOnDiscovery = summary.afterDiscovery.filter((u) =>
    /(?:usage|store|preferences|host-theme|local-conversations|platform)\.(?:mjs|ts)$/i.test(u),
  );
  assert.deepEqual(
    heavyOnDiscovery,
    [],
    `initialize/tools/list/resources/list must not load heavy modules, got: ${JSON.stringify(heavyOnDiscovery)}`,
  );

  const storeLoadedDuringUsage = summary.afterUsageCalls.filter((u) =>
    /(?:^|\/)store\.mjs$|telemetry\/store\/index\.ts$/i.test(u),
  );
  assert.deepEqual(
    storeLoadedDuringUsage,
    [],
    `open_usage_dashboard and query_usage_stats must not load/instantiate MetricsStore, got: ${JSON.stringify(storeLoadedDuringUsage)}`,
  );
});

test('open_usage_dashboard resolves active account from ledger without MetricsStore', async (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'ag-mcp-account-'));
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }));
  const paths = createIsolatedPaths(tempRoot);
  const ledger = new UsageLedger(join(paths.data, 'usage-v1'));
  const scopeHash = createHash('sha256').update('mcp-local-user@example.test').digest('hex');
  await ledger.registerAccount(scopeHash, { email: 'mcp-local-user@example.test', name: 'MCP Local', primary: true });
  await ledger.setActiveLocalAccount(scopeHash);

  const handler = createPulseMcpHandler({
    paths,
    ledger,
    readTheme: async () => ({}),
    idleDisposeMs: 0,
  });
  t.after(() => handler.dispose());

  const openRes = await handler.handleMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'open_usage_dashboard', arguments: {} },
  });
  assert.equal(openRes.error, undefined);
  assert.equal(openRes.result?.structuredContent?.ok, true);
  const usageSnap = openRes.result?.structuredContent?.initial?.usage;
  assert.equal(usageSnap?.recordingAccount, scopeHash);
  assert.equal(usageSnap?.activeAccount, scopeHash);
});

test('idle teardown skips while in-flight, disposes caches after idleDisposeMs, and re-initializes cleanly on subsequent calls', async (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'ag-mcp-idle-'));
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }));
  const paths = createIsolatedPaths(tempRoot);

  // 1. In-flight guard & dispose verification using injected doubles
  let storeDisposes = 0;
  let usageDisposes = 0;
  let releaseSnapshot;
  const snapshotGate = new Promise((resolveGate) => {
    releaseSnapshot = resolveGate;
  });

  const fakeStore = {
    identity: null,
    epoch: 0,
    localFallbackActive: false,
    usagePersistenceError: false,
    rawSummaries: null,
    setModelTimelineEnabled() {},
    async snapshot() {
      await snapshotGate;
      return {
        connection: 'offline',
        source: 'test',
        error: null,
        sessionError: null,
        quotaUpdatedAt: null,
        serverTime: new Date().toISOString(),
        groups: [],
        speed: null,
        conversations: [],
        persistenceError: null,
      };
    },
    dispose() {
      storeDisposes += 1;
    },
  };
  const fakeUsage = {
    viewScope: 'all',
    dispose() {
      usageDisposes += 1;
    },
  };
  const fakeLedger = {
    timeZone: 'Asia/Shanghai',
    cache: { stale: true },
    fileIndex: new Map([['a', new Map()]]),
    metaCache: {},
    ownershipCache: {},
    dirtyRelPaths: new Set(),
    projectDirtyRelPaths: new Set(),
    keyVersions: new Map(),
    async summary() {
      return {
        today: '2026-11-27',
        todayTokens: 0,
        weekTokens: 0,
        monthTokens: 0,
        totalTokens: 0,
        requests: 0,
        unknownTokens: 0,
        unknownRequests: 0,
        partialRequests: 0,
        unreadableFiles: 0,
        days: [],
        manualEntries: [],
        userMeta: {},
        updatedAt: new Date().toISOString(),
      };
    },
    async getAccounts() {
      return [];
    },
    async getActiveLocalAccount() {
      return null;
    },
  };

  const spyHandler = createPulseMcpHandler({
    paths,
    store: fakeStore,
    usage: fakeUsage,
    ledger: fakeLedger,
    readTheme: async () => ({}),
    idleDisposeMs: 40,
  });
  t.after(() => spyHandler.dispose());

  const inFlightReq = spyHandler.handleMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'get_quota_and_session', arguments: {} },
  });

  await delay(90);
  assert.equal(storeDisposes, 0, 'Idle teardown must NOT fire while a tool call is in-flight');
  assert.equal(usageDisposes, 0, 'Idle teardown must NOT dispose usage while in-flight');

  releaseSnapshot();
  const inFlightRes = await inFlightReq;
  assert.equal(inFlightRes.error, undefined);
  assert.equal(inFlightRes.result?.structuredContent?.connection, 'offline');

  await delay(90);
  assert.equal(storeDisposes, 1, 'Idle teardown should dispose store after idleDisposeMs');
  assert.equal(usageDisposes, 1, 'Idle teardown should dispose usage after idleDisposeMs');
  assert.equal(fakeLedger.cache, null, 'Idle teardown should clear ledger in-memory cache');
  assert.equal(fakeLedger.fileIndex.size, 0, 'Idle teardown should clear ledger fileIndex');

  // 2. Real backend caches re-initialize transparently after idle teardown
  const realHandler = createPulseMcpHandler({
    paths,
    readTheme: async () => ({}),
    idleDisposeMs: 35,
  });
  t.after(() => realHandler.dispose());

  const firstOpen = await realHandler.handleMessage({
    jsonrpc: '2.0',
    id: 10,
    method: 'tools/call',
    params: { name: 'open_usage_dashboard', arguments: {} },
  });
  assert.equal(firstOpen.result?.structuredContent?.ok, true);

  await delay(85);

  const secondOpen = await realHandler.handleMessage({
    jsonrpc: '2.0',
    id: 11,
    method: 'tools/call',
    params: { name: 'open_usage_dashboard', arguments: {} },
  });
  assert.equal(secondOpen.error, undefined);
  assert.equal(secondOpen.result?.structuredContent?.ok, true);
  assert.ok(secondOpen.result?.structuredContent?.initial?.usage);

  const afterStats = await realHandler.handleMessage({
    jsonrpc: '2.0',
    id: 12,
    method: 'tools/call',
    params: { name: 'query_usage_stats', arguments: { period: 'month', dimension: 'model' } },
  });
  assert.equal(afterStats.error, undefined);
  assert.equal(afterStats.result?.structuredContent?.ok, true);

  realHandler.dispose();
  realHandler.dispose();
});
