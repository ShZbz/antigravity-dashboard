// Zero-dependency MCP JSON-RPC 2.0 protocol dispatcher and stdio transport.
import { StringDecoder } from 'node:string_decoder';

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
}

export interface McpToolContent {
  type: 'text';
  text: string;
}

export interface McpCallToolResult {
  content: McpToolContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface McpToolDefinition {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

export interface McpResourceDefinition {
  uri: string;
  name: string;
  description?: string;
  mimeType: string;
  _meta?: Record<string, unknown>;
}

export interface McpResourceContent {
  uri: string;
  mimeType: string;
  text: string;
  _meta?: Record<string, unknown>;
}

export interface McpServerConfig {
  serverInfo: {
    name: string;
    version: string;
  };
  defaultProtocolVersion?: string;
  tools: readonly McpToolDefinition[];
  resources: readonly McpResourceDefinition[];
  callTool: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<McpCallToolResult> | McpCallToolResult;
  readResource: (
    uri: string,
  ) => Promise<McpResourceContent> | McpResourceContent;
  onLog?: (message: string) => void;
}

export interface McpProtocolHandler {
  handleMessage(raw: unknown): Promise<JsonRpcResponse | null>;
  handleRawLine(line: string): Promise<JsonRpcResponse | null>;
  getClientState(): {
    initialized: boolean;
    protocolVersion: string;
    clientCapabilities: Record<string, unknown>;
    supportsUiExtension: boolean;
  };
}

export interface StdioInputStream {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
  resume?(): unknown;
}

export interface StdioOutputStream {
  write(chunk: string, encoding?: BufferEncoding): boolean;
  once?(event: string, listener: (...args: unknown[]) => void): unknown;
  on?(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface StdioTransportOptions {
  input?: StdioInputStream;
  output?: StdioOutputStream;
  onLog?: (message: string) => void;
}

export interface StdioTransportHandle {
  close(): void;
  readonly done: Promise<void>;
}

export const JSON_RPC_PARSE_ERROR = -32700;
export const JSON_RPC_INVALID_REQUEST = -32600;
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
export const JSON_RPC_INVALID_PARAMS = -32602;
export const JSON_RPC_INTERNAL_ERROR = -32603;
export const MCP_RESOURCE_NOT_FOUND = -32002;
export const DEFAULT_MCP_PROTOCOL_VERSION = '2025-06-18';

export class McpRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'McpRpcError';
    this.code = code;
    this.data = data;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isValidRpcId(value: unknown): value is JsonRpcId {
  return value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

function errorResponse(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  const err: JsonRpcError = data !== undefined ? { code, message, data } : { code, message };
  return { jsonrpc: '2.0', id, error: err };
}

function okResponse(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createMcpProtocolHandler(config: McpServerConfig): McpProtocolHandler {
  const defaultVersion = config.defaultProtocolVersion || DEFAULT_MCP_PROTOCOL_VERSION;
  const toolNames = new Set(config.tools.map((tool) => tool.name));
  let initialized = false;
  let negotiatedVersion = defaultVersion;
  let clientCapabilities: Record<string, unknown> = {};

  const supportsUi = (): boolean => {
    const ext = isPlainObject(clientCapabilities.extensions) ? clientCapabilities.extensions : null;
    return Boolean(
      ext &&
        (Object.hasOwn(ext, 'io.modelcontextprotocol/ui') ||
          Object.hasOwn(ext, 'com.google.antigravity/ui')),
    );
  };

  async function dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === 'initialize') {
      const requested = params.protocolVersion;
      negotiatedVersion =
        typeof requested === 'string' && requested.trim().length > 0
          ? requested.trim()
          : defaultVersion;
      clientCapabilities = isPlainObject(params.capabilities) ? { ...params.capabilities } : {};
      return {
        protocolVersion: negotiatedVersion,
        capabilities: {
          tools: {},
          resources: {},
        },
        serverInfo: config.serverInfo,
      };
    }

    if (method === 'ping') {
      return {};
    }

    if (method === 'tools/list') {
      return { tools: config.tools.map((tool) => ({ ...tool })) };
    }

    if (method === 'tools/call') {
      const name = typeof params.name === 'string' ? params.name.trim() : '';
      if (!name) {
        throw new McpRpcError(JSON_RPC_INVALID_PARAMS, 'Missing tool name');
      }
      if (!toolNames.has(name)) {
        throw new McpRpcError(JSON_RPC_INVALID_PARAMS, `Unknown tool: ${name}`);
      }
      const rawArgs = params.arguments;
      if (rawArgs !== undefined && rawArgs !== null && !isPlainObject(rawArgs)) {
        throw new McpRpcError(JSON_RPC_INVALID_PARAMS, 'Tool arguments must be an object');
      }
      try {
        return await config.callTool(name, rawArgs ?? {});
      } catch (error) {
        if (error instanceof McpRpcError) throw error;
        const msg = errMessage(error) || 'Tool execution failed';
        return {
          isError: true,
          content: [{ type: 'text', text: msg }],
          structuredContent: { ok: false, error: msg },
        } satisfies McpCallToolResult;
      }
    }

    if (method === 'resources/list') {
      return { resources: config.resources.map((res) => ({ ...res })) };
    }

    if (method === 'resources/templates/list') {
      return { resourceTemplates: [] };
    }

    if (method === 'resources/read') {
      const uri = typeof params.uri === 'string' ? params.uri.trim() : '';
      if (!uri) {
        throw new McpRpcError(JSON_RPC_INVALID_PARAMS, 'Missing resource URI');
      }
      const content = await config.readResource(uri);
      return { contents: [content] };
    }

    throw new McpRpcError(JSON_RPC_METHOD_NOT_FOUND, `Method not found: ${method}`);
  }

  async function handleMessage(raw: unknown): Promise<JsonRpcResponse | null> {
    if (!isPlainObject(raw)) {
      return errorResponse(null, JSON_RPC_INVALID_REQUEST, 'Invalid JSON-RPC request');
    }
    const hasId = Object.hasOwn(raw, 'id') && raw.id !== undefined;
    const id: JsonRpcId = hasId && isValidRpcId(raw.id) ? raw.id : null;
    if (raw.jsonrpc !== '2.0' || typeof raw.method !== 'string' || !raw.method) {
      return hasId ? errorResponse(id, JSON_RPC_INVALID_REQUEST, 'Invalid JSON-RPC 2.0 frame') : null;
    }

    const method = raw.method;
    if (method === 'notifications/initialized') {
      initialized = true;
      return null;
    }
    if (!hasId) {
      // Ignore notifications (including unknown notifications) without replying.
      return null;
    }
    if (!isValidRpcId(raw.id)) {
      return errorResponse(null, JSON_RPC_INVALID_REQUEST, 'Invalid JSON-RPC id');
    }

    const rawParams = raw.params;
    if (rawParams !== undefined && rawParams !== null && !isPlainObject(rawParams)) {
      return errorResponse(id, JSON_RPC_INVALID_PARAMS, 'Params must be an object');
    }

    try {
      const result = await dispatch(method, rawParams ?? {});
      return okResponse(id, result);
    } catch (error) {
      if (error instanceof McpRpcError) {
        return errorResponse(id, error.code, error.message, error.data);
      }
      const msg = errMessage(error) || 'Internal server error';
      config.onLog?.(`[mcp] internal error in ${method}: ${msg}`);
      return errorResponse(id, JSON_RPC_INTERNAL_ERROR, msg);
    }
  }

  async function handleRawLine(line: string): Promise<JsonRpcResponse | null> {
    const trimmed = line.trim();
    if (!trimmed) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return errorResponse(null, JSON_RPC_PARSE_ERROR, 'Parse error');
    }
    return await handleMessage(parsed);
  }

  return {
    handleMessage,
    handleRawLine,
    getClientState: () => ({
      initialized,
      protocolVersion: negotiatedVersion,
      clientCapabilities: { ...clientCapabilities },
      supportsUiExtension: supportsUi(),
    }),
  };
}

export function startStdioTransport(
  handler: McpProtocolHandler,
  options: StdioTransportOptions = {},
): StdioTransportHandle {
  const input: StdioInputStream = options.input ?? (process.stdin as unknown as StdioInputStream);
  const output: StdioOutputStream = options.output ?? (process.stdout as unknown as StdioOutputStream);
  const log =
    options.onLog ??
    ((msg: string) => {
      try {
        process.stderr.write(`${msg}\n`);
      } catch {}
    });

  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let closed = false;
  let writeChain: Promise<void> = Promise.resolve();
  const inFlight = new Set<Promise<void>>();

  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const detach = (
    target: Pick<StdioInputStream, 'off' | 'removeListener'>,
    event: string,
    listener: (...args: unknown[]) => void,
  ): void => {
    if (typeof target.off === 'function') target.off(event, listener);
    else if (typeof target.removeListener === 'function') target.removeListener(event, listener);
  };

  const writeFrame = (frame: JsonRpcResponse): Promise<void> => {
    const serialized = `${JSON.stringify(frame)}\n`;
    writeChain = writeChain.then(
      () =>
        new Promise<void>((resolve) => {
          if (closed) {
            resolve();
            return;
          }
          try {
            const ok = output.write(serialized, 'utf8');
            if (ok) {
              resolve();
            } else if (typeof output.once === 'function') {
              output.once('drain', () => resolve());
            } else if (typeof output.on === 'function') {
              const onDrain = (): void => {
                detach(output, 'drain', onDrain);
                resolve();
              };
              output.on('drain', onDrain);
            } else {
              resolve();
            }
          } catch (error) {
            log(`[mcp] stdout write error: ${errMessage(error)}`);
            resolve();
          }
        }),
    );
    return writeChain;
  };

  const processLine = (line: string): void => {
    if (!line.trim()) return;
    const task = handler
      .handleRawLine(line)
      .then((response) => {
        if (response) return writeFrame(response);
        return undefined;
      })
      .catch((error) => {
        log(`[mcp] unhandled frame error: ${errMessage(error)}`);
      })
      .finally(() => {
        inFlight.delete(task);
      });
    inFlight.add(task);
  };

  const onData = (chunk: unknown): void => {
    if (closed) return;
    if (typeof chunk === 'string') {
      buffer += chunk;
    } else if (chunk instanceof Uint8Array) {
      buffer += decoder.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    } else {
      buffer += String(chunk ?? '');
    }
    let idx = buffer.indexOf('\n');
    while (idx !== -1) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      processLine(line);
      idx = buffer.indexOf('\n');
    }
  };

  const finish = (): void => {
    if (closed) return;
    buffer += decoder.end();
    if (buffer.trim()) {
      processLine(buffer.replace(/\r$/, ''));
    }
    buffer = '';
    void Promise.allSettled([...inFlight])
      .then(() => writeChain)
      .finally(() => {
        closed = true;
        resolveDone();
      });
  };

  const onError = (error: unknown): void => {
    log(`[mcp] stdin stream error: ${errMessage(error)}`);
    finish();
  };

  input.on('data', onData);
  input.on('end', finish);
  input.on('close', finish);
  input.on('error', onError);
  if (typeof input.resume === 'function') {
    input.resume();
  }

  return {
    done,
    close(): void {
      if (closed) return;
      closed = true;
      detach(input, 'data', onData);
      detach(input, 'end', finish);
      detach(input, 'close', finish);
      detach(input, 'error', onError);
      resolveDone();
    },
  };
}
