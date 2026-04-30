import {
  recordToolInvocation,
  type ToolInvocationRecord,
} from "../memory/tool-usage-store.js";
import type {
  ToolLifecycleEvent,
  ToolLifecycleEventHandler,
} from "../tools/types.js";
import { getLogger } from "../util/logger.js";

const RESULT_PREVIEW_LIMIT = 1000;
const log = getLogger("tool-audit-listener");

type InvocationRecorder = (record: ToolInvocationRecord) => void;

export function createToolAuditListener(
  recorder: InvocationRecorder = recordToolInvocation,
): ToolLifecycleEventHandler {
  return (event) => {
    const record = toInvocationRecord(event);
    if (!record) return;

    try {
      recorder(record);
    } catch (err) {
      log.warn(
        { err, eventType: event.type, toolName: event.toolName },
        "Failed to record tool invocation",
      );
    }
  };
}

function toInvocationRecord(
  event: ToolLifecycleEvent,
): ToolInvocationRecord | null {
  switch (event.type) {
    case "executed":
      return {
        conversationId: event.conversationId,
        toolName: event.toolName,
        input: stringifyInput(event.input),
        result: event.result.content.slice(0, RESULT_PREVIEW_LIMIT),
        decision: event.decision,
        riskLevel: event.riskLevel,
        matchedTrustRuleId: event.matchedTrustRuleId,
        durationMs: event.durationMs,
      };
    case "error":
      return {
        conversationId: event.conversationId,
        toolName: event.toolName,
        input: stringifyInput(event.input),
        result: `error: ${event.errorMessage}`,
        decision: "error",
        riskLevel: event.riskLevel,
        matchedTrustRuleId: event.matchedTrustRuleId,
        durationMs: event.durationMs,
      };
    case "permission_denied":
      return {
        conversationId: event.conversationId,
        toolName: event.toolName,
        input: stringifyInput(event.input),
        result: formatDeniedResult(event.reason),
        decision: "denied",
        riskLevel: event.riskLevel,
        matchedTrustRuleId: event.matchedTrustRuleId,
        durationMs: event.durationMs,
      };
    case "start":
    case "permission_prompt":
      return null;
  }
}

function stringifyInput(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input);
  } catch {
    return "[unserializable-input]";
  }
}

function formatDeniedResult(reason: string): string {
  if (reason.startsWith("Blocked by deny rule:")) {
    return `denied: ${reason}`;
  }
  return "denied";
}
