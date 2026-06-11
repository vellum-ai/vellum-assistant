import {
  recordToolInvocation,
  type ToolInvocationRecord,
} from "../memory/tool-usage-store.js";
import { redactSecrets } from "../security/secret-scanner.js";
import type {
  ToolLifecycleEvent,
  ToolLifecycleEventHandler,
} from "../tools/types.js";
import { toAttributionColumns } from "../usage/attribution.js";
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
    case "executed": {
      const input = stringifyInput(event.input);
      return {
        conversationId: event.conversationId,
        toolName: event.toolName,
        input,
        result: redactSecrets(event.result.content).slice(
          0,
          RESULT_PREVIEW_LIMIT,
        ),
        decision: event.decision,
        riskLevel: event.riskLevel,
        matchedTrustRuleId: event.matchedTrustRuleId,
        durationMs: event.durationMs,
        // Byte sizes are computed here from the raw payloads — the stored
        // `result` column is truncated and redacted above, so sizing at
        // query time would undercount. Only the sizes leave the device.
        argBytes: Buffer.byteLength(input, "utf8"),
        resultBytes: Buffer.byteLength(event.result.content, "utf8"),
        ...toAttributionColumns(event.attribution),
      };
    }
    case "error": {
      const input = stringifyInput(event.input);
      const result = `error: ${event.errorMessage}`;
      return {
        conversationId: event.conversationId,
        toolName: event.toolName,
        input,
        result,
        decision: "error",
        riskLevel: event.riskLevel,
        matchedTrustRuleId: event.matchedTrustRuleId,
        durationMs: event.durationMs,
        argBytes: Buffer.byteLength(input, "utf8"),
        resultBytes: Buffer.byteLength(result, "utf8"),
        ...toAttributionColumns(event.attribution),
      };
    }
    case "permission_denied":
      // No telemetry fields: the tool never executed, and denied rows are
      // filtered out of the tool_executed projection anyway.
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
