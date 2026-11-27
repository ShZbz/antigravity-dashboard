import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import type {
  AddAccountRequest,
  DeleteManualUsageRequest,
  IntegrationHealth,
  ManualUsageInput,
  MetricsRequestInput,
  MetricsSnapshot,
  PreferencesUpdateInput,
  ReassignConversationRequest,
  SetRecordingAccountRequest,
  SwitchAccountRequest,
} from '../contracts/index.ts';
import type { RuntimePreferencesBridge } from '../ui/runtime-ui/index.ts';
import { panelAppSource, panelPageSource } from './panel-source.ts';
import type { MetricsStore } from './store/index.ts';

export interface PreviewUsageBridge {
  addManualUsage: (input?: { scope?: string; data?: ManualUsageInput } & Partial<ManualUsageInput>) => Promise<unknown>;
  deleteManualUsage: (input?: DeleteManualUsageRequest) => Promise<unknown>;
  getAccounts: () => Promise<unknown>;
  switchAccount: (input?: SwitchAccountRequest) => Promise<unknown>;
  getRecordingAccount?: () => Promise<unknown>;
  setRecordingAccount?: (input?: SetRecordingAccountRequest) => Promise<unknown>;
  addAccount?: (input?: AddAccountRequest) => Promise<unknown>;
  reassignConversation?: (input: ReassignConversationRequest) => Promise<unknown>;
  getProjectUsage: (input?: { scope?: string | null; from?: string; to?: string }) => Promise<unknown>;
  getProjectDetail: (input: { projectKey: string; scope?: string | null; from?: string; to?: string }) => Promise<unknown>;
}

export type PreviewMetricsRequestInput = MetricsRequestInput & { includeUsage?: boolean };

export interface PreviewServerOptions {
  here: string;
  port: number;
  guidPattern: RegExp;
  staticFiles: Record<string, [string, string]>;
  livePreferences: Required<RuntimePreferencesBridge>;
  store: MetricsStore;
  metrics: (input?: PreviewMetricsRequestInput) => Promise<MetricsSnapshot>;
  getHealth: () => IntegrationHealth;
  usageBridge?: PreviewUsageBridge;
  i18nModule: () => string;
  themeModule: () => string;
  usageUiModule?: () => string;
  themeCss: () => string;
  inlineSource: () => string;
}

const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const assetCacheControl = (pathname: string, url: URL): string => {
  if (pathname === '/' || pathname.startsWith('/toolbar-preview')) return 'no-cache';
  const version = url.searchParams.get('v');
  return version && version.length > 0 ? IMMUTABLE_CACHE_CONTROL : 'no-cache';
};

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const prefError = (error: unknown): string => {
  const msg = errorMessage(error);
  return msg === 'Invalid timeline preference' ||
    msg === 'Invalid font scale preference' ||
    msg === 'Invalid debug launch preference'
    ? msg
    : 'Language preference could not be saved';
};

function parseClearConversationId(data: unknown, guidPattern: RegExp): string | null {
  if (data != null && (typeof data !== 'object' || Array.isArray(data))) throw new Error('Invalid clear timeline request');
  const cid = (data as { conversationId?: unknown } | null)?.conversationId;
  if (cid != null && (typeof cid !== 'string' || !guidPattern.test(cid))) throw new Error('Invalid conversation ID');
  return typeof cid === 'string' ? cid : null;
}

async function readJsonBody(
  req: { [Symbol.asyncIterator](): AsyncIterableIterator<unknown> },
  maxBytes: number,
  tooLargeMsg: string,
): Promise<string> {
  let body = '';
  for await (const chunk of req) {
    body += String(chunk);
    if (body.length > maxBytes) throw new Error(tooLargeMsg);
  }
  return body;
}

export function startPreviewServer(options: PreviewServerOptions): Server {
  const {
    here, port, guidPattern, staticFiles, livePreferences, store,
    metrics, getHealth, usageBridge, i18nModule, themeModule, usageUiModule, themeCss, inlineSource,
  } = options;
  const server = createServer(async (req, res) => {
    const rawHost = req.headers.host;
    const host = Array.isArray(rawHost) ? rawHost[0] || '' : rawHost || '';
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) { res.writeHead(403); res.end(); return; }
    const url = new URL(req.url || '/', `http://${host}`);
    const sameOrigin = req.headers.origin === `http://${host}`;
    if (
      url.pathname === '/api/preferences' ||
      url.pathname === '/api/timeline/clear' ||
      url.pathname === '/api/debug-launch' ||
      url.pathname === '/api/usage/open' ||
      url.pathname.startsWith('/api/usage/')
    ) {
      if (req.headers.origin && !sameOrigin) { res.writeHead(403); res.end(); return; }
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      if (url.pathname === '/api/preferences' && req.method === 'GET') {
        res.end(JSON.stringify(await livePreferences.snapshot()));
        return;
      }
      if (url.pathname === '/api/debug-launch' && req.method === 'GET') {
        const snap = await livePreferences.snapshot();
        const enabled = !('error' in snap) && snap.debugLaunchEnabled === true;
        res.end(JSON.stringify({ enabled, configured: enabled, activePortPresent: false, platform: process.platform }));
        return;
      }
      if (url.pathname === '/api/usage/recording-account' && req.method === 'GET' && usageBridge?.getRecordingAccount) {
        res.end(JSON.stringify(await usageBridge.getRecordingAccount()));
        return;
      }
      if (req.method === 'POST' && sameOrigin) {
        const isJson = String(req.headers['content-type']).startsWith('application/json');
        if (url.pathname === '/api/preferences' && !isJson) { res.writeHead(405); res.end(); return; }
        try {
          const body = await readJsonBody(req, 4096, url.pathname === '/api/preferences' ? 'Preference payload too large' : 'Payload too large');
          if (url.pathname === '/api/preferences') {
            res.end(JSON.stringify(await livePreferences.set(JSON.parse(body) as PreferencesUpdateInput)));
          } else if (url.pathname === '/api/debug-launch') {
            const parsed = JSON.parse(body || '{}') as { enabled?: unknown };
            if (typeof parsed.enabled !== 'boolean') throw new Error('Invalid debug launch preference');
            const saved = await livePreferences.set({ debugLaunchEnabled: parsed.enabled });
            res.end(JSON.stringify({ enabled: parsed.enabled, configured: parsed.enabled, activePortPresent: false, platform: process.platform, preferences: saved }));
          } else if (url.pathname === '/api/usage/open') {
            res.end(JSON.stringify({ openedInHost: false }));
          } else if (url.pathname.startsWith('/api/usage/') && usageBridge) {
            const parsed = body.trim() ? JSON.parse(body) : {};
            if (url.pathname === '/api/usage/accounts') res.end(JSON.stringify(await usageBridge.getAccounts()));
            else if (url.pathname === '/api/usage/switch-account') res.end(JSON.stringify(await usageBridge.switchAccount(parsed)));
            else if (url.pathname === '/api/usage/recording-account' && usageBridge.setRecordingAccount) res.end(JSON.stringify(await usageBridge.setRecordingAccount(parsed)));
            else if (url.pathname === '/api/usage/accounts/add' && usageBridge.addAccount) res.end(JSON.stringify(await usageBridge.addAccount(parsed)));
            else if (url.pathname === '/api/usage/reassign-conversation' && usageBridge.reassignConversation) res.end(JSON.stringify(await usageBridge.reassignConversation(parsed)));
            else if (url.pathname === '/api/usage/manual/add') res.end(JSON.stringify(await usageBridge.addManualUsage(parsed)));
            else if (url.pathname === '/api/usage/manual/delete') res.end(JSON.stringify(await usageBridge.deleteManualUsage(parsed)));
            else if (url.pathname === '/api/usage/project-overview') res.end(JSON.stringify(await usageBridge.getProjectUsage(parsed)));
            else if (url.pathname === '/api/usage/project-detail') res.end(JSON.stringify(await usageBridge.getProjectDetail(parsed)));
            else { res.writeHead(404); res.end(); }
          } else if (url.pathname === '/api/timeline/clear') {
            let parsed: unknown = {};
            if (body.trim()) {
              if (!isJson) throw new Error('Invalid content type');
              parsed = JSON.parse(body);
            }
            res.end(JSON.stringify(await store.clearTimeline(parseClearConversationId(parsed, guidPattern))));
          } else {
            res.writeHead(404); res.end();
          }
        } catch (error) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: url.pathname === '/api/preferences' ? prefError(error) : (errorMessage(error) || 'Request failed') }));
        }
        return;
      }
      res.writeHead(405); res.end(); return;
    }
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (url.pathname === '/api/metrics') {
      res.setHeader('Cache-Control', 'no-store');
      if (req.headers.origin && !sameOrigin) { res.writeHead(403); res.end(); return; }
      try {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify(
            await metrics({
              conversationId: url.searchParams.get('conversationId'),
              force: url.searchParams.get('force') === '1' || url.searchParams.get('force') === 'true',
              includeUsage: url.searchParams.get('includeUsage') !== '0' && url.searchParams.get('includeUsage') !== 'false',
            }),
          ),
        );
      } catch { res.writeHead(500); res.end('{"error":"数据暂时不可用"}'); }
      return;
    }
    if (url.pathname === '/api/integration') {
      res.setHeader('Cache-Control', 'no-store');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(getHealth()));
      return;
    }
    res.setHeader('Cache-Control', assetCacheControl(url.pathname, url));
    if (url.pathname === '/preload.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end('// Standalone preview: no host bridge.'); return; }
    if (url.pathname === '/i18n.js') { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }); res.end(i18nModule()); return; }
    if (url.pathname === '/theme.js') { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }); res.end(themeModule()); return; }
    if (url.pathname === '/usage-ui.js') {
      if (!usageUiModule) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end(usageUiModule());
      return;
    }
    if (url.pathname === '/theme.css') { res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' }); res.end(themeCss()); return; }
    if (url.pathname === '/inline-widget.js') { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }); res.end(inlineSource()); return; }
    if (url.pathname === '/app.js') { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }); res.end(panelAppSource()); return; }
    if (url.pathname.startsWith('/toolbar-preview')) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(readFileSync(join(here, 'toolbar-preview.html'), 'utf8')); return; }
    const file = staticFiles[url.pathname];
    if (!file) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': `${file[1]}; charset=utf-8` });
    res.end(url.pathname === '/' ? panelPageSource() : readFileSync(join(here, file[0]), 'utf8'));
  });
  server.listen(port, '127.0.0.1', () => console.log(`Antigrative Dashboard: http://127.0.0.1:${port}`));
  return server;
}
