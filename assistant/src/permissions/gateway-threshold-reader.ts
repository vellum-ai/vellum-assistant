/**
 * Gateway-backed auto-approve threshold reader.
 *
 * Reads thresholds from the gateway via IPC. The gateway is the sole source
 * of truth for auto-approve thresholds. When the gateway is unreachable,
 * defaults to "none" (Strict) so no tools are auto-approved without an
 * explicit gateway-supplied threshold.
 */

import { ipcCall } from "../ipc/gateway-client.js";
import { getLogger } from "../util/logger.js";
import type { ExecutionContext } from "./approval-policy.js";

const log = getLogger("gateway-threshold-reader");

// ── Types ────────────────────────────────────────────────────────────────────

type Threshold = "none" | "low" | "medium" | "high";

interface GlobalThresholds {
  interactive: string;
  autonomous: string;
  headless: string;
}

interface ConversationThreshold {
  threshold: string;
}

// ── Global threshold cache (30s TTL) ─────────────────────────────────────────

let cachedGlobalThresholds: GlobalThresholds | null = null;
let cachedGlobalTimestamp = 0;
const GLOBAL_CACHE_TTL_MS = 30_000;

// ── Conversation threshold cache (5s TTL) ────────────────────────────────────
// Shorter TTL than global because the user can change mid-conversation via the
// picker UI, but still avoids a network roundtrip on every single tool call
// within a burst.

const conversationThresholdCache = new Map<
  string,
  { threshold: string | null; timestamp: number }
>();
const CONVERSATION_CACHE_TTL_MS = 5_000;

// ── Failure-coalescing log helper ────────────────────────────────────────────
// When the gateway IPC socket is broken (e.g. the path was unlinked from
// disk), every threshold lookup fails with ENOENT on the hot path. Without
// coalescing the per-call WARN drowns the actual signal ("Strict-when-
// Relaxed because the gateway lost its socket") in its own log spam.
//
// Each `op` (e.g. "conversation_threshold", "global_thresholds") emits at
// most one WARN per {@link DEFAULT_FAILURE_WARN_INTERVAL_MS} window. The
// first failure in a streak WARNs immediately so failures aren't lost. When
// the IPC starts working again, an INFO records the streak duration and
// how many calls were swallowed — that's the cue dashboards should alert
// on.

interface FailureState {
  consecutiveFailures: number;
  firstFailureAt: number;
  lastWarnAt: number;
}

const DEFAULT_FAILURE_WARN_INTERVAL_MS = 30_000;
let failureWarnIntervalMs = DEFAULT_FAILURE_WARN_INTERVAL_MS;
const failureStateByOp = new Map<string, FailureState>();

function noteFailure(
  op: string,
  fields: Record<string, unknown>,
  message: string,
): void {
  const now = Date.now();
  const state = failureStateByOp.get(op);
  if (!state) {
    failureStateByOp.set(op, {
      consecutiveFailures: 1,
      firstFailureAt: now,
      lastWarnAt: now,
    });
    log.warn(
      {
        ...fields,
        op,
        consecutiveFailures: 1,
        event: "ipc_threshold_failure",
      },
      message,
    );
    return;
  }
  state.consecutiveFailures += 1;
  if (now - state.lastWarnAt >= failureWarnIntervalMs) {
    log.warn(
      {
        ...fields,
        op,
        consecutiveFailures: state.consecutiveFailures,
        streakDurationMs: now - state.firstFailureAt,
        event: "ipc_threshold_failure",
      },
      message,
    );
    state.lastWarnAt = now;
  }
}

function noteSuccess(op: string): void {
  const state = failureStateByOp.get(op);
  if (!state) return;
  log.info(
    {
      op,
      swallowedFailures: state.consecutiveFailures,
      streakDurationMs: Date.now() - state.firstFailureAt,
      event: "ipc_threshold_recovered",
    },
    "Gateway IPC threshold call recovered after failure streak",
  );
  failureStateByOp.delete(op);
}

/** Test-only: clear the failure-coalescing state. */
export function _resetFailureCoalesceForTesting(): void {
  failureStateByOp.clear();
  failureWarnIntervalMs = DEFAULT_FAILURE_WARN_INTERVAL_MS;
}

/**
 * Test-only: read a snapshot of the failure-coalescing state for a given
 * op. Returns `undefined` when no streak is in progress.
 */
export function _getFailureStateForTesting(
  op: string,
): Readonly<FailureState> | undefined {
  const state = failureStateByOp.get(op);
  return state ? { ...state } : undefined;
}

/** Test-only: override the WARN cadence. Pass {@link DEFAULT_FAILURE_WARN_INTERVAL_MS} to reset. */
export function _setFailureWarnIntervalForTesting(intervalMs: number): void {
  failureWarnIntervalMs = intervalMs;
}

/**
 * Clear the global threshold cache. Exported for testing.
 */
export function _clearGlobalCacheForTesting(): void {
  cachedGlobalThresholds = null;
  cachedGlobalTimestamp = 0;
  conversationThresholdCache.clear();
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function mapExecutionContextToField(
  executionContext: ExecutionContext,
): keyof GlobalThresholds {
  if (executionContext === "conversation") return "interactive";
  if (executionContext === "headless") return "headless";
  return "autonomous";
}

function isValidThreshold(value: string): value is Threshold {
  return (
    value === "none" ||
    value === "low" ||
    value === "medium" ||
    value === "high"
  );
}

// ── Main export ──────────────────────────────────────────────────────────────

/**
 * Read the auto-approve threshold from the gateway via IPC.
 *
 * For `"conversation"` context with a `conversationId`, checks for a
 * per-conversation override first. Falls through to global defaults when
 * the conversation override is absent.
 *
 * Caches global thresholds for 30 seconds to avoid hammering the gateway.
 * On any IPC error or unexpected response, returns `"none"` (Strict) so
 * no tools are silently auto-approved when the gateway is unreachable.
 */
export async function getAutoApproveThreshold(
  conversationId: string | undefined,
  executionContext?: ExecutionContext,
): Promise<Threshold> {
  const ctx: ExecutionContext = executionContext ?? "conversation";

  // For conversation context with a conversationId, try per-conversation override first
  if (ctx === "conversation" && conversationId) {
    // Check cache first (5s TTL) — includes negative entries (no override)
    const cached = conversationThresholdCache.get(conversationId);
    if (cached && Date.now() - cached.timestamp < CONVERSATION_CACHE_TTL_MS) {
      if (cached.threshold === null) {
        // Negative cache hit — no override exists, fall through to global
      } else if (isValidThreshold(cached.threshold)) {
        return cached.threshold;
      }
    } else {
      // ipcCall() returns undefined on transport failure (socket not found,
      // timeout, etc.) and null when the gateway explicitly says "no override".
      // On transport failure, fall through to the global threshold without
      // poisoning the cache — a transient IPC failure must not cause subsequent
      // approval checks to skip a real override for up to 5 seconds.
      const result = (await ipcCall("get_conversation_threshold", {
        conversationId,
      })) as ConversationThreshold | null | undefined;

      if (result === undefined) {
        noteFailure(
          "conversation_threshold",
          { conversationId },
          "IPC call failed for conversation threshold override, falling through to global",
        );
        // Fall through to global threshold fetch below.
      } else {
        // Any defined response (including a null "no override") is a
        // successful round-trip — clear any in-progress failure streak so
        // dashboards see the recovery.
        noteSuccess("conversation_threshold");
        if (result && isValidThreshold(result.threshold)) {
          conversationThresholdCache.set(conversationId, {
            threshold: result.threshold,
            timestamp: Date.now(),
          });
          return result.threshold;
        }
        // result === null (or an unexpected shape) — cache the negative result
        // and fall through to global defaults.
        conversationThresholdCache.set(conversationId, {
          threshold: null,
          timestamp: Date.now(),
        });
      }
    }
  }

  // Fetch global thresholds (with 30s cache)
  try {
    const global = await fetchGlobalThresholds();
    const field = mapExecutionContextToField(ctx);
    const value = global[field];
    if (isValidThreshold(value)) {
      return value;
    }
    // Unexpected value from gateway — default to "none" (Strict).
    log.warn(
      { field, value },
      "Gateway returned unexpected threshold value, defaulting to none",
    );
    return "none";
  } catch (err) {
    // Gateway unreachable — default to "none" (Strict) so no tools are
    // silently auto-approved when the gateway is down.
    noteFailure(
      "global_thresholds",
      { error: String(err) },
      "Failed to fetch global thresholds, defaulting to none",
    );
    return "none";
  }
}

async function fetchGlobalThresholds(): Promise<GlobalThresholds> {
  const now = Date.now();
  if (
    cachedGlobalThresholds &&
    now - cachedGlobalTimestamp < GLOBAL_CACHE_TTL_MS
  ) {
    return cachedGlobalThresholds;
  }

  const result = (await ipcCall(
    "get_global_thresholds",
  )) as GlobalThresholds | null;

  if (!result) {
    throw new Error("Gateway IPC returned no result for global thresholds");
  }

  noteSuccess("global_thresholds");
  cachedGlobalThresholds = result;
  cachedGlobalTimestamp = Date.now();
  return result;
}
