import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

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
