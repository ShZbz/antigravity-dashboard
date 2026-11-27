import type { DevToolsTarget } from '../../platform/devtools.ts';
import type { CdpConnectionOptions, RuntimeSessionConnection } from './types.ts';

export interface SessionLifecycleContext {
  source: string;
  owner: string | null;
  binding: string;
  stopping: boolean;
  owns: () => boolean | Promise<boolean>;
  targetOrigin: (target: DevToolsTarget) => string;
  connect: (url: string, options: CdpConnectionOptions) => RuntimeSessionConnection;
  onEvent: (connection: RuntimeSessionConnection, message: Record<string, unknown>) => void;
  rendererGuard: (expression: string) => string;
}

export function buildGuardedSource(source: string, origin: string | undefined): string {
  return 'if (location.origin === ' + JSON.stringify(origin) + ') {' + source + '}';
}

export async function attachTargetSession(
  ctx: SessionLifecycleContext,
  target: DevToolsTarget,
): Promise<RuntimeSessionConnection> {
  const wsUrl = target.webSocketDebuggerUrl ?? '';
  const connection = ctx.connect(wsUrl, {
    onEvent: (message) => {
      ctx.onEvent(connection, message as Record<string, unknown>);
    },
  });
  connection.origin = ctx.targetOrigin(target);
  connection.contexts = new Set();
  connection.contextCandidates = new Map();
  connection.inflight = 0;
  connection.mounted = false;
  try {
    await connection.open();
    if (ctx.stopping || !(await ctx.owns())) throw new Error('Sidecar ownership changed');
    const frame = (await connection.command('Page.getFrameTree')) as {
      frameTree?: { frame?: { id?: string } };
    };
    connection.frameId = frame.frameTree?.frame?.id;
    if (!connection.frameId) throw new Error('Main renderer frame unavailable');
    await connection.command('Page.enable');
    await connection.command('Runtime.enable');
    await connection.command('Runtime.addBinding', { name: ctx.binding });
    const guardedSource = buildGuardedSource(ctx.source, connection.origin);
    // Provide on-demand getter for existing test doubles without retaining a duplicate 500 KB string per connection.
    Object.defineProperty(connection, 'guardedSource', {
      configurable: true,
      enumerable: false,
      get: () => buildGuardedSource(ctx.source, connection.origin),
    });
    const added = (await connection.command('Page.addScriptToEvaluateOnNewDocument', {
      source: guardedSource,
    })) as { identifier?: string };
    connection.script = added.identifier;
    if (ctx.stopping || !(await ctx.owns())) {
      await connection.command('Page.removeScriptToEvaluateOnNewDocument', {
        identifier: connection.script,
      });
      throw new Error('Sidecar ownership changed');
    }
    const result = (await connection.command('Runtime.evaluate', {
      expression: guardedSource,
    })) as { exceptionDetails?: unknown };
    if (result.exceptionDetails) throw new Error('Widget initialization failed');
    return connection;
  } catch (error) {
    // CDP preloads outlive the socket; failed/aborted attachment must remove
    // its own script so it cannot run again after a later page navigation.
    try {
      if (connection.script) {
        await connection.command('Page.removeScriptToEvaluateOnNewDocument', {
          identifier: connection.script,
        });
      }
    } catch {
      // Ignore cleanup failures on closed sockets.
    }
    try {
      if (ctx.owner) {
        await connection.command('Runtime.removeBinding', { name: ctx.binding });
      }
    } catch {
      // Ignore cleanup failures on closed sockets.
    }
    connection.close();
    throw error;
  }
}

export async function verifyTargetSession(
  ctx: SessionLifecycleContext,
  connection: RuntimeSessionConnection,
): Promise<boolean> {
  // Cold-start navigation may replace the top frame or lose its context
  // events while hooks still exist. Resynchronize on the same socket.
  if (!connection.contexts?.size) {
    const frame = (await connection.command('Page.getFrameTree')) as {
      frameTree?: { frame?: { id?: string } };
    };
    connection.frameId = frame.frameTree?.frame?.id;
    connection.contextCandidates?.clear();
    await connection.command('Runtime.disable');
    await connection.command('Runtime.enable');
    // Runtime.disable also removes binding subscriptions. Restore the
    // data channel and release old calls before normal polling resumes.
    await connection.command('Runtime.addBinding', { name: ctx.binding });
    await connection.command('Runtime.evaluate', {
      expression: ctx.rendererGuard('window.__agPulseRuntimeBridge?.reconnect?.();'),
    });
  }
  const result = (await connection.command('Runtime.evaluate', {
    returnByValue: true,
    expression:
      '({mounted:Boolean(document.getElementById("ag-pulse-status-bar")?.isConnected),installed:Boolean(window.__agPulseInlineInstalled),bridge:Boolean(window.__agPulseRuntimeBridge && window.agPulseHost' +
      (ctx.owner
        ? ' && window.__agPulseRuntimeBridge.binding===' + JSON.stringify(ctx.binding)
        : '') +
      ')})',
  })) as {
    exceptionDetails?: unknown;
    result?: { value?: { mounted?: boolean; installed?: boolean; bridge?: boolean } };
  };
  if (result.exceptionDetails) throw new Error('Renderer document is not ready');
  const status = result.result?.value;
  connection.mounted = status?.mounted === true;
  // Startup can swap the document between discovery and first injection.
  // Reinstall missing hooks rather than waiting forever for a composer.
  if (status && (!status.installed || !status.bridge)) {
    if (!(await ctx.owns())) return false;
    const recovery = (await connection.command('Runtime.evaluate', {
      expression: buildGuardedSource(ctx.source, connection.origin),
    })) as { exceptionDetails?: unknown };
    if (recovery.exceptionDetails) throw new Error('Widget recovery failed');
  }
  return true;
}

export async function detachTargetSession(
  ctx: SessionLifecycleContext,
  connection: RuntimeSessionConnection,
): Promise<void> {
  try {
    // A superseded process must not dispose the newer process's widget.
    if (await ctx.owns()) {
      await connection.command('Runtime.evaluate', {
        expression: ctx.rendererGuard(
          'window.__agPulseDispose?.();window.__agPulseRuntimeBridge?.dispose();delete window.agPulseHost;',
        ),
      });
    }
    if (connection.script) {
      await connection.command('Page.removeScriptToEvaluateOnNewDocument', {
        identifier: connection.script,
      });
    }
    // Owner-specific bindings can be removed without affecting a new instance.
    if (ctx.owner || (await ctx.owns())) {
      await connection.command('Runtime.removeBinding', { name: ctx.binding });
    }
  } catch {
    // A closed renderer has already removed its widget.
  }
  connection.close();
}
