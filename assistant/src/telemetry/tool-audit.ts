/**
 * Direct terminals for tool-execution auditing and telemetry.
 *
 * The executor and its permission/approval collaborators call these functions
 * inline as each tool call reaches a terminal outcome (executed / error /
 * denied / prompted). Each function owns exactly one side effect:
 *
 *   - `recordToolExecuted` / `recordToolError` / `recordToolDenied` write the
 *     always-on `tool_invocations` audit row (redacting secrets from the
 *     stored input/result), and — for prompted calls — the consent-gated
 *     `permission_decided` lifecycle-telemetry row.
 *   - `recordToolPermissionPrompted` writes the consent-gated
 *     `permission_prompt` lifecycle-telemetry row.
 *   - `logToolFailure` emits the operator-facing failure log.
 *
 * The telemetry-only columns (payload sizes + model attribution) are the
 * single write-time privacy gate for `tool_executed` telemetry: on a confirmed
 * `share_analytics` opt-out they persist as NULL, which the projection's
 * `arg_bytes IS NOT NULL` filter excludes permanently. An unknown consent
 * state (cold cache) populates the columns — NULLing them would destroy the
 * data irreversibly, and consent is enforced again at flush time and platform
 * ingest, so opted-out rows never leave the device. The audit fields
 * themselves (tool name, decision, redacted input/result previews, duration)
 * are unaffected — `tool_invocations` is a local always-on audit log.
 */

import { isAllowDecision, type UserDecision } from "../permissions/types.js";
import { recordLifecycleEvent } from "../persistence/lifecycle-events-store.js";
import { getRawShareAnalytics } from "../platform/consent-cache.js";
import { redactJsonStringLeaves } from "../security/redact-json.js";
import { redactSensitiveFields } from "../security/redaction.js";
import { redactSecrets } from "../security/secret-scanner.js";
import { stringifyToolInput } from "../tools/types.js";
import {
  toAttributionColumns,
  type UsageAttributionColumns,
  type UsageAttributionSnapshot,
} from "../usage/attribution.js";
import { getLogger } from "../util/logger.js";
import {
  recordToolInvocation,
  type ToolInvocationRecord,
} from "./tool-usage-store.js";

const RESULT_PREVIEW_LIMIT = 1000;
const log = getLogger("tool-audit");

interface ExecutedAuditEntry {
  conversationId: string;
  toolName: string;
  input: Record<string, unknown>;
  /** Raw (pre-sanitization) result content shown to the model. */
  resultContent: string;
  /**
   * Byte size of the RAW result content, measured before sensitive-output
   * extraction rewrites it. Only the size leaves the device, never the payload.
   */
  resultBytes: number;
  decision: string;
  riskLevel: string;
  matchedTrustRuleId?: string;
  durationMs: number;
  /** Model attribution at invocation time; `null` when unavailable. */
  attribution: UsageAttributionSnapshot | null;
  /** True when this call was interactively approved via a permission prompt. */
  wasPrompted: boolean;
}

interface ErrorAuditEntry {
  conversationId: string;
  requestId?: string;
  toolName: string;
  input: Record<string, unknown>;
  errorMessage: string;
  /** True for anticipated failures (abort, permission denial, tool errors). */
  isExpected: boolean;
  errorName?: string;
  errorStack?: string;
  riskLevel: string;
  matchedTrustRuleId?: string;
  durationMs: number;
  attribution: UsageAttributionSnapshot | null;
}

interface DeniedAuditEntry {
  conversationId: string;
  toolName: string;
  input: Record<string, unknown>;
  reason: string;
  riskLevel: string;
  matchedTrustRuleId?: string;
  durationMs: number;
  /** True when the denial followed an interactive permission prompt. */
  wasPrompted: boolean;
}

/** Record an audit row for a tool that ran to completion. */
export function recordToolExecuted(entry: ExecutedAuditEntry): void {
  const rawInput = stringifyToolInput(entry.input);
  safeRecord({
    conversationId: entry.conversationId,
    toolName: entry.toolName,
    // Inputs can carry secrets the model typed verbatim (e.g.
    // `export OPENAI_API_KEY=...` in a bash command) — redact before the row
    // reaches the audit store, like the result below.
    input: redactToolInput(entry.input, rawInput),
    result: redactSecrets(entry.resultContent).slice(0, RESULT_PREVIEW_LIMIT),
    decision: entry.decision,
    riskLevel: entry.riskLevel,
    matchedTrustRuleId: entry.matchedTrustRuleId,
    durationMs: entry.durationMs,
    ...telemetryColumns(entry.attribution, rawInput, entry.resultBytes),
  });

  if (entry.wasPrompted && isAllowDecision(entry.decision as UserDecision)) {
    recordToolPermissionDecided(entry.toolName, entry.decision);
  }
}

/** Record an audit row and operator log for a tool that failed. */
export function recordToolError(entry: ErrorAuditEntry): void {
  const rawInput = stringifyToolInput(entry.input);
  const result = `error: ${entry.errorMessage}`;
  safeRecord({
    conversationId: entry.conversationId,
    toolName: entry.toolName,
    input: redactToolInput(entry.input, rawInput),
    result,
    decision: "error",
    riskLevel: entry.riskLevel,
    matchedTrustRuleId: entry.matchedTrustRuleId,
    durationMs: entry.durationMs,
    // The error string is built here and never goes through sensitive-output
    // sanitization, so sizing it directly is already raw.
    ...telemetryColumns(
      entry.attribution,
      rawInput,
      Buffer.byteLength(result, "utf8"),
    ),
  });

  logToolFailure(entry);
}

/** Record an audit row for a tool call blocked before execution. */
export function recordToolDenied(entry: DeniedAuditEntry): void {
  safeRecord({
    conversationId: entry.conversationId,
    toolName: entry.toolName,
    input: redactToolInput(entry.input, stringifyToolInput(entry.input)),
    result: formatDeniedResult(entry.reason),
    decision: "denied",
    riskLevel: entry.riskLevel,
    matchedTrustRuleId: entry.matchedTrustRuleId,
    durationMs: entry.durationMs,
    // No telemetry columns: the tool never executed, and denied rows are
    // filtered out of the tool_executed projection anyway.
  });

  if (entry.wasPrompted) {
    recordToolPermissionDecided(entry.toolName, "deny");
  }
}

/** Record the consent-gated telemetry row for an interactive permission prompt. */
export function recordToolPermissionPrompted(toolName: string): void {
  try {
    recordLifecycleEvent(`permission_prompt:${toolName}`);
  } catch (err) {
    log.warn({ err, toolName }, "Failed to record permission prompt telemetry");
  }
}

function recordToolPermissionDecided(toolName: string, decision: string): void {
  try {
    recordLifecycleEvent(`permission_decided:${toolName}:${decision}`);
  } catch (err) {
    log.warn(
      { err, toolName, decision },
      "Failed to record permission decision telemetry",
    );
  }
}

/** Operator-facing failure log: warn for expected failures, error otherwise. */
function logToolFailure(entry: ErrorAuditEntry): void {
  const meta = {
    tool: entry.toolName,
    execDurationMs: entry.durationMs,
    riskLevel: entry.riskLevel,
    decision: "error",
    error: entry.errorMessage,
    errorName: entry.errorName,
    errorStack: entry.errorStack,
    isExpected: entry.isExpected,
    conversationId: entry.conversationId,
    requestId: entry.requestId,
  };
  if (entry.isExpected) {
    log.warn(meta, "Tool execution failed (expected)");
    return;
  }
  log.error(meta, "Tool execution error");
}

function safeRecord(record: ToolInvocationRecord): void {
  try {
    recordToolInvocation(record);
  } catch (err) {
    log.warn(
      { err, toolName: record.toolName },
      "Failed to record tool invocation",
    );
  }
}

/**
 * Redact secrets from a tool input while keeping the stored audit string
 * parseable JSON. Two passes, both structural (before stringification, so the
 * markers land inside JSON string values with their quotes escaped):
 *
 *  1. Field-key redaction (`redactSensitiveFields`): values under sensitive
 *     KEYS (`password`, `token`, `apiKey`, …) are replaced regardless of
 *     whether the value itself matches a secret pattern — e.g. `password:
 *     "hunter2"` or `value: "…"`, which a pattern scan alone would miss.
 *  2. Pattern redaction (`redactJsonStringLeaves`): secret-shaped values in the
 *     remaining string leaves (API keys, tokens the model typed verbatim).
 *
 * `rawInput` is the canonical pre-redaction serialization (also used for the
 * `argBytes` telemetry fallback — byte sizes must reflect the full payload
 * before truncation and redaction). It is returned untouched when neither pass
 * changed anything, keeping benign inputs byte-identical, and is redacted as
 * plain text if the input can't be walked or re-serialized (e.g. cyclic
 * structures).
 */
function redactToolInput(
  input: Record<string, unknown>,
  rawInput: string,
): string {
  try {
    const fieldRedacted = redactSensitiveFields(input);
    const { value } = redactJsonStringLeaves(fieldRedacted);
    const serialized = JSON.stringify(value);
    return serialized === rawInput ? rawInput : serialized;
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
 * Telemetry-only columns (payload sizes + model attribution). NULLed only on a
 * confirmed `share_analytics` opt-out — the projection's `arg_bytes IS NOT
 * NULL` filter excludes NULL rows permanently (the same mechanism that
 * excludes legacy pre-migration rows, see tool-executed-events-store.ts), so
 * an unknown consent state (cold cache) must populate the columns rather than
 * destroy them. Consent is enforced again at flush time and platform ingest,
 * so opted-out rows never ship.
 */
function telemetryColumns(
  attribution: UsageAttributionSnapshot | null,
  rawInput: string,
  resultBytes: number,
): TelemetryColumns {
  if (getRawShareAnalytics() === false) {
    return NULL_TELEMETRY_COLUMNS;
  }
  return {
    argBytes: Buffer.byteLength(rawInput, "utf8"),
    resultBytes,
    ...toAttributionColumns(attribution),
  };
}

function formatDeniedResult(reason: string): string {
  if (reason.startsWith("Blocked by deny rule:")) {
    return `denied: ${reason}`;
  }
  return "denied";
}
