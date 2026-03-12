import { getLogger, truncateForLog } from "../util/logger.js";
import type { EventBus, Subscription } from "./bus.js";
import type { AssistantDomainEvents } from "./domain-events.js";

const INPUT_PREVIEW_LIMIT = 300;
const defaultLogger = getLogger("tool-metrics-listener");

interface MetricsLogger {
  debug(meta: object, message: string): void;
  info(meta: object, message: string): void;
  warn(meta: object, message: string): void;
  error(meta: object, message: string): void;
}

interface MetricsListenerOptions {
  logger?: MetricsLogger;
  debugEnabled?: () => boolean;
  truncate?: (value: string, maxLen: number) => string;
}

export function registerToolMetricsLoggingListener(
  eventBus: EventBus<AssistantDomainEvents>,
  options?: MetricsListenerOptions,
): Subscription {
  const logger = options?.logger ?? defaultLogger;
  const debugEnabled = options?.debugEnabled ?? (() => false);
  const truncate = options?.truncate ?? truncateForLog;

  return eventBus.onAny((event) => {
    switch (event.type) {
      case "tool.execution.started":
        if (!debugEnabled()) return;
        logger.debug(
          {
            tool: event.payload.toolName,
            input: formatInputForLog(event.payload.input, truncate),
            sessionId: event.payload.sessionId,
            conversationId: event.payload.conversationId,
            requestId: event.payload.requestId,
          },
          "Tool execute start",
        );
        return;
      case "tool.permission.requested":
        logger.info(
          {
            tool: event.payload.toolName,
            riskLevel: event.payload.riskLevel,
            sessionId: event.payload.sessionId,
            conversationId: event.payload.conversationId,
            requestId: event.payload.requestId,
          },
          "Tool permission requested",
        );
        return;
      case "tool.permission.decided": {
        const meta = {
          tool: event.payload.toolName,
          decision: event.payload.decision,
          riskLevel: event.payload.riskLevel,
          sessionId: event.payload.sessionId,
          conversationId: event.payload.conversationId,
          requestId: event.payload.requestId,
        };

        if (
          event.payload.decision === "deny" ||
          event.payload.decision === "always_deny"
        ) {
          logger.info(meta, "Tool permission denied");
          return;
        }
        if (debugEnabled()) {
          logger.debug(meta, "Tool permission decided");
        }
        return;
      }
      case "tool.secret.detected": {
        const types = [
          ...new Set(event.payload.matches.map((match) => match.type)),
        ];
        logger.warn(
          {
            toolName: event.payload.toolName,
            matchCount: event.payload.matches.length,
            types,
            action: event.payload.action,
            sessionId: event.payload.sessionId,
            conversationId: event.payload.conversationId,
            requestId: event.payload.requestId,
          },
          "Secrets detected in tool output",
        );
        return;
      }
      case "tool.execution.finished":
        if (!debugEnabled()) return;
        logger.debug(
          {
            tool: event.payload.toolName,
            execDurationMs: event.payload.durationMs,
            riskLevel: event.payload.riskLevel,
            decision: event.payload.decision,
            isError: event.payload.isError,
            sessionId: event.payload.sessionId,
            conversationId: event.payload.conversationId,
            requestId: event.payload.requestId,
          },
          "Tool execute result",
        );
        return;
      case "tool.execution.failed":
        if (event.payload.isExpected) {
          logger.warn(
            {
              tool: event.payload.toolName,
              execDurationMs: event.payload.durationMs,
              riskLevel: event.payload.riskLevel,
              decision: event.payload.decision,
              error: event.payload.error,
              errorName: event.payload.errorName,
              errorStack: event.payload.errorStack,
              isExpected: event.payload.isExpected,
              sessionId: event.payload.sessionId,
              conversationId: event.payload.conversationId,
              requestId: event.payload.requestId,
            },
            "Tool execution failed (expected)",
          );
          return;
        }
        logger.error(
          {
            tool: event.payload.toolName,
            execDurationMs: event.payload.durationMs,
            riskLevel: event.payload.riskLevel,
            decision: event.payload.decision,
            error: event.payload.error,
            errorName: event.payload.errorName,
            errorStack: event.payload.errorStack,
            isExpected: event.payload.isExpected,
            sessionId: event.payload.sessionId,
            conversationId: event.payload.conversationId,
            requestId: event.payload.requestId,
          },
          "Tool execution error",
        );
        return;
      default:
        return;
    }
  });
}

function formatInputForLog(
  input: Record<string, unknown>,
  truncate: (value: string, maxLen: number) => string,
): string {
  try {
    return truncate(JSON.stringify(input), INPUT_PREVIEW_LIMIT);
  } catch {
    return "[unserializable-input]";
  }
}
