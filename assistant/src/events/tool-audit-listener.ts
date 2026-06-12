import { getConfig } from "../config/loader.js";
import {
  recordToolInvocation,
  type ToolInvocationRecord,
} from "../memory/tool-usage-store.js";
import { redactJsonStringLeaves } from "../security/redact-json.js";
import { redactSecrets } from "../security/secret-scanner.js";
import {
  stringifyToolInput,
  type ToolLifecycleEvent,
  type ToolLifecycleEventHandler,
} from "../tools/types.js";
import {
  toAttributionColumns,
  type UsageAttributionColumns,
} from "../usage/attribution.js";
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
      const rawInput = stringifyToolInput(event.input);
      return {
        conversationId: event.conversationId,
        toolName: event.toolName,
        // Inputs can carry secrets the model typed verbatim (e.g.
        // `export OPENAI_API_KEY=...` in a bash command) — redact before
        // the row reaches the audit store, like results below.
        input: redactToolInput(event.input, rawInput),
        result: redactSecrets(event.result.content).slice(
          0,
          RESULT_PREVIEW_LIMIT,
        ),
        decision: event.decision,
        riskLevel: event.riskLevel,
        matchedTrustRuleId: event.matchedTrustRuleId,
        durationMs: event.durationMs,
        // Prefer the executor-stamped raw pre-sanitization size: by the
        // time listeners run, sensitive-output extraction has already
        // rewritten `result.content`, so sizing it here would undercount
        // for sensitive-output tools. The fallback covers emitters that
        // don't stamp.
        ...telemetryColumns(
          event,
          rawInput,
          event.resultBytes ?? Buffer.byteLength(event.result.content, "utf8"),
        ),
      };
    }
    case "error": {
      const rawInput = stringifyToolInput(event.input);
      const result = `error: ${event.errorMessage}`;
      return {
        conversationId: event.conversationId,
        toolName: event.toolName,
        input: redactToolInput(event.input, rawInput),
        result,
        decision: "error",
        riskLevel: event.riskLevel,
        matchedTrustRuleId: event.matchedTrustRuleId,
        durationMs: event.durationMs,
        // The error result string is built right here and never goes
        // through sensitive-output sanitization, so sizing it directly is
        // already raw — no executor stamp exists or is needed.
        ...telemetryColumns(event, rawInput, Buffer.byteLength(result, "utf8")),
      };
    }
    case "permission_denied":
      // No telemetry fields: the tool never executed, and denied rows are
      // filtered out of the tool_executed projection anyway.
      return {
        conversationId: event.conversationId,
        toolName: event.toolName,
        input: redactToolInput(event.input, stringifyToolInput(event.input)),
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

/**
 * Redact secrets from a tool input while keeping the stored audit string
 * parseable JSON. The redaction marker (`<redacted type="..." />`) contains
 * double quotes, so redacting the serialized string would corrupt it —
 * instead, walk the input's string leaves BEFORE stringification so the
 * marker lands inside a JSON string value (with its quotes escaped).
 *
 * `rawInput` is the canonical pre-redaction serialization (also used for
 * the `argBytes` telemetry fallback — byte sizes must reflect the full
 * payload before truncation and redaction). It is returned untouched when
 * nothing matched, keeping benign inputs byte-identical, and is redacted as
 * plain text if the input can't be walked or re-serialized (e.g. cyclic
 * structures).
 */
function redactToolInput(
  input: Record<string, unknown>,
  rawInput: string,
): string {
  try {
    const { value, changed } = redactJsonStringLeaves(input);
    if (!changed) return rawInput;
    return JSON.stringify(value);
  } catch {
    return redactSecrets(rawInput);
  }
}

type TelemetryColumns = Pick<ToolInvocationRecord, "argBytes" | "resultBytes"> &
  UsageAttributionColumns;

const NULL_TELEMETRY_COLUMNS: TelemetryColumns = {
  argBytes: null,
  resultBytes: null,
  provider: null,
  model: null,
  inferenceProfile: null,
  inferenceProfileSource: null,
};

/**
 * Telemetry-only columns (payload sizes + model attribution) for an
 * executed/error audit row. This is the single write-time privacy gate for
 * `tool_executed` telemetry: when usage data collection is disabled, the
 * columns persist as NULL, which the projection's `arg_bytes IS NOT NULL`
 * filter excludes permanently — the same mechanism that excludes legacy
 * pre-migration rows (see tool-executed-events-store.ts). That makes
 * opted-out rows unreportable by construction: no later opt-in, crash, or
 * watermark race can ship them. The audit fields themselves (tool name,
 * decision, input/result previews, duration) are unaffected —
 * `tool_invocations` is a local always-on audit log.
 *
 * When opted in, the non-null sizing keeps `argBytes` populated, which the
 * projection's legacy-row filter relies on.
 */
function telemetryColumns(
  event: Extract<ToolLifecycleEvent, { type: "executed" | "error" }>,
  rawInput: string,
  resultBytes: number,
): TelemetryColumns {
  if (!getConfig().collectUsageData) return NULL_TELEMETRY_COLUMNS;
  return {
    argBytes: event.inputBytes ?? Buffer.byteLength(rawInput, "utf8"),
    resultBytes,
    ...toAttributionColumns(event.attribution),
  };
}

function formatDeniedResult(reason: string): string {
  if (reason.startsWith("Blocked by deny rule:")) {
    return `denied: ${reason}`;
  }
  return "denied";
}
