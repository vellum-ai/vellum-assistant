import {
  recordToolInvocation,
  type ToolInvocationRecord,
} from "../memory/tool-usage-store.js";
import { redactSecrets } from "../security/secret-scanner.js";
import {
  stringifyToolInput,
  type ToolLifecycleEvent,
  type ToolLifecycleEventHandler,
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
      const input = stringifyToolInput(event.input);
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
        // The fallback keeps argBytes non-null, which the tool_executed
        // projection's legacy-row filter relies on.
        argBytes: event.inputBytes ?? Buffer.byteLength(input, "utf8"),
        resultBytes: Buffer.byteLength(event.result.content, "utf8"),
        ...toAttributionColumns(event.attribution),
      };
    }
    case "error": {
      const input = stringifyToolInput(event.input);
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
        // Same sizing contract as the "executed" case above.
        argBytes: event.inputBytes ?? Buffer.byteLength(input, "utf8"),
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
        input: stringifyToolInput(event.input),
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

function formatDeniedResult(reason: string): string {
  if (reason.startsWith("Blocked by deny rule:")) {
    return `denied: ${reason}`;
  }
  return "denied";
}
