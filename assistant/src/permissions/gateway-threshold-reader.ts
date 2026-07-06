/**
 * Gateway-backed auto-approve threshold reader.
 *
 * Reads thresholds from the gateway via IPC. The gateway is the sole source
 * of truth for auto-approve thresholds. When the gateway is unreachable,
 * defaults to "none" (Strict) so no tools are auto-approved without an
 * explicit gateway-supplied threshold.
 */

import type {
  ResolveChannelPermissionRequest,
  ResolvedChannelPermission,
} from "@vellumai/gateway-client";

import { ipcCall } from "../ipc/gateway-client.js";
import { getLogger } from "../util/logger.js";
import type {
  AutoApproveThreshold,
  ExecutionContext,
} from "./approval-policy.js";

const log = getLogger("gateway-threshold-reader");

// ── Types ────────────────────────────────────────────────────────────────────

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

// ── Channel-permission cell cache (5s TTL) ───────────────────────────────────
// The permission-matrix cell for (adapter × channel-type × channel-ID ×
// contact-type). Same short TTL as the conversation cache: a guardian can
// edit cells mid-conversation, and each cache entry covers at most a few
// tool calls within a turn. Negative entries (no cell) are cached too.

const channelPermissionCellCache = new Map<
  string,
  { resolved: ResolvedChannelPermission | null; timestamp: number }
>();
const CELL_CACHE_TTL_MS = 5_000;

function cellCacheKey(query: ResolveChannelPermissionRequest): string {
  // JSON-encoded tuple rather than a delimiter join: channelExternalId is
  // provider-supplied text, and an unescaped delimiter inside it could
  // collide two coordinates onto one cache entry (letting a negative entry
  // for one coordinate suppress a real cell for another).
  return JSON.stringify([
    query.adapter,
    query.channelType ?? null,
    query.channelExternalId ?? null,
    query.contactType,
  ]);
}

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
  if (!state) {
    return;
  }
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
  channelPermissionCellCache.clear();
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function mapExecutionContextToField(
  executionContext: ExecutionContext,
): keyof GlobalThresholds {
  if (executionContext === "conversation") {
    return "interactive";
  }
  if (executionContext === "headless") {
    return "headless";
  }
  return "autonomous";
}

function isValidThreshold(value: string): value is AutoApproveThreshold {
  return (
    value === "none" ||
    value === "low" ||
    value === "medium" ||
    value === "high"
  );
}

/**
 * Result of a cell lookup. `ok: false` is a transport failure — distinct
 * from `resolved: null` (a successful round-trip that found no cell) so the
 * pre-prompt refresh path can keep its decision instead of falling through
 * to a possibly-looser global threshold.
 */
export type ChannelPermissionCellResult =
  | { ok: true; resolved: ResolvedChannelPermission | null }
  | { ok: false };

/**
 * Resolve the permission-matrix cell for a channel/actor coordinate via the
 * gateway (`resolve_channel_permission_threshold` IPC): the winning cell
 * threshold + scope, or a null resolution when no cascade level has a cell.
 *
 * Transport failures are not cached, so a transient IPC failure cannot
 * suppress a real cell for the TTL window.
 */
export async function resolveChannelPermissionCell(
  query: ResolveChannelPermissionRequest,
  options?: { bypassCache?: boolean },
): Promise<ChannelPermissionCellResult> {
  const key = cellCacheKey(query);
  if (!options?.bypassCache) {
    const cached = channelPermissionCellCache.get(key);
    if (cached && Date.now() - cached.timestamp < CELL_CACHE_TTL_MS) {
      return { ok: true, resolved: cached.resolved };
    }
  }

  const result = (await ipcCall("resolve_channel_permission_threshold", {
    adapter: query.adapter,
    channelType: query.channelType,
    channelExternalId: query.channelExternalId,
    contactType: query.contactType,
  })) as { resolved: ResolvedChannelPermission | null } | null | undefined;

  // The route contract always wraps the resolution (`{ resolved: … }`), so a
  // bare null/undefined is a transport failure or a malformed response —
  // treated as a failure (uncached, hot path falls to global, refresh keeps
  // its prompt) rather than dereferenced.
  if (result == null) {
    noteFailure(
      "channel_permission_cell",
      { adapter: query.adapter, contactType: query.contactType },
      "IPC call failed for channel-permission cell lookup",
    );
    return { ok: false };
  }

  noteSuccess("channel_permission_cell");
  const resolved =
    result.resolved && isValidThreshold(result.resolved.threshold)
      ? result.resolved
      : null;
  channelPermissionCellCache.set(key, { resolved, timestamp: Date.now() });
  return { ok: true, resolved };
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
  cellQuery?: ResolveChannelPermissionRequest,
): Promise<AutoApproveThreshold> {
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

  // Channel-permission matrix cell: sits between the conversation override
  // (most specific) and the global defaults in the threshold cascade. A
  // transport failure falls through to global — same direction as a failed
  // conversation-override read.
  if (cellQuery) {
    const cell = await resolveChannelPermissionCell(cellQuery);
    if (cell.ok && cell.resolved) {
      return cell.resolved.threshold;
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

/**
 * Re-read the auto-approve threshold from the gateway, bypassing both
 * caches, and prime them with the fresh values.
 *
 * Used by the permission checker immediately before surfacing an
 * interactive prompt: the cached snapshot (5s conversation TTL with
 * negative caching, 30s global TTL) may predate a threshold change the
 * user just made — e.g. switching to Full access — because no threshold
 * write path invalidates these in-process caches (the web picker writes
 * through the gateway HTTP route, the desktop picker through the
 * `set_conversation_threshold` IPC). Prompting from a stale threshold
 * directly contradicts the user's visible setting. A prompt is already a
 * rare, user-visible interruption, so the extra IPC round-trip is cheap
 * relative to a wrong prompt.
 *
 * Returns the freshly-resolved threshold, or `null` when the gateway
 * could not be reached. Callers must keep their original decision on
 * `null` — fail toward prompting, never toward silent approval.
 *
 * Failure invariant: a transport failure must never produce a looser
 * outcome than the last successful read. That is why a failed
 * conversation-override read or a failed channel-permission-cell read
 * returns `null` here instead of falling through to the global threshold
 * (the direction {@link getAutoApproveThreshold} takes): the caller has
 * already computed a prompt from a threshold that consulted those layers,
 * and without re-reading the more-specific layer we cannot know it is
 * not stricter than global. Falling through would let a transient IPC
 * blip re-evaluate a Strict-cell prompt against a looser global and
 * silently auto-approve — `null` keeps the prompt instead. The two
 * functions therefore differ deliberately: the hot path must produce a
 * usable threshold, the refresh only ever *replaces* a prompt.
 */
export async function refreshAutoApproveThreshold(
  conversationId: string | undefined,
  executionContext?: ExecutionContext,
  cellQuery?: ResolveChannelPermissionRequest,
): Promise<AutoApproveThreshold | null> {
  const ctx: ExecutionContext = executionContext ?? "conversation";

  if (ctx === "conversation" && conversationId) {
    const result = (await ipcCall("get_conversation_threshold", {
      conversationId,
    })) as ConversationThreshold | null | undefined;

    if (result === undefined) {
      noteFailure(
        "conversation_threshold",
        { conversationId },
        "IPC call failed for conversation threshold refresh, keeping cached decision",
      );
      return null;
    }
    noteSuccess("conversation_threshold");
    if (result && isValidThreshold(result.threshold)) {
      conversationThresholdCache.set(conversationId, {
        threshold: result.threshold,
        timestamp: Date.now(),
      });
      return result.threshold;
    }
    // No override (or unexpected shape) — prime the negative cache and
    // fall through to a fresh global read.
    conversationThresholdCache.set(conversationId, {
      threshold: null,
      timestamp: Date.now(),
    });
  }

  // Fresh cell read (cache bypassed, then primed). A transport failure here
  // returns null — the caller keeps its prompt rather than falling through
  // to a global threshold that may be looser than the unreadable cell
  // (e.g. a Strict cell + a "high" global: falling through would flip the
  // prompt into an auto-approve on an IPC blip). See the failure invariant
  // in the function JSDoc.
  if (cellQuery) {
    const cell = await resolveChannelPermissionCell(cellQuery, {
      bypassCache: true,
    });
    if (!cell.ok) {
      return null;
    }
    if (cell.resolved) {
      return cell.resolved.threshold;
    }
  }

  try {
    const result = (await ipcCall(
      "get_global_thresholds",
    )) as GlobalThresholds | null;
    if (!result) {
      throw new Error("Gateway IPC returned no result for global thresholds");
    }
    noteSuccess("global_thresholds");
    cachedGlobalThresholds = result;
    cachedGlobalTimestamp = Date.now();
    const value = result[mapExecutionContextToField(ctx)];
    return isValidThreshold(value) ? value : null;
  } catch (err) {
    noteFailure(
      "global_thresholds",
      { error: String(err) },
      "Failed to refresh global thresholds, keeping cached decision",
    );
    return null;
  }
}
