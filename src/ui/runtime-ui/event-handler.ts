import {
  dispatchBindingCall,
  formatBindingError,
  type BindingPayload,
  type RuntimeDispatchHost,
} from './binding-dispatch.ts';
import type {
  CdpContextCandidate,
  CdpEventMessage,
  RuntimeSessionConnection,
} from './types.ts';

export interface EventHandlerContext extends RuntimeDispatchHost {
  binding: string;
  stopping: boolean;
  owns: () => boolean | Promise<boolean>;
  rendererGuard: (expression: string) => string;
}

export async function handleCdpEvent(
  ctx: EventHandlerContext,
  connection: RuntimeSessionConnection,
  message: CdpEventMessage,
): Promise<void> {
  if (ctx.stopping || !(await ctx.owns())) return;
  const p = (message.params || {}) as Record<string, any>;
  const contexts = (connection.contexts ??= new Set<number>());
  const contextCandidates = (connection.contextCandidates ??= new Map<
    number,
    CdpContextCandidate
  >());

  if (message.method === 'Page.frameNavigated' && p.frame && !p.frame.parentId) {
    const replaced = connection.frameId !== p.frame.id;
    connection.frameId = p.frame.id as string;
    contexts.clear();
    connection.mounted = false;
    const frameUrl = typeof p.frame.url === 'string' ? p.frame.url : '';
    const trusted =
      frameUrl === connection.origin ||
      (connection.origin ? frameUrl.startsWith(connection.origin + '/') : false);
    // With an unchanged frame ID, prior document contexts may not yet have
    // emitted their destruction events. Replay them on the next heartbeat.
    if (replaced && trusted) {
      for (const [id, context] of contextCandidates) {
        if (context.frameId === connection.frameId && context.origin === connection.origin) {
          contexts.add(id);
        }
      }
    }
    return;
  }

  if (message.method === 'Runtime.executionContextCreated') {
    if (p.context?.auxData?.isDefault) {
      const id = p.context.id as number;
      const frameId = p.context.auxData.frameId as string;
      const origin = p.context.origin as string;
      contextCandidates.set(id, { frameId, origin });
      if (contextCandidates.size > 32) {
        const oldest = contextCandidates.keys().next().value;
        if (oldest !== undefined) contextCandidates.delete(oldest);
      }
      if (frameId === connection.frameId && origin === connection.origin) {
        contexts.add(id);
      }
    }
    return;
  }

  if (message.method === 'Runtime.executionContextsCleared') {
    contexts.clear();
    contextCandidates.clear();
    connection.mounted = false;
    return;
  }

  if (message.method === 'Runtime.executionContextDestroyed') {
    contexts.delete(p.executionContextId as number);
    contextCandidates.delete(p.executionContextId as number);
    return;
  }

  const contextId = p.executionContextId as number;
  if (
    message.method !== 'Runtime.bindingCalled' ||
    p.name !== ctx.binding ||
    !contexts.has(contextId)
  ) {
    return;
  }
  const inflight = connection.inflight ?? 0;
  if (typeof p.payload !== 'string' || p.payload.length > 4096 || inflight >= 8) return;

  let input: BindingPayload;
  try {
    input = JSON.parse(p.payload) as BindingPayload;
    if (!Number.isSafeInteger(input.id) || input.id < 1) return;
  } catch {
    return;
  }

  connection.inflight = inflight + 1;
  try {
    const outcome = await dispatchBindingCall(ctx, connection, input);
    if (!outcome.handled) return;
    if (ctx.stopping || !(await ctx.owns())) return;
    const serialized = outcome.serializedResult ?? JSON.stringify(outcome.result);
    await connection.command('Runtime.evaluate', {
      expression: ctx.rendererGuard(
        'window.__agPulseRuntimeBridge?.resolve(' +
          input.id +
          ',' +
          serialized +
          ')',
      ),
      contextId,
    });
  } catch (error) {
    const failure = formatBindingError(input.type, error);
    if (ctx.stopping || !(await ctx.owns())) return;
    try {
      await connection.command('Runtime.evaluate', {
        expression: ctx.rendererGuard(
          'window.__agPulseRuntimeBridge?.resolve(' +
            input.id +
            ',' +
            JSON.stringify(failure) +
            ')',
        ),
        contextId,
      });
    } catch {
      // The next poll reconnects.
    }
  } finally {
    connection.inflight = (connection.inflight ?? 1) - 1;
  }
}
