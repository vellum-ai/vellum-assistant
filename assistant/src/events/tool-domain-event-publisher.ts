import { isAllowDecision, type UserDecision } from "../permissions/types.js";
import type { ToolLifecycleEventHandler } from "../tools/types.js";
import type { EventBus } from "./bus.js";
import type { AssistantDomainEvents } from "./domain-events.js";

export function createToolDomainEventPublisher(
  eventBus: EventBus<AssistantDomainEvents>,
): ToolLifecycleEventHandler {
  return async (event) => {
    switch (event.type) {
      case "start":
        await eventBus.emit("tool.execution.started", {
          conversationId: event.conversationId,
          requestId: event.requestId,
          toolName: event.toolName,
          input: event.input,
          startedAtMs: event.startedAtMs,
        });
        break;
      case "permission_prompt":
        await eventBus.emit("tool.permission.requested", {
          conversationId: event.conversationId,
          requestId: event.requestId,
          toolName: event.toolName,
          riskLevel: event.riskLevel,
          requestedAtMs: Date.now(),
        });
        break;
      case "permission_denied":
        await eventBus.emit("tool.permission.decided", {
          conversationId: event.conversationId,
          requestId: event.requestId,
          toolName: event.toolName,
          decision: event.decision,
          riskLevel: event.riskLevel,
          decidedAtMs: Date.now(),
        });
        break;
      case "executed":
        if (isAllowDecision(event.decision as UserDecision)) {
          await eventBus.emit("tool.permission.decided", {
            conversationId: event.conversationId,
            requestId: event.requestId,
            toolName: event.toolName,
            decision:
              event.decision as AssistantDomainEvents["tool.permission.decided"]["decision"],
            riskLevel: event.riskLevel,
            decidedAtMs: Date.now(),
          });
        }
        await eventBus.emit("tool.execution.finished", {
          conversationId: event.conversationId,
          requestId: event.requestId,
          toolName: event.toolName,
          decision: event.decision,
          riskLevel: event.riskLevel,
          isError: event.result.isError,
          durationMs: event.durationMs,
          finishedAtMs: Date.now(),
        });
        break;
      case "error":
        if (isAllowDecision(event.decision as UserDecision)) {
          await eventBus.emit("tool.permission.decided", {
            conversationId: event.conversationId,
            requestId: event.requestId,
            toolName: event.toolName,
            decision:
              event.decision as AssistantDomainEvents["tool.permission.decided"]["decision"],
            riskLevel: event.riskLevel,
            decidedAtMs: Date.now(),
          });
        }
        await eventBus.emit("tool.execution.failed", {
          conversationId: event.conversationId,
          requestId: event.requestId,
          toolName: event.toolName,
          decision: event.decision,
          riskLevel: event.riskLevel,
          durationMs: event.durationMs,
          error: event.errorMessage,
          isExpected: event.isExpected,
          errorName: event.errorName,
          errorStack: event.errorStack,
          failedAtMs: Date.now(),
        });
        break;
      case "secret_detected":
        await eventBus.emit("tool.secret.detected", {
          conversationId: event.conversationId,
          requestId: event.requestId,
          toolName: event.toolName,
          action: event.action,
          matches: event.matches,
          detectedAtMs: event.detectedAtMs,
        });
        break;
    }
  };
}
