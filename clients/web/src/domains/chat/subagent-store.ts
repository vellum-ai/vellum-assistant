/**
 * Zustand store for subagent lifecycle state.
 *
 * Maintains a map of SubagentEntry records keyed by subagentId, with an
 * ordered list of IDs for stable rendering. Direct named actions call
 * `set()` to apply pure transitions so UI components can derive display
 * state deterministically.
 *
 * @see https://zustand.docs.pmnd.rs/guides/flux-inspired-practice
 * @see https://zustand.docs.pmnd.rs/guides/updating-state
 */

import { create } from "zustand";

import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import {
  subagentsByIdAbortPost,
  subagentsReconcileGet,
} from "@/generated/daemon/sdk.gen";
import type { SubagentsReconcileGetResponse } from "@/generated/daemon/types.gen";
import { useConversationStore } from "@/stores/conversation-store";
import { createSelectors } from "@/utils/create-selectors";
import { recordDiagnostic } from "@/lib/diagnostics";
import { captureError } from "@/lib/sentry/capture-error";
import {
  SubagentStatusSchema,
  type SubagentStatus,
  type SubagentInnerEvent,
} from "@vellumai/assistant-api";
import type { ToolActivityMetadata } from "@/assistant/web-activity-types";
import { isActiveStatus, shouldApplyStatus } from "@/utils/subagent-status";
import { supportsSubagentsReconcile } from "@/lib/backwards-compat/subagents-reconcile";
import { fetchSubagentDetail } from "./fetch-subagent-detail";
import { mapDetailEvents } from "./map-detail-events";
import { setToolUseAnchor } from "./store-helpers/by-tool-use-id-index";
import {
  canAddressSubagentDetail,
  resolveSubagentDetailConversationId,
} from "./store-helpers/subagent-detail-addressability";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface SubagentTimelineEvent {
  id: string;
  type: "text" | "tool_call" | "tool_result" | "error";
  content: string;
  toolName?: string;
  isError?: boolean;
  timestamp: number;
  /**
   * Tool-use block ID copied from the daemon's `tool_use_start` /
   * `tool_result` envelopes. Lets the UI pair a result with its
   * originating call when a subagent makes parallel calls to the same
   * tool (which `toolName` alone cannot disambiguate).
   */
  toolUseId?: string;
  /**
   * `content` remains the ≤120-char summary that drives labels; `input`/
   * `result` are the raw payloads used only by the nested tool-detail view.
   */
  input?: Record<string, unknown>;
  result?: string;
  /**
   * Resolved web-search query, captured from a `tool_result` event's
   * `activityMetadata.webSearch.query`. Anthropic web_search resolves its
   * `{query}` input only at content_block_stop, so the originating
   * `tool_use_start` arrives with empty `input` and the query is otherwise
   * absent live — it rides through on the matching result's metadata. The
   * history/detail path rebuilds the query from the persisted resolved input
   * instead, so this is only the live source.
   */
  searchQuery?: string;
}

export interface SubagentEntry {
  subagentId: string;
  label: string;
  objective: string;
  status: SubagentStatus;
  isFork: boolean;
  error?: string;
  inputTokens: number;
  outputTokens: number;
  spawnedAt: number;
  events: SubagentTimelineEvent[];
  /** The subagent's own conversation ID, used to fetch detail data. */
  conversationId?: string;
  /**
   * Conversation ID of the PARENT conversation whose turn spawned this
   * subagent. Scopes the Active-Subagents overlay to the viewed conversation
   * (`useActiveSubagentIds`); never used to fetch detail.
   */
  parentConversationId?: string;
  /** StableId of the parent assistant message that spawned this subagent. */
  parentMessageStableId?: string;
  /** Daemon UUID of the parent assistant message. Stable across reloads. */
  parentMessageId?: string;
  /**
   * Tool-use block ID of the spawning tool call in the parent conversation.
   * Lets the transcript anchor the inline card to its exact spawn tool call
   * regardless of optimistic→reconciled message id swaps. Indexed in
   * `byToolUseId`. Optional — older daemons omit it.
   */
  parentToolUseId?: string;
  /**
   * True on a stub entry created from mid-run evidence (a `subagent_event`
   * or `subagent_status_changed` for an id with no entry — the
   * `subagent_spawned` event was missed or the store was reset) whose
   * authoritative detail fetch is still outstanding. While set,
   * `receiveEvent` drops incoming timeline events instead of appending:
   * they're already part of the daemon-side history the fetch returns, and
   * appending them would make `loadDetail` discard that full history in
   * favor of the partial live suffix. Cleared by `loadDetail`, and by
   * `fetchDetailIfNeeded`'s failure path so the live stream degrades to
   * append-only instead of dropping forever.
   */
  hydrationPending?: boolean;
  /**
   * True once a detail fetch for this entry has completed at least once:
   * success, empty, or failure. Until then, a terminal entry with no events is
   * presumed to have an unloaded timeline and renders as loading rather than
   * "0 steps". Cleared by `changeStatus` when a still-eventless entry goes
   * terminal: a mid-run fetch that settled empty says nothing about the final
   * timeline, and leaving the flag set would stop the card's render-driven
   * fetch (`useSubagentCardData`) from ever asking for it.
   */
  detailSettled?: boolean;
}

export interface SubagentState {
  byId: Record<string, SubagentEntry>;
  orderedIds: string[];
  /** Subagent IDs whose terminal status event carried final usage data.
   *  Further `updateUsage` calls for these IDs are no-ops to prevent
   *  double-counting. */
  terminalUsageIds: Set<string>;
  /**
   * Indexed view of `byId` keyed by parent assistant message id. Each entry
   * is registered under up to two keys — `parentMessageStableId` (set during
   * live streaming) and `parentMessageId` (set when subagent state is
   * reconstructed from history) — so consumers can look up entries by
   * either id without walking the full map. Entries inside each bucket are
   * sorted by `spawnedAt` ascending, matching the historical
   * `findSubagentEntriesForMessage` contract.
   *
   * Identity is stable across unrelated mutations: the map (and the array
   * for any given parent) only changes when entries are added, removed, or
   * have their parent ids change. Per-event mutations on a subagent leave
   * the bucket untouched so message-body subscribers don't re-render.
   */
  byParent: Map<string, SubagentEntry[]>;
  /**
   * Index of spawning tool-use block id → subagentId. Populated when a
   * `subagent_spawned` event carries `parentToolUseId`, letting the
   * transcript anchor the inline card to its exact spawn tool call even
   * after the optimistic streaming message id is reconciled away.
   *
   * The map reference is only replaced when a new `parentToolUseId` is
   * indexed; unrelated mutations keep it stable so subscribers don't
   * re-render.
   */
  byToolUseId: Map<string, string>;
  /**
   * Tracks which subagents have had their detail fetched, keyed by
   * subagentId → spawnedAt at fetch time. Prevents redundant network
   * requests while still allowing re-fetches when store rebuilds
   * (e.g. background TanStack Query refetches) produce a new spawnedAt.
   */
  fetchedAt: Map<string, number>;
}

/** Stable empty array returned for parent ids with no spawned subagents.
 *  Sharing the reference keeps `Object.is` comparisons happy for atomic selectors. */
export const EMPTY_SUBAGENT_ENTRIES: readonly SubagentEntry[] = [];

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * What asked for a reconcile. Decides whether the call is throttled and rides
 * along on the `subagent_reconcile_kick` diagnostic so the field tells which
 * trigger is actually recovering runs.
 *
 * - `"mount"`: conversation load (or the version gate resolving after it).
 * - `"reopen"`: an SSE stream replaced after a drop; never throttled.
 * - `"unknown_id"`: a stream event named a subagent the store doesn't hold.
 */
export type SubagentReconcileTrigger = "mount" | "reopen" | "unknown_id";

export interface SubagentActions {
  spawnSubagent: (params: {
    subagentId: string;
    label: string;
    objective: string;
    isFork?: boolean;
    timestamp: number;
    conversationId?: string;
    parentConversationId?: string;
    status?: SubagentStatus;
    error?: string;
    parentMessageStableId?: string;
    parentMessageId?: string;
    parentToolUseId?: string;
    /**
     * Final tallies for a run materialized after the fact, a reconcile
     * snapshot carries them alongside the identity. A live spawn omits them
     * and starts at zero. Supplied on a terminal spawn they also mark the
     * entry in `terminalUsageIds`, so a late `usage_progress` can't stack on
     * top of totals that already include it.
     */
    inputTokens?: number;
    outputTokens?: number;
  }) => void;

  changeStatus: (params: {
    subagentId: string;
    status: SubagentStatus;
    error?: string;
    inputTokens?: number;
    outputTokens?: number;
  }) => void;

  /**
   * Materialize an entry for a subagent this client learned about out of
   * band, a `subagent_event` / `subagent_status_changed` whose id has no
   * entry because the `subagent_spawned` was missed (SSE gap, page reload)
   * or the store was reset after it arrived, or a row from the daemon's
   * reconcile snapshot. No-op when the entry exists.
   *
   * Whatever identity the evidence carries is applied; the rest falls back to
   * placeholders (`label: ""`) that the detail fetch or a later, richer
   * snapshot can backfill. `parentConversationId` falls back to the
   * conversation on screen, the same guess `requestSubagentReconcile` makes,
   * because an entry with no parent id is shown by the Active-Subagents
   * overlay in *every* conversation and is settled by reconcile's orphan pass
   * in none of them.
   *
   * An entry that is still ACTIVE and can address a detail fetch is marked
   * `hydrationPending`, so the live events that race the backfill are deferred
   * rather than appended (see the field's doc on `SubagentEntry`). Terminal
   * rows can't race anything and are deliberately left un-armed: they'd
   * otherwise drag the whole snapshot through the auto-fetch on every load.
   */
  ensureEntry: (params: {
    subagentId: string;
    timestamp: number;
    conversationId?: string;
    parentConversationId?: string;
    status?: SubagentStatus;
    label?: string;
    objective?: string;
    isFork?: boolean;
    error?: string;
    parentToolUseId?: string;
    inputTokens?: number;
    outputTokens?: number;
  }) => void;

  receiveEvent: (params: {
    subagentId: string;
    event: SubagentInnerEvent;
    timestamp: number;
  }) => void;

  loadDetail: (params: {
    subagentId: string;
    status?: SubagentStatus;
    objective?: string;
    inputTokens?: number;
    outputTokens?: number;
    events: SubagentTimelineEvent[];
    /** Backfills a stub entry's placeholder label (0.11.0+ daemons). */
    label?: string;
    /**
     * Backfills a stub entry's spawn anchor and registers it in
     * `byToolUseId` (0.11.0+ daemons), restoring exact message anchoring
     * for entries recovered without their `subagent_spawned` event.
     */
    parentToolUseId?: string;
    /**
     * The child conversation the daemon resolved for this subagent
     * (0.11.0+). A stub that could only address the fetch through the
     * parent-id fallback learns its true child conversation here.
     */
    conversationId?: string;
  }) => void;

  /**
   * Fill in identity a placeholder entry never had: the label, objective and
   * spawn anchor missing from a stub, or from a row a pre-enrichment daemon
   * could only report a status for. Placeholder yields, real value wins: a
   * value the entry already holds is never overwritten, because it came from
   * the same source of truth (`subagent_spawned`) at first hand. A backfilled
   * `parentToolUseId` is registered in `byToolUseId` so the transcript can
   * anchor the inline card to its exact spawn tool call.
   */
  backfillIdentity: (params: {
    subagentId: string;
    label?: string;
    objective?: string;
    parentToolUseId?: string;
  }) => void;

  /**
   * Anchor an entry to the assistant message that spawned it and index it
   * under that id in `byParent`, so the transcript can find it. For entries
   * materialized without any parent message id, everything reconcile
   * recovers, history hydration is the first evidence source that names the
   * spawning message. No-op when the entry is unknown or already anchored;
   * re-anchoring an optimistic id to its reconciled server id is
   * `reanchorToMessage`'s job.
   */
  attachParentMessage: (subagentId: string, parentMessageId: string) => void;

  /**
   * Stamp the subagent's own conversation id, used to fetch detail. No-ops
   * when the entry is unknown or already carries that id, so the per-event
   * call path doesn't churn store identity.
   */
  setConversationId: (subagentId: string, conversationId: string) => void;

  /** Same, for the parent conversation id that scopes the overlay. */
  setParentConversationId: (
    subagentId: string,
    parentConversationId: string,
  ) => void;

  /**
   * Attach the durable server `messageId` to every entry currently anchored
   * to `stableId` (the optimistic streaming bubble id) and re-index `byParent`
   * so those entries are reachable under the server id after the parent
   * message reconciles. No-op when stableId === messageId, when no entry
   * matches, or when the entry already carries that parentMessageId. Strengthens
   * the positional/byParent fallback; the toolUseId anchor is primary.
   */
  reanchorToMessage: (params: { stableId: string; messageId: string }) => void;

  updateUsage: (params: {
    subagentId: string;
    inputTokens: number;
    outputTokens: number;
  }) => void;

  /**
   * Fetch detail from the daemon for a single subagent if not already
   * fetched (or if the entry was rebuilt with a newer spawnedAt).
   * Dedup state lives in the store so it survives component lifecycle.
   * Clears the marker on failure or empty events so callers can retry.
   */
  fetchDetailIfNeeded: (
    assistantId: string,
    subagentId: string,
  ) => Promise<void>;

  /**
   * Rebuild this conversation's subagent rows from the daemon's live
   * `subagents/reconcile` snapshot. Recovers subagents whose
   * `subagent_spawned` never reached this client, a mid-run reload, or an
   * SSE gap wider than the daemon's replay ring, including ones that stream
   * nothing at all and so leave no other evidence behind.
   *
   * Degraded, never destructive: a non-ok response (transport error, a daemon
   * without the route) leaves the store exactly as it was. Only a successful
   * snapshot settles this conversation's still-active entries that the daemon
   * no longer knows about to `interrupted`, they died with a daemon restart
   * and no terminal event is ever coming.
   *
   * 0.11.0+ daemons return full identity per child (label, objective, child
   * conversation id, spawn anchor) so unknown ids materialize as complete rows
   * and known placeholder rows are backfilled; older ones return only
   * `status`, which recovers stub-level rows the detail fetch can still flesh
   * out. Timeline backfill stays with that fetch: this never touches
   * `events`.
   *
   * Concurrent calls for the same parent conversation always share one
   * request. Beyond that, `"mount"` and `"unknown_id"` share one throttle
   * window per parent; `"reopen"` bypasses it. A reopen replaces a stream that
   * may have dropped a terminal status, so throttling it away is how a row
   * stays `running` forever, the miss is unrecoverable, whereas a throttled
   * mount pass has already been covered by the round-trip that took the
   * window. A `reset()` while a request is in flight invalidates it (the
   * snapshot describes the conversation the user just left) and reopens the
   * window for the conversation now on screen.
   */
  reconcileFromDaemon: (
    assistantId: string,
    parentConversationId: string,
    trigger?: SubagentReconcileTrigger,
  ) => Promise<void>;

  /**
   * Best-effort abort of a running subagent. Reads `assistantId` and
   * `activeConversationId` from their respective stores via `.getState()`
   * so callers don't need to pass or close over those values.
   */
  abortSubagent: (subagentId: string) => Promise<void>;

  reset: () => void;
}

export type SubagentStore = SubagentState & SubagentActions;

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

const INITIAL_STATE: SubagentState = {
  byId: {},
  orderedIds: [],
  terminalUsageIds: new Set<string>(),
  byParent: new Map<string, SubagentEntry[]>(),
  byToolUseId: new Map<string, string>(),
  fetchedAt: new Map<string, number>(),
};

/** Parent-id keys an entry contributes to in the `byParent` index. */
function parentKeysForEntry(entry: SubagentEntry): string[] {
  const keys: string[] = [];
  if (entry.parentMessageStableId) {
    keys.push(entry.parentMessageStableId);
  }
  if (
    entry.parentMessageId &&
    entry.parentMessageId !== entry.parentMessageStableId
  ) {
    keys.push(entry.parentMessageId);
  }
  return keys;
}

/**
 * Insert a freshly-spawned entry into the existing `byParent` index. Only
 * the buckets the entry touches are replaced — every other bucket reference
 * is preserved so unrelated message subscribers don't see their selector
 * output change. Returns the existing map by reference when the entry has
 * no parent ids (nothing to index).
 */
function addEntryToByParent(
  byParent: Map<string, SubagentEntry[]>,
  entry: SubagentEntry,
): Map<string, SubagentEntry[]> {
  const keys = parentKeysForEntry(entry);
  if (keys.length === 0) {
    return byParent;
  }

  const next = new Map(byParent);
  for (const key of keys) {
    const existing = next.get(key) ?? [];
    const merged = [...existing, entry];
    merged.sort((a, b) => a.spawnedAt - b.spawnedAt);
    next.set(key, merged);
  }
  return next;
}

/**
 * Re-index `byParent` after a set of entries gains a new `parentMessageId`.
 * Only the two affected buckets are rebuilt — the old `stableId` bucket (whose
 * entry objects are swapped for their updated copies) and the new `messageId`
 * bucket (which gains any updated entries not already present), each re-sorted
 * by `spawnedAt`. Every other bucket reference is preserved so unrelated
 * message subscribers don't see their selector output change.
 */
function reindexByParentForReanchor(
  byParent: Map<string, SubagentEntry[]>,
  stableId: string,
  messageId: string,
  updatedById: Map<string, SubagentEntry>,
): Map<string, SubagentEntry[]> {
  const next = new Map(byParent);

  const stableBucket = next.get(stableId);
  if (stableBucket) {
    next.set(
      stableId,
      stableBucket.map((entry) => updatedById.get(entry.subagentId) ?? entry),
    );
  }

  const messageBucket = [...(next.get(messageId) ?? [])];
  for (const updated of updatedById.values()) {
    const idx = messageBucket.findIndex(
      (entry) => entry.subagentId === updated.subagentId,
    );
    if (idx === -1) {
      messageBucket.push(updated);
    } else {
      messageBucket[idx] = updated;
    }
  }
  messageBucket.sort((a, b) => a.spawnedAt - b.spawnedAt);
  next.set(messageId, messageBucket);

  return next;
}

/**
 * Next `byId` with a single field patched on one entry, or `null` when
 * nothing would change: the entry is unknown, or already holds that value.
 * Returning `null` lets the caller skip the `set()` entirely so a per-event
 * write path doesn't churn store identity.
 */
function patchedEntryField<K extends keyof SubagentEntry>(
  byId: Record<string, SubagentEntry>,
  subagentId: string,
  key: K,
  value: SubagentEntry[K],
): Record<string, SubagentEntry> | null {
  const existing = byId[subagentId];
  if (!existing || existing[key] === value) {
    return null;
  }
  return { ...byId, [subagentId]: { ...existing, [key]: value } };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Map a SubagentInnerEvent type to a SubagentTimelineEvent type. */
function mapInnerEventType(
  event: SubagentInnerEvent,
): SubagentTimelineEvent["type"] {
  if (event.isError) {
    return "error";
  }

  switch (event.type) {
    case "assistant_text_delta":
    case "message_complete":
      return "text";
    case "tool_use_start":
      return "tool_call";
    case "tool_result":
      return "tool_result";
    default:
      return "text";
  }
}

const TOOL_INPUT_PRIORITY_KEYS = [
  "command",
  "file_path",
  "path",
  "query",
  "url",
  "pattern",
  "glob",
] as const;

/** Extract a short summary string from a tool_use_start input object. */
function summarizeToolInput(input: Record<string, unknown>): string {
  for (const key of TOOL_INPUT_PRIORITY_KEYS) {
    const value = input[key];
    if (typeof value === "string") {
      return value.length > 120 ? value.slice(0, 117) + "..." : value;
    }
  }
  return "";
}

/**
 * Pull the resolved web-search query off a subagent inner event's
 * `activityMetadata`. The query rides through on the matching `tool_result`'s
 * metadata (passthrough on the subagent wire — see `SubagentInnerEventSchema`),
 * which is the only place it appears live: the `tool_use_start` carries empty
 * `input` for Anthropic web_search. `activityMetadata` isn't on the inferred
 * `SubagentInnerEvent` type (it's a passthrough field), so read it via a narrow
 * cast. Returns `undefined` for non-search events or an empty query.
 */
function extractSearchQuery(event: SubagentInnerEvent): string | undefined {
  const meta = (event as { activityMetadata?: ToolActivityMetadata })
    .activityMetadata;
  const query = meta?.webSearch?.query;
  return typeof query === "string" && query.length > 0 ? query : undefined;
}

let timelineEventCounter = 0;

/** Generate a unique ID for timeline events. */
function generateTimelineEventId(): string {
  return `te-${++timelineEventCounter}`;
}

/**
 * In-flight `reconcileFromDaemon` calls keyed by parent conversation id, so
 * the mount pass, an `sse.opened` reopen and an unknown-id kick that land
 * together share a single round-trip instead of racing three writes.
 */
const reconcileInFlight = new Map<string, Promise<void>>();

/**
 * Bumped by every `reset()`, i.e. every conversation or assistant switch.
 * A reconcile round-trip captures the generation before its await; a snapshot
 * that lands after a bump describes the context the user has already left, so
 * it is dropped wholesale rather than merged into the freshly-reset store.
 */
let resetGeneration = 0;

/** Minimum spacing between one parent's throttled reconcile round-trips. */
const RECONCILE_KICK_INTERVAL_MS = 5_000;

/**
 * Last reconcile time keyed by parent conversation id, mirroring
 * `reconcileInFlight`. Subagent events are routed globally, so a background
 * conversation's reconcile must not consume the window the conversation on
 * screen needs: a single shared throttle lets either starve the other.
 */
const lastReconcileKickAt = new Map<string, number>();

/**
 * Open a fresh window for `parentConversationId` without testing the current
 * one, for a trigger that issues its round-trip regardless, so the throttled
 * triggers still measure their spacing from the last real request.
 */
function stampReconcileWindow(parentConversationId: string): void {
  lastReconcileKickAt.set(parentConversationId, Date.now());
}

/**
 * Take `parentConversationId`'s reconcile slot for this window, reporting
 * whether it was free. Claiming and testing are one step so two triggers
 * firing in the same tick can't both pass.
 */
function claimReconcileWindow(parentConversationId: string): boolean {
  const lastKickAt = lastReconcileKickAt.get(parentConversationId) ?? 0;
  if (Date.now() - lastKickAt < RECONCILE_KICK_INTERVAL_MS) {
    return false;
  }
  stampReconcileWindow(parentConversationId);
  return true;
}

/** One child row from the reconcile snapshot; only `status` is guaranteed. */
type ReconciledSubagent = SubagentsReconcileGetResponse["subagents"][string];

/** The store surface one reconciled row is applied through. */
type ReconcileApplySlice = Pick<
  SubagentStore,
  | "byId"
  | "ensureEntry"
  | "changeStatus"
  | "backfillIdentity"
  | "setConversationId"
  | "setParentConversationId"
>;

/**
 * Apply one child row from the reconcile snapshot. A known entry is refreshed
 * in place, including the identity a placeholder row is still missing, since
 * a stub created from a bare status event is "known" but blank; an unknown one
 * is materialized from whatever the daemon supplied.
 */
function applyReconciledSubagent(
  store: ReconcileApplySlice,
  subagentId: string,
  info: ReconciledSubagent,
  status: SubagentStatus,
  parentConversationId: string,
): void {
  const existing = store.byId[subagentId];
  if (existing) {
    if (shouldApplyStatus(existing.status, status)) {
      // Usage and error ride along so an entry whose terminal
      // `subagent_status_changed` was lost still recovers its final totals and
      // failure reason, the detail fetch won't, since it refuses any entry
      // that already has events. `changeStatus` preserves what it already
      // holds when the snapshot omits these.
      store.changeStatus({
        subagentId,
        status,
        error: info.error,
        inputTokens: info.usage?.inputTokens,
        outputTokens: info.usage?.outputTokens,
      });
    }
    store.backfillIdentity({
      subagentId,
      label: info.label,
      objective: info.objective,
      parentToolUseId: info.parentToolUseId,
    });
    if (info.conversationId) {
      store.setConversationId(subagentId, info.conversationId);
    }
    store.setParentConversationId(subagentId, parentConversationId);
    return;
  }

  // A pre-enrichment daemon reports `status` and nothing else, so the row
  // lands as the same placeholder the missed-spawn recovery path builds.
  store.ensureEntry({
    subagentId,
    timestamp: Date.now(),
    status,
    label: info.label,
    objective: info.objective,
    isFork: info.isFork,
    error: info.error,
    conversationId: info.conversationId,
    parentConversationId,
    parentToolUseId: info.parentToolUseId,
    inputTokens: info.usage?.inputTokens,
    outputTokens: info.usage?.outputTokens,
  });
}

async function runReconcile(
  get: () => SubagentStore,
  assistantId: string,
  parentConversationId: string,
): Promise<void> {
  const generation = resetGeneration;
  // Absence from the response is only evidence about rows the daemon could
  // have reported, the ones this conversation already held, still active,
  // when the request went out. Captured before the await rather than inferred
  // from `spawnedAt` afterwards: history hydration stamps that field at
  // hydration time, so a row recovered from an older run looks brand new and
  // would exempt itself from settling forever.
  const candidateIds = Object.values(get().byId)
    .filter(
      (entry) =>
        entry.parentConversationId === parentConversationId &&
        isActiveStatus(entry.status),
    )
    .map((entry) => entry.subagentId);
  let snapshot: Record<string, ReconciledSubagent>;
  try {
    const { data, response } = await subagentsReconcileGet({
      path: { assistant_id: assistantId },
      query: { parentConversationId },
      throwOnError: false,
    });
    if (!response?.ok || !data?.subagents) {
      return;
    }
    snapshot = data.subagents;
  } catch (err) {
    captureError(err, { context: "reconcileFromDaemon", bestEffort: true });
    return;
  }

  // A `reset()` during the round-trip means these rows describe a context the
  // user has already left, drop the whole step rather than repopulate a fresh
  // store with the previous chat's subagents.
  if (generation !== resetGeneration) {
    return;
  }

  for (const [subagentId, info] of Object.entries(snapshot)) {
    const parsed = SubagentStatusSchema.safeParse(info.status);
    // A row whose status doesn't parse tells us nothing trustworthy; skip it
    // entirely rather than guess. Its presence still counts against orphan
    // settling below: the daemon does know this subagent.
    if (!parsed.success) {
      continue;
    }
    applyReconciledSubagent(
      get(),
      subagentId,
      info,
      parsed.data,
      parentConversationId,
    );
  }

  // Settle this conversation's orphans: a candidate the daemon didn't report
  // died with it, and no terminal event is ever coming. Re-checked against the
  // store as it stands now, a terminal event that landed during the
  // round-trip already settled the row truthfully, and ownership is re-tested
  // because a stub `ensureEntry` attributed to the conversation on screen can
  // be re-parented by a later `subagent_event`. This response says nothing
  // about a row that now belongs to a different conversation.
  const { byId, changeStatus } = get();
  for (const subagentId of candidateIds) {
    const entry = byId[subagentId];
    if (
      !entry ||
      entry.parentConversationId !== parentConversationId ||
      !isActiveStatus(entry.status) ||
      Object.hasOwn(snapshot, subagentId)
    ) {
      continue;
    }
    changeStatus({ subagentId, status: "interrupted" });
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const useSubagentStoreBase = create<SubagentStore>()((set, get) => ({
  ...INITIAL_STATE,

  spawnSubagent: (params) => {
    const { byId, orderedIds } = get();
    if (byId[params.subagentId]) {
      return;
    }

    const entry: SubagentEntry = {
      subagentId: params.subagentId,
      label: params.label,
      objective: params.objective,
      status: params.status ?? "pending",
      isFork: params.isFork ?? false,
      error: params.error,
      inputTokens: params.inputTokens ?? 0,
      outputTokens: params.outputTokens ?? 0,
      spawnedAt: params.timestamp,
      events: [],
      conversationId: params.conversationId,
      parentConversationId: params.parentConversationId,
      parentMessageStableId: params.parentMessageStableId,
      parentMessageId: params.parentMessageId,
      parentToolUseId: params.parentToolUseId,
    };

    const nextById = { ...byId, [params.subagentId]: entry };
    // Only clone the tool-use index when this spawn carries a
    // `parentToolUseId`; otherwise keep the existing reference stable so
    // index subscribers don't re-render.
    const nextByToolUseId = setToolUseAnchor(
      get().byToolUseId,
      params.parentToolUseId,
      params.subagentId,
    );
    set({
      byId: nextById,
      orderedIds: [...orderedIds, params.subagentId],
      byParent: addEntryToByParent(get().byParent, entry),
      byToolUseId: nextByToolUseId,
    });

    // Mirrors `changeStatus`: totals stamped onto an already-terminal row are
    // final, so a straggling `usage_progress` must not add to them.
    if (
      !isActiveStatus(entry.status) &&
      (params.inputTokens != null || params.outputTokens != null)
    ) {
      get().terminalUsageIds.add(params.subagentId);
    }
  },

  ensureEntry: (params) => {
    if (get().byId[params.subagentId]) {
      return;
    }
    // An entry with no parent id at all is scoped to no conversation: the
    // overlay shows it everywhere and reconcile's per-parent orphan pass
    // settles it nowhere. A `subagent_status_changed` carries no ids, so fall
    // back to the conversation on screen.
    const parentConversationId =
      params.parentConversationId ??
      useConversationStore.getState().activeConversationId ??
      undefined;
    const status = params.status ?? "running";

    get().spawnSubagent({
      subagentId: params.subagentId,
      // Placeholder identity when the evidence carries none, the detail
      // fetch (0.11.0+ daemons) or a later snapshot backfills it.
      label: params.label ?? "",
      objective: params.objective ?? "",
      status,
      isFork: params.isFork,
      error: params.error,
      conversationId: params.conversationId,
      parentConversationId,
      timestamp: params.timestamp,
      parentToolUseId: params.parentToolUseId,
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
    });

    // Only a live row can have its backfill overtaken by streamed events, and
    // only an addressable one has a backfill coming at all.
    if (
      !isActiveStatus(status) ||
      !canAddressSubagentDetail({
        conversationId: params.conversationId,
        parentConversationId,
      })
    ) {
      return;
    }
    const { byId } = get();
    const entry = byId[params.subagentId];
    if (!entry) {
      return;
    }
    set({
      byId: {
        ...byId,
        [params.subagentId]: { ...entry, hydrationPending: true },
      },
    });
  },

  changeStatus: (params) => {
    const { byId } = get();
    const existing = byId[params.subagentId];
    if (!existing) {
      return;
    }

    // A fetch that settled empty while the run was live answered "no events
    // YET", not "no events ever". Re-arm the settled flag on the transition to
    // terminal so the card's render-driven fetch asks again for the final
    // timeline. Bounded: the transition fires once, and the re-fetch stamps
    // `detailSettled` back regardless of outcome.
    const detailSettled =
      isActiveStatus(existing.status) &&
      !isActiveStatus(params.status) &&
      existing.events.length === 0
        ? false
        : existing.detailSettled;

    set({
      byId: {
        ...byId,
        [params.subagentId]: {
          ...existing,
          detailSettled,
          status: params.status,
          error: params.error ?? existing.error,
          // Preserve the accumulated usage when a status event carries
          // zero/absent totals. An ABORT (stop button) ships `usage: {0, 0}`,
          // and `??` would let that 0 overwrite tokens we've already spent,
          // flushing the panel to zero. A real terminal total (e.g. on
          // completion) is non-zero, so `||` still lets it replace the running
          // tally — only the zero-on-abort case falls back to `existing`.
          inputTokens: params.inputTokens || existing.inputTokens,
          outputTokens: params.outputTokens || existing.outputTokens,
        },
      },
    });

    // Mark as terminal so subsequent updateUsage calls are ignored,
    // preventing double-counting when the daemon ships final totals
    // alongside the terminal status event.
    if (
      !isActiveStatus(params.status) &&
      (params.inputTokens != null || params.outputTokens != null)
    ) {
      get().terminalUsageIds.add(params.subagentId);
    }
  },

  receiveEvent: (params) => {
    const { byId } = get();
    const existing = byId[params.subagentId];
    if (!existing) {
      return;
    }

    // A stub awaiting its detail backfill: the daemon-side history the
    // in-flight fetch returns already contains this event, and appending it
    // here would make `loadDetail` keep the partial live suffix over the
    // full timeline (see the `hydrationPending` doc on `SubagentEntry`).
    if (existing.hydrationPending) {
      return;
    }

    const eventType = mapInnerEventType(params.event);

    let innerContent: string;
    if (params.event.type === "tool_use_start" && params.event.input) {
      innerContent = summarizeToolInput(params.event.input);
    } else {
      innerContent =
        params.event.content ?? params.event.text ?? params.event.result ?? "";
    }

    // Coalesce consecutive text deltas into a single timeline event
    // (matches macOS behaviour where assistant_text_delta events are
    // accumulated into one "Response" row instead of creating many).
    if (eventType === "text" && params.event.type === "assistant_text_delta") {
      const lastEvent = existing.events[existing.events.length - 1];
      if (lastEvent && lastEvent.type === "text") {
        const updatedEvents = [...existing.events];
        updatedEvents[updatedEvents.length - 1] = {
          ...lastEvent,
          content: lastEvent.content + innerContent,
        };
        set({
          byId: {
            ...byId,
            [params.subagentId]: { ...existing, events: updatedEvents },
          },
        });
        return;
      }
      // Don't create a new text event for an empty delta — wait for a
      // non-empty one to start a fresh coalesced run.
      if (!innerContent) {
        return;
      }
    }

    // Skip message_complete — it carries no content and is only used
    // by macOS to attach a daemon message ID to the preceding text event.
    if (params.event.type === "message_complete") {
      return;
    }

    const timelineEvent: SubagentTimelineEvent = {
      id: generateTimelineEventId(),
      type: eventType,
      content: innerContent,
      toolName: params.event.toolName,
      isError: params.event.isError,
      timestamp: params.timestamp,
      toolUseId: params.event.toolUseId,
      // Preserve raw payloads for the nested tool-detail view without
      // disturbing the `content` summary computed above.
      input:
        params.event.type === "tool_use_start" ? params.event.input : undefined,
      // Key off the RAW event type, not the mapped timeline type: a failed
      // tool emits `tool_result` with `isError: true`, which `mapInnerEventType`
      // routes to `"error"`. Using `eventType` here would drop the error output
      // the detail view needs, so capture both success and error results.
      result:
        params.event.type === "tool_result"
          ? (params.event.result ?? params.event.content ?? params.event.text)
          : undefined,
      // The resolved web-search query — only present (and only needed) on a
      // web_search `tool_result`; `undefined` everywhere else.
      searchQuery: extractSearchQuery(params.event),
    };

    set({
      byId: {
        ...byId,
        [params.subagentId]: {
          ...existing,
          events: [...existing.events, timelineEvent],
        },
      },
    });
  },

  loadDetail: (params) => {
    const { byId } = get();
    const existing = byId[params.subagentId];
    if (!existing) {
      return;
    }

    // Backfill the spawn anchor for a recovered stub and register it in the
    // tool-use index so the inline card re-anchors to its exact spawn call.
    const parentToolUseId = existing.parentToolUseId ?? params.parentToolUseId;
    const nextByToolUseId =
      parentToolUseId && !existing.parentToolUseId
        ? setToolUseAnchor(
            get().byToolUseId,
            parentToolUseId,
            params.subagentId,
          )
        : get().byToolUseId;

    // The daemon echoes back the id we queried with when it can't resolve the
    // subagent itself, so a stub that fetched through the parent-id fallback
    // would otherwise stamp the PARENT id into the child-semantic field.
    const resolvedConversationId =
      params.conversationId &&
      params.conversationId !== existing.parentConversationId
        ? params.conversationId
        : existing.conversationId;

    // A detail fetch issued while the run was live answers a round-trip late,
    // so it can still report `running` for a subagent whose terminal event has
    // since landed. Same rule as every other out-of-band source: a settled
    // entry never walks back to active (see `shouldApplyStatus`).
    const status =
      params.status && shouldApplyStatus(existing.status, params.status)
        ? params.status
        : existing.status;

    set({
      byId: {
        ...byId,
        [params.subagentId]: {
          ...existing,
          conversationId: resolvedConversationId,
          // A stub's placeholder label yields to the fetched one; a label
          // learned from `subagent_spawned` wins (same source of truth).
          label: existing.label || (params.label ?? ""),
          parentToolUseId,
          status,
          objective: params.objective ?? existing.objective,
          inputTokens: params.inputTokens ?? existing.inputTokens,
          outputTokens: params.outputTokens ?? existing.outputTokens,
          events:
            params.events.length > 0 && existing.events.length === 0
              ? params.events
              : existing.events,
          // The authoritative snapshot has landed (or definitively has no
          // events yet) — resume appending live stream events either way.
          hydrationPending: false,
        },
      },
      byToolUseId: nextByToolUseId,
    });
  },

  backfillIdentity: (params) => {
    const { byId } = get();
    const existing = byId[params.subagentId];
    if (!existing) {
      return;
    }

    const label = existing.label || (params.label ?? "");
    const objective = existing.objective || (params.objective ?? "");
    const parentToolUseId = existing.parentToolUseId ?? params.parentToolUseId;
    if (
      label === existing.label &&
      objective === existing.objective &&
      parentToolUseId === existing.parentToolUseId
    ) {
      return;
    }

    set({
      byId: {
        ...byId,
        [params.subagentId]: {
          ...existing,
          label,
          objective,
          parentToolUseId,
        },
      },
      byToolUseId: setToolUseAnchor(
        get().byToolUseId,
        parentToolUseId,
        params.subagentId,
      ),
    });
  },

  attachParentMessage: (subagentId, parentMessageId) => {
    const { byId } = get();
    const existing = byId[subagentId];
    if (!existing || existing.parentMessageId) {
      return;
    }

    const updated = { ...existing, parentMessageId };
    set({
      byId: { ...byId, [subagentId]: updated },
      // An entry with no stable id was never indexed under one, so re-index
      // against the message id itself: the stable-bucket pass then finds
      // nothing to swap and only the message bucket gains the entry.
      byParent: reindexByParentForReanchor(
        get().byParent,
        existing.parentMessageStableId ?? parentMessageId,
        parentMessageId,
        new Map([[subagentId, updated]]),
      ),
    });
  },

  setConversationId: (subagentId, conversationId) => {
    const next = patchedEntryField(
      get().byId,
      subagentId,
      "conversationId",
      conversationId,
    );
    if (next) {
      set({ byId: next });
    }
  },

  setParentConversationId: (subagentId, parentConversationId) => {
    const next = patchedEntryField(
      get().byId,
      subagentId,
      "parentConversationId",
      parentConversationId,
    );
    if (next) {
      set({ byId: next });
    }
  },

  reanchorToMessage: ({ stableId, messageId }) => {
    if (stableId === messageId) {
      return;
    }

    const { byId } = get();
    const updatedById = new Map<string, SubagentEntry>();
    for (const entry of Object.values(byId)) {
      if (
        entry.parentMessageStableId === stableId &&
        entry.parentMessageId !== messageId
      ) {
        updatedById.set(entry.subagentId, {
          ...entry,
          parentMessageId: messageId,
        });
      }
    }
    if (updatedById.size === 0) {
      return;
    }

    const nextById = { ...byId };
    for (const [subagentId, updated] of updatedById) {
      nextById[subagentId] = updated;
    }

    set({
      byId: nextById,
      byParent: reindexByParentForReanchor(
        get().byParent,
        stableId,
        messageId,
        updatedById,
      ),
    });
  },

  updateUsage: (params) => {
    const { byId, terminalUsageIds } = get();
    if (terminalUsageIds.has(params.subagentId)) {
      return;
    }
    const existing = byId[params.subagentId];
    if (!existing) {
      return;
    }

    set({
      byId: {
        ...byId,
        [params.subagentId]: {
          ...existing,
          inputTokens: existing.inputTokens + params.inputTokens,
          outputTokens: existing.outputTokens + params.outputTokens,
        },
      },
    });
  },

  fetchDetailIfNeeded: async (assistantId, subagentId) => {
    const { byId, fetchedAt } = get();
    const entry = byId[subagentId];
    if (!entry) {
      return;
    }
    const queryConversationId = resolveSubagentDetailConversationId(entry);
    if (!queryConversationId) {
      return;
    }
    if (entry.events.length > 0) {
      return;
    }

    const prev = fetchedAt.get(subagentId);
    if (prev !== undefined && prev >= entry.spawnedAt) {
      return;
    }

    // Mark as fetched before the await to prevent concurrent duplicates.
    const nextFetchedAt = new Map(fetchedAt);
    nextFetchedAt.set(subagentId, entry.spawnedAt);
    set({ fetchedAt: nextFetchedAt });

    const detail = await fetchSubagentDetail(
      assistantId,
      subagentId,
      queryConversationId,
    );

    // Whatever the outcome, a real timeline, an empty one, or a failed
    // fetch, the detail fetch has now completed at least once. Marking the
    // entry `detailSettled` lets a terminal card with no events stop rendering
    // as loading and show the honest truth (its steps, or a resting empty
    // state). A no-op when the entry was disposed mid-flight (a `reset()` on a
    // conversation switch).
    const settled = patchedEntryField(
      get().byId,
      subagentId,
      "detailSettled",
      true,
    );
    if (settled) {
      set({ byId: settled });
    }

    const clearMarker = () => {
      const next = new Map(get().fetchedAt);
      next.delete(subagentId);
      set({ fetchedAt: next });
    };

    if (!detail) {
      clearMarker();
      // A stub whose backfill failed must not keep dropping live events —
      // degrade to append-only so the card still accrues a timeline.
      const entry = get().byId[subagentId];
      if (entry?.hydrationPending) {
        set({
          byId: {
            ...get().byId,
            [subagentId]: { ...entry, hydrationPending: false },
          },
        });
      }
      return;
    }

    const events = mapDetailEvents(detail.events);

    if (events.length === 0) {
      clearMarker();
    }

    get().loadDetail({
      subagentId,
      status: detail.status,
      objective: detail.objective,
      inputTokens: detail.usage?.inputTokens,
      outputTokens: detail.usage?.outputTokens,
      events,
      label: detail.label,
      parentToolUseId: detail.parentToolUseId,
      conversationId: detail.conversationId,
    });
  },

  reconcileFromDaemon: (
    assistantId,
    parentConversationId,
    trigger = "mount",
  ) => {
    // Single choke point for every trigger (mount, SSE reopen, unknown-id
    // kick): assistants older than 0.10.0 don't serve the route, and the
    // triggers re-fire on every reopen: gate rather than 404 repeatedly.
    if (!supportsSubagentsReconcile()) {
      return Promise.resolve();
    }
    const inFlight = reconcileInFlight.get(parentConversationId);
    if (inFlight) {
      return inFlight;
    }
    // Throttled here rather than at the kick call site so a mount pass that
    // re-runs when the version gate resolves is bounded too. A reopen is
    // exempt: the stream it replaces may have dropped the terminal status this
    // pass exists to recover, and a dropped reopen is never retried. It still
    // stamps the window, so the reconnect's own mount pass doesn't double-fire,
    // and single-flight above still collapses a burst of reopens into one
    // request. `sse.opened` only publishes for a stream that genuinely
    // established, so this is bounded by the transport's reconnect backoff.
    if (trigger === "reopen") {
      stampReconcileWindow(parentConversationId);
    } else if (!claimReconcileWindow(parentConversationId)) {
      return Promise.resolve();
    }

    // Recorded here rather than at the kick call site so the count tracks
    // round-trips actually issued, not calls the version gate, the window or
    // single-flight turned into a no-op.
    recordDiagnostic("subagent_reconcile_kick", { trigger });
    const run: Promise<void> = runReconcile(
      get,
      assistantId,
      parentConversationId,
    ).finally(() => {
      // Only clear our own entry: a `reset()` may have already evicted this
      // one and a later call may have registered its own request under the
      // same key, which this settlement says nothing about.
      if (reconcileInFlight.get(parentConversationId) === run) {
        reconcileInFlight.delete(parentConversationId);
      }
    });
    reconcileInFlight.set(parentConversationId, run);
    return run;
  },

  abortSubagent: async (subagentId) => {
    const assistantId = useResolvedAssistantsStore.getState().activeAssistantId;
    const activeConversationId =
      useConversationStore.getState().activeConversationId;
    if (!assistantId || !activeConversationId) {
      return;
    }
    try {
      await subagentsByIdAbortPost({
        path: { assistant_id: assistantId, id: subagentId },
        body: { conversationId: activeConversationId },
        throwOnError: true,
      });
    } catch {
      // Best-effort — the daemon may have already completed
    }
  },

  reset: () => {
    // A reset means a conversation switch, so the next reconcile should fire
    // immediately instead of inheriting the previous chat's window.
    lastReconcileKickAt.clear();
    // Invalidate every in-flight snapshot (they describe the context being
    // left) and drop them from the single-flight map so a reconcile for the
    // new context issues a fresh request instead of joining a doomed one.
    resetGeneration++;
    reconcileInFlight.clear();
    set({
      byId: {},
      orderedIds: [],
      terminalUsageIds: new Set<string>(),
      byParent: new Map<string, SubagentEntry[]>(),
      byToolUseId: new Map<string, string>(),
      fetchedAt: new Map<string, number>(),
    });
  },
}));

export const useSubagentStore = createSelectors(useSubagentStoreBase);

/**
 * Ask the daemon to resync this conversation's subagents, best-effort.
 *
 * For the stream handlers, which hit this when an event names a subagent the
 * store has never seen, the client's picture of the run is incomplete. Reads
 * the active assistant from its store (same pattern as `abortSubagent`);
 * `reconcileFromDaemon` decides whether the request actually goes out, so a
 * burst of events for the same missing subagent costs a single fetch.
 *
 * `parentConversationId` names the conversation to resync. Subagent events are
 * routed globally, so an event for a background conversation must reconcile
 * ITS parent rather than whichever chat is on screen. Callers with no id at
 * hand, `subagent_status_changed` carries none, fall back to the active
 * conversation.
 */
export function requestSubagentReconcile(parentConversationId?: string): void {
  const assistantId = useResolvedAssistantsStore.getState().activeAssistantId;
  const targetConversationId =
    parentConversationId ??
    useConversationStore.getState().activeConversationId;
  if (!assistantId || !targetConversationId) {
    return;
  }

  void useSubagentStoreBase
    .getState()
    .reconcileFromDaemon(assistantId, targetConversationId, "unknown_id");
}
