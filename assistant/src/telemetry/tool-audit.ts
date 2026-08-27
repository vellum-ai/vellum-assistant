/**
 * Direct terminals for tool-execution auditing and telemetry.
 *
 * The executor and its permission/approval collaborators call these functions
 * inline as each tool call reaches a terminal outcome (executed / error /
 * denied / prompted). Each function owns exactly one side effect:
 *
 *   - `recordToolExecuted` / `recordToolError` / `recordToolDenied` write the
 *     always-on `tool_invocations` audit row (redacting secrets from the
 *     stored input/result).
 *   - `recordToolPermissionPrompted` / `recordToolPermissionDecided` write the
 *     consent-gated `permission_prompt` and `permission_decided`
 *     lifecycle-telemetry rows. Both are called from the one site that owns an
 *     interactive prompt (`tools/permission-checker.ts`), so every prompt has
 *     exactly one decision and the two series reconcile.
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

import {
  type LifecycleEventAttributes,
  recordLifecycleEvent,
} from "../persistence/lifecycle-events-store.js";
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
}

/**
 * How an interactive permission prompt ended.
 *
 * `allow` / `deny` are answers a human gave. `abandoned` covers every way a
 * prompt stops without one: it timed out, a new user message superseded it,
 * the turn was cancelled, or the prompter was disposed (client disconnect /
 * conversation teardown). The daemon resolves all of those to a deny for the
 * agent loop, so without this bucket they are indistinguishable from a human
 * saying no.
 */
export type PermissionPromptOutcome = "allow" | "deny" | "abandoned";

/**
 * Grouping dimensions recorded on both halves of a permission-prompt pair.
 * The tool and its risk are always known at the prompt site, so they tighten
 * to required; the rest are the lifecycle attributes as declared. Metadata
 * only: never a file path, a command string, or any tool input.
 */
export interface PermissionPromptTelemetry extends LifecycleEventAttributes {
  toolName: string;
  riskLevel: string;
}

/**
 * Server bounds on the lifecycle `event_name` and `tool_name`. A field over
 * its bound fails validation, and a failed event is acked and discarded rather
 * than retried, so both are clamped here. `event_name` has one variable-length
 * part (the tool name, which can be a long `mcp__server__tool` id) and is much
 * the tighter of the two, which is why `tool_name` carries the full-length
 * value consumers join a prompt to its decision on.
 */
const LIFECYCLE_EVENT_NAME_LIMIT = 64;
const LIFECYCLE_TOOL_NAME_LIMIT = 255;

function permissionEventName(
  prefix: string,
  toolName: string,
  suffix: string,
): string {
  const budget = LIFECYCLE_EVENT_NAME_LIMIT - prefix.length - suffix.length;
  return `${prefix}${toolName.slice(0, Math.max(budget, 0))}${suffix}`;
}

function recordPermissionLifecycleEvent(
  eventName: string,
  entry: PermissionPromptTelemetry,
  failureMessage: string,
): void {
  try {
    recordLifecycleEvent(eventName, {
      ...entry,
      toolName: entry.toolName.slice(0, LIFECYCLE_TOOL_NAME_LIMIT),
    });
  } catch (err) {
    log.warn({ err, eventName, toolName: entry.toolName }, failureMessage);
  }
}

/** Record the consent-gated telemetry row for an interactive permission prompt. */
export function recordToolPermissionPrompted(
  entry: PermissionPromptTelemetry,
): void {
  recordPermissionLifecycleEvent(
    permissionEventName("permission_prompt:", entry.toolName, ""),
    entry,
    "Failed to record permission prompt telemetry",
  );
}

/** Record the consent-gated telemetry row for how that prompt ended. */
export function recordToolPermissionDecided(
  entry: PermissionPromptTelemetry,
  outcome: PermissionPromptOutcome,
): void {
  recordPermissionLifecycleEvent(
    permissionEventName("permission_decided:", entry.toolName, `:${outcome}`),
    entry,
    "Failed to record permission decision telemetry",
  );
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
