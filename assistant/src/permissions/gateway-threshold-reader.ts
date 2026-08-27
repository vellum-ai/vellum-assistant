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
import {
  collapseChannelThresholdForContact,
  effectiveChannelCellThreshold,
} from "./channel-permission-query.js";

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

// ── Contact threshold cache (5s TTL) ─────────────────────────────────────────
// Same short TTL as the conversation override: the owner can change a
// contact's ceiling mid-conversation, but a burst of tool calls in one
// turn should not pay an IPC round-trip each time. Negative entries (no
// ceiling) are cached too. Transport failures are not.

const contactThresholdCache = new Map<
  string,
  { threshold: string | null; timestamp: number }
>();
const CONTACT_CACHE_TTL_MS = 5_000;

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
  contactThresholdCache.clear();
  channelPermissionCellCache.clear();
}

/**
 * Drop the cached ceiling for one contact.
 */
export function invalidateContactThresholdCache(contactId: string): void {
  contactThresholdCache.delete(contactId);
}

/**
 * Drop every cached contact ceiling. `contacts_changed` calls this so the
 * next approval re-reads after any contact ACL write.
 */
export function invalidateAllContactThresholdCaches(): void {
  contactThresholdCache.clear();
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

type ContactThresholdLookup =
  | { status: "hit"; threshold: AutoApproveThreshold }
  | { status: "miss" }
  | { status: "failure" };

/**
 * Read the contact-level auto-approve ceiling from the gateway.
 *
 * A hit is a usable `none | low | medium | high`. A miss is an unknown
 * contact, an unset or corrupt column, or an unexpected response shape.
 * A failure is a transport error and is never cached, so a later call
 * can still see a real ceiling.
 */
async function lookupContactThreshold(
  contactId: string,
  options?: { bypassCache?: boolean },
): Promise<ContactThresholdLookup> {
  if (!options?.bypassCache) {
    const cached = contactThresholdCache.get(contactId);
    if (cached && Date.now() - cached.timestamp < CONTACT_CACHE_TTL_MS) {
      if (cached.threshold !== null && isValidThreshold(cached.threshold)) {
        return { status: "hit", threshold: cached.threshold };
      }
      return { status: "miss" };
    }
  }

  const result = (await ipcCall("get_contact_threshold", {
    contactId,
  })) as ConversationThreshold | null | undefined;

  if (result === undefined) {
    noteFailure(
      "contact_threshold",
      { contactId },
      "IPC call failed for contact threshold",
    );
    return { status: "failure" };
  }

  noteSuccess("contact_threshold");
  if (result && isValidThreshold(result.threshold)) {
    contactThresholdCache.set(contactId, {
      threshold: result.threshold,
      timestamp: Date.now(),
    });
    return { status: "hit", threshold: result.threshold };
  }

  contactThresholdCache.set(contactId, {
    threshold: null,
    timestamp: Date.now(),
  });
  return { status: "miss" };
}

/**
 * The contact-level auto-approve ceiling for `contactId`, or `null` when
 * the contact has none (unset, unknown, corrupt) or the lookup failed.
 * Approval-time lift uses this so a live `contacts` row is the source of
 * truth.
 */
export async function getContactAutoApproveThreshold(
  contactId: string | undefined,
): Promise<AutoApproveThreshold | null> {
  if (!contactId) {
    return null;
  }
  const result = await lookupContactThreshold(contactId);
  return result.status === "hit" ? result.threshold : null;
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
 * gateway (`resolve_channel_permission_threshold` IPC): the raw winning cell
 * threshold + scope, or a null resolution when no cascade level has a cell.
 * What a resolution authorizes for the actor — the two-level collapse and
 * the room default — is `effectiveChannelCellThreshold`'s single rule;
 * consumers go through it rather than reading the threshold directly.
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

/**
 * The room default a cell-less coordinate inherits for non-guardian contact
 * types: the owner's global interactive threshold, collapsed to the two
 * levels a channel distinguishes. This is the level the picker's "· default"
 * marker and the legend advertise, so resolving it here is what keeps the
 * displayed default and the enforced one the same value. Returns `undefined`
 * when the global thresholds cannot be read — callers fail safe, and the
 * shared fetch's own failure accounting covers the logging.
 */
async function resolveContactRoomDefaultThreshold(options?: {
  bypassCache?: boolean;
}): Promise<AutoApproveThreshold | undefined> {
  try {
    const global = await fetchGlobalThresholds(options);
    if (!isValidThreshold(global.interactive)) {
      return undefined;
    }
    return collapseChannelThresholdForContact(global.interactive);
  } catch {
    return undefined;
  }
}

/**
 * The `noCellDefault` argument for {@link effectiveChannelCellThreshold}:
 * derived only when it can matter — a successful walk that found no cell,
 * for a non-guardian contact type. One guard for every cell consumer, so
 * none of them can apply the room default to a guardian query or pay the
 * global read on a path where the rule would discard it.
 */
export async function channelNoCellDefault(
  cell: ChannelPermissionCellResult,
  contactType: ResolveChannelPermissionRequest["contactType"],
  options?: { bypassCache?: boolean },
): Promise<AutoApproveThreshold | undefined> {
  if (!cell.ok || cell.resolved || contactType === "guardian") {
    return undefined;
  }
  return resolveContactRoomDefaultThreshold(options);
}

// ── Main export ──────────────────────────────────────────────────────────────

/**
 * Read the auto-approve threshold from the gateway via IPC.
 *
 * Cascade, most specific first:
 * 1. Per-conversation override (when `"conversation"` context has an id)
 * 2. Contact-level ceiling (when `contactId` looks up a usable threshold)
 * 3. Channel-permission matrix cell (collapsed for contacts)
 * 4. Global defaults for the execution context
 *
 * The contact ceiling is the owner's override for that person, read live
 * from the gateway `contacts` row. It is not collapsed to the channel's
 * two levels, so `medium` and `high` can authorize sandbox bash. A miss
 * (unset, unknown, transport failure) inherits the cell / global cascade.
 *
 * Caches global thresholds for 30 seconds to avoid hammering the gateway.
 * On any IPC error or unexpected response, returns `"none"` (Strict) so
 * no tools are silently auto-approved when the gateway is unreachable.
 */
export async function getAutoApproveThreshold(
  conversationId: string | undefined,
  executionContext?: ExecutionContext,
  cellQuery?: ResolveChannelPermissionRequest,
  contactId?: string,
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

  // Contact-level ceiling: the owner's override for this person, looked up
  // by contact id. Beats the collapsed room / trust-class cascade.
  // Conversation override above is more specific (this chat) and still
  // wins when set. A miss or transport failure falls through.
  if (contactId) {
    const contact = await lookupContactThreshold(contactId);
    if (contact.status === "hit") {
      return contact.threshold;
    }
  }

  // Channel-permission matrix cell: for non-guardian actors this layer is
  // total in every direction — a successful walk that finds no cell resolves
  // the room default (the collapsed global), and a failed read resolves
  // Strict, so a contact's turn never consumes a raw global threshold. An
  // unreadable cell may be a Strict cell (this module's header rule: an
  // unreachable gateway auto-approves nothing). Guardian queries fall
  // through to the global block below in both cases — their lane.
  if (cellQuery) {
    const cell = await resolveChannelPermissionCell(cellQuery);
    if (!cell.ok && cellQuery.contactType !== "guardian") {
      return "none";
    }
    const effective = effectiveChannelCellThreshold(
      cell,
      cellQuery.contactType,
      await channelNoCellDefault(cell, cellQuery.contactType),
    );
    if (effective !== undefined) {
      return effective;
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

async function fetchGlobalThresholds(options?: {
  bypassCache?: boolean;
}): Promise<GlobalThresholds> {
  const now = Date.now();
  if (
    !options?.bypassCache &&
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
 * user just made (for example switching to Full access) because no
 * conversation or global write path invalidates those caches (the web
 * picker writes through the gateway HTTP route, the desktop picker
 * through the `set_conversation_threshold` IPC). A `contacts_changed`
 * event clears every cached contact ceiling after a contact ACL write.
 * Prompting from a stale threshold directly contradicts the user's
 * visible setting. A prompt is already a rare, user-visible
 * interruption, so the extra IPC round-trip is cheap relative to a
 * wrong prompt.
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
  contactId?: string,
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

  if (contactId) {
    const contact = await lookupContactThreshold(contactId, {
      bypassCache: true,
    });
    if (contact.status === "failure") {
      return null;
    }
    if (contact.status === "hit") {
      return contact.threshold;
    }
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
    // The refresh exists to see writes the caches hide, so the derived
    // default reads the globals fresh (and primes the cache) exactly like
    // the cell read above bypasses the cell cache.
    const effective = effectiveChannelCellThreshold(
      cell,
      cellQuery.contactType,
      await channelNoCellDefault(cell, cellQuery.contactType, {
        bypassCache: true,
      }),
    );
    if (effective !== undefined) {
      return effective;
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
