// Zero-runtime-dependency stdio MCP Server entry for Antigrative Dashboard.
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MCP_RESOURCE_NOT_FOUND,
  McpRpcError,
  createMcpProtocolHandler,
  startStdioTransport,
  type McpProtocolHandler,
  type McpResourceContent,
  type McpResourceDefinition,
  type StdioTransportHandle,
  type StdioTransportOptions,
} from './protocol.ts';
import {
  DEFAULT_IDLE_DISPOSE_MS,
  PULSE_MCP_TOOLS,
  USAGE_APP_MIME_TYPE,
  USAGE_APP_RESOURCE_URI,
  createPulseMcpBackend,
  type PulseMcpBackend,
  type PulseMcpBackendOptions,
} from './tools.ts';

export { DEFAULT_IDLE_DISPOSE_MS, USAGE_APP_MIME_TYPE, USAGE_APP_RESOURCE_URI } from './tools.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FALLBACK_VERSION = '0.12.8';

export interface PulseMcpServerOptions extends PulseMcpBackendOptions {
  here?: string;
  env?: NodeJS.ProcessEnv;
  version?: string;
  onLog?: (message: string) => void;
}

export interface PulseMcpHandlerHandle extends McpProtocolHandler {
  readonly backend: PulseMcpBackend;
  dispose(): void;
}

function resolvePluginVersion(here: string): string {
  try {
    const raw = readFileSync(join(here, '..', 'plugin.json'), 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw) as { version?: unknown } | null;
    if (typeof parsed?.version === 'string' && parsed.version.trim()) {
      return parsed.version.trim();
    }
  } catch {}
  return FALLBACK_VERSION;
}

export function resolveUsageHtmlPath(
  here: string = HERE,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = typeof env.AG_PULSE_MCP_USAGE_HTML === 'string' ? env.AG_PULSE_MCP_USAGE_HTML.trim() : '';
  return override || join(here, 'apps', 'usage.html');
}

const PULSE_MCP_RESOURCES: readonly McpResourceDefinition[] = [
  {
    uri: USAGE_APP_RESOURCE_URI,
    name: 'Token Usage Dashboard',
    description: 'Interactive full-page Token Usage dashboard for Antigrative Dashboard.',
    mimeType: USAGE_APP_MIME_TYPE,
    _meta: { ui: { prefersBorder: false } },
  },
];

function stderrLog(message: string): void {
  try {
    process.stderr.write(`${message}\n`);
  } catch {}
}

export function createPulseMcpHandler(options: PulseMcpServerOptions = {}): PulseMcpHandlerHandle {
  const here = options.here ?? HERE;
  const env = options.env ?? process.env;
  const log = options.onLog ?? stderrLog;
  const backend = createPulseMcpBackend(options);

  const readResource = async (uri: string): Promise<McpResourceContent> => {
    if (uri !== USAGE_APP_RESOURCE_URI) {
      throw new McpRpcError(MCP_RESOURCE_NOT_FOUND, `Unknown resource URI: ${uri}`);
    }
    const htmlPath = resolveUsageHtmlPath(here, env);
    let html: string;
    try {
      html = await readFile(htmlPath, 'utf8');
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new McpRpcError(
        MCP_RESOURCE_NOT_FOUND,
        `Unable to read MCP App UI resource at ${htmlPath}: ${detail}`,
      );
    }
    if (!html.trim()) {
      throw new McpRpcError(MCP_RESOURCE_NOT_FOUND, `MCP App UI resource is empty: ${htmlPath}`);
    }
    return {
      uri: USAGE_APP_RESOURCE_URI,
      mimeType: USAGE_APP_MIME_TYPE,
      text: html,
      _meta: { ui: { prefersBorder: false } },
    };
  };

  const protocol = createMcpProtocolHandler({
    serverInfo: {
      name: 'antigravity-pulse',
      version: options.version ?? resolvePluginVersion(here),
    },
    tools: PULSE_MCP_TOOLS,
    resources: PULSE_MCP_RESOURCES,
    callTool: (name, args) => backend.callTool(name, args),
    readResource,
    onLog: log,
  });

  return {
    ...protocol,
    backend,
    dispose(): void {
      backend.dispose();
    },
  };
}

export function startPulseMcpServer(
  options: PulseMcpServerOptions & StdioTransportOptions = {},
): { handler: PulseMcpHandlerHandle; transport: StdioTransportHandle } {
  const log = options.onLog ?? stderrLog;
  const handler = createPulseMcpHandler(options);
  const transport = startStdioTransport(handler, {
    input: options.input,
    output: options.output,
    onLog: log,
  });

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    transport.close();
    handler.dispose();
  };

  void transport.done.finally(() => {
    handler.dispose();
  });

  if (!options.input && !options.output) {
    for (const sig of ['SIGINT', 'SIGTERM'] as const) {
      process.once(sig, () => {
        shutdown();
        process.exit(0);
      });
    }
  }

  return { handler, transport };
}

const isMain =
  typeof process !== 'undefined' &&
  Boolean(process.argv[1]) &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  startPulseMcpServer();
}
