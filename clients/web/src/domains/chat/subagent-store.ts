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
import { subagentsByIdAbortPost } from "@/generated/daemon/sdk.gen";
import { useConversationStore } from "@/stores/conversation-store";
import { createSelectors } from "@/utils/create-selectors";
import type { SubagentStatus, SubagentInnerEvent } from "@vellumai/assistant-api";
import type { ToolActivityMetadata } from "@/assistant/web-activity-types";
import { isActiveStatus } from "@/utils/subagent-status";
import { fetchSubagentDetail } from "./fetch-subagent-detail";
import { mapDetailEvents } from "./map-detail-events";
import { setToolUseAnchor } from "./store-helpers/by-tool-use-id-index";

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
  totalCost: number;
  spawnedAt: number;
  events: SubagentTimelineEvent[];
  /** The subagent's own conversation ID, used to fetch detail data. */
  conversationId?: string;
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

export interface SubagentActions {
  spawnSubagent: (params: {
    subagentId: string;
    label: string;
    objective: string;
    isFork?: boolean;
    timestamp: number;
    conversationId?: string;
    status?: SubagentStatus;
    error?: string;
    parentMessageStableId?: string;
    parentMessageId?: string;
    parentToolUseId?: string;
  }) => void;

  changeStatus: (params: {
    subagentId: string;
    status: SubagentStatus;
    error?: string;
    inputTokens?: number;
    outputTokens?: number;
    totalCost?: number;
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
    totalCost?: number;
    events: SubagentTimelineEvent[];
  }) => void;

  setConversationId: (subagentId: string, conversationId: string) => void;

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
    estimatedCost: number;
  }) => void;

  /**
   * Fetch detail from the daemon for a single subagent if not already
   * fetched (or if the entry was rebuilt with a newer spawnedAt).
   * Dedup state lives in the store so it survives component lifecycle.
   * Clears the marker on failure or empty events so callers can retry.
   */
  fetchDetailIfNeeded: (assistantId: string, subagentId: string) => Promise<void>;

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
  if (entry.parentMessageStableId) keys.push(entry.parentMessageStableId);
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
  if (keys.length === 0) return byParent;

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

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const useSubagentStoreBase = create<SubagentStore>()((set, get) => ({
  ...INITIAL_STATE,

  spawnSubagent: (params) => {
    const { byId, orderedIds } = get();
    if (byId[params.subagentId]) return;

    const entry: SubagentEntry = {
      subagentId: params.subagentId,
      label: params.label,
      objective: params.objective,
      status: params.status ?? "pending",
      isFork: params.isFork ?? false,
      error: params.error,
      inputTokens: 0,
      outputTokens: 0,
      totalCost: 0,
      spawnedAt: params.timestamp,
      events: [],
      conversationId: params.conversationId,
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
  },

  changeStatus: (params) => {
    const { byId } = get();
    const existing = byId[params.subagentId];
    if (!existing) return;

    set({
      byId: {
        ...byId,
        [params.subagentId]: {
          ...existing,
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
          totalCost: params.totalCost || existing.totalCost,
        },
      },
    });

    // Mark as terminal so subsequent updateUsage calls are ignored,
    // preventing double-counting when the daemon ships final totals
    // alongside the terminal status event.
    if (
      !isActiveStatus(params.status) &&
      (params.inputTokens != null ||
        params.outputTokens != null ||
        params.totalCost != null)
    ) {
      get().terminalUsageIds.add(params.subagentId);
    }
  },

  receiveEvent: (params) => {
    const { byId } = get();
    const existing = byId[params.subagentId];
    if (!existing) return;

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
      if (!innerContent) return;
    }

    // Skip message_complete — it carries no content and is only used
    // by macOS to attach a daemon message ID to the preceding text event.
    if (params.event.type === "message_complete") return;

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
          ? params.event.result ?? params.event.content ?? params.event.text
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
    if (!existing) return;

    set({
      byId: {
        ...byId,
        [params.subagentId]: {
          ...existing,
          status: params.status ?? existing.status,
          objective: params.objective ?? existing.objective,
          inputTokens: params.inputTokens ?? existing.inputTokens,
          outputTokens: params.outputTokens ?? existing.outputTokens,
          totalCost: params.totalCost ?? existing.totalCost,
          events:
            params.events.length > 0 && existing.events.length === 0
              ? params.events
              : existing.events,
        },
      },
    });
  },

  setConversationId: (subagentId, conversationId) => {
    const { byId } = get();
    const existing = byId[subagentId];
    if (!existing) return;

    set({
      byId: {
        ...byId,
        [subagentId]: { ...existing, conversationId },
      },
    });
  },

  reanchorToMessage: ({ stableId, messageId }) => {
    if (stableId === messageId) return;

    const { byId } = get();
    const updatedById = new Map<string, SubagentEntry>();
    for (const entry of Object.values(byId)) {
      if (
        entry.parentMessageStableId === stableId &&
        entry.parentMessageId !== messageId
      ) {
        updatedById.set(entry.subagentId, { ...entry, parentMessageId: messageId });
      }
    }
    if (updatedById.size === 0) return;

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
    if (terminalUsageIds.has(params.subagentId)) return;
    const existing = byId[params.subagentId];
    if (!existing) return;

    set({
      byId: {
        ...byId,
        [params.subagentId]: {
          ...existing,
          inputTokens: existing.inputTokens + params.inputTokens,
          outputTokens: existing.outputTokens + params.outputTokens,
          totalCost: existing.totalCost + params.estimatedCost,
        },
      },
    });
  },

  fetchDetailIfNeeded: async (assistantId, subagentId) => {
    const { byId, fetchedAt } = get();
    const entry = byId[subagentId];
    if (!entry?.conversationId) return;
    if (entry.events.length > 0) return;

    const prev = fetchedAt.get(subagentId);
    if (prev !== undefined && prev >= entry.spawnedAt) return;

    // Mark as fetched before the await to prevent concurrent duplicates.
    const nextFetchedAt = new Map(fetchedAt);
    nextFetchedAt.set(subagentId, entry.spawnedAt);
    set({ fetchedAt: nextFetchedAt });

    const detail = await fetchSubagentDetail(assistantId, subagentId, entry.conversationId);

    const clearMarker = () => {
      const next = new Map(get().fetchedAt);
      next.delete(subagentId);
      set({ fetchedAt: next });
    };

    if (!detail) {
      clearMarker();
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
      totalCost: detail.usage?.estimatedCost,
      events,
    });
  },

  abortSubagent: async (subagentId) => {
    const assistantId = useResolvedAssistantsStore.getState().activeAssistantId;
    const activeConversationId = useConversationStore.getState().activeConversationId;
    if (!assistantId || !activeConversationId) return;
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

  reset: () =>
    set({
      byId: {},
      orderedIds: [],
      terminalUsageIds: new Set<string>(),
      byParent: new Map<string, SubagentEntry[]>(),
      byToolUseId: new Map<string, string>(),
      fetchedAt: new Map<string, number>(),
    }),
}));

export const useSubagentStore = createSelectors(useSubagentStoreBase);
