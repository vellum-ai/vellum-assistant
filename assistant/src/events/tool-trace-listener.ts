import type { EventBus, Subscription } from './bus.js';
import type { AssistantDomainEvents } from './domain-events.js';
import type { TraceEmitter } from '../daemon/trace-emitter.js';

export function registerToolTraceListener(
  eventBus: EventBus<AssistantDomainEvents>,
  traceEmitter: TraceEmitter,
): Subscription {
  return eventBus.onAny((event) => {
    switch (event.type) {
      case 'tool.execution.started':
        traceEmitter.emit('tool_started', `Tool ${event.payload.toolName} started`, {
          requestId: event.payload.requestId,
          attributes: { toolName: event.payload.toolName },
        });
        return;

      case 'tool.permission.requested':
        traceEmitter.emit('tool_permission_requested', `Permission requested for ${event.payload.toolName}`, {
          requestId: event.payload.requestId,
          attributes: {
            toolName: event.payload.toolName,
            riskLevel: event.payload.riskLevel,
          },
        });
        return;

      case 'tool.permission.decided':
        traceEmitter.emit('tool_permission_decided', `Permission ${event.payload.decision} for ${event.payload.toolName}`, {
          requestId: event.payload.requestId,
          attributes: {
            toolName: event.payload.toolName,
            decision: event.payload.decision,
          },
        });
        return;

      case 'tool.execution.finished':
        traceEmitter.emit('tool_finished', `Tool ${event.payload.toolName} finished in ${event.payload.durationMs}ms`, {
          requestId: event.payload.requestId,
          attributes: {
            toolName: event.payload.toolName,
            durationMs: event.payload.durationMs,
          },
        });
        return;

      case 'tool.execution.failed':
        traceEmitter.emit('tool_failed', `Tool ${event.payload.toolName} failed after ${event.payload.durationMs}ms`, {
          requestId: event.payload.requestId,
          status: 'error',
          attributes: {
            toolName: event.payload.toolName,
            durationMs: event.payload.durationMs,
          },
        });
        return;

      case 'tool.secret.detected':
        traceEmitter.emit('secret_detected', `Secret detected in ${event.payload.toolName} output`, {
          requestId: event.payload.requestId,
          status: 'warning',
          attributes: {
            toolName: event.payload.toolName,
          },
        });
        return;

      default:
        return;
    }
  });
}
