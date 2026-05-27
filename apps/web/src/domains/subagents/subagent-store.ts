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

import { createSelectors } from "@/utils/create-selectors";
import type { SubagentStatus, SubagentInnerEvent } from "@/types/interaction-ui-types";
import { isActiveStatus } from "@/domains/subagents/status-helpers";

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
}

/** Stable empty array returned for parent ids with no spawned subagents.
 *  Sharing the reference keeps `useShallow`/`Object.is` comparisons happy. */
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

  updateUsage: (params: {
    subagentId: string;
    inputTokens: number;
    outputTokens: number;
    estimatedCost: number;
  }) => void;

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
    };

    const nextById = { ...byId, [params.subagentId]: entry };
    set({
      byId: nextById,
      orderedIds: [...orderedIds, params.subagentId],
      byParent: addEntryToByParent(get().byParent, entry),
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
          inputTokens: params.inputTokens ?? existing.inputTokens,
          outputTokens: params.outputTokens ?? existing.outputTokens,
          totalCost: params.totalCost ?? existing.totalCost,
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

  reset: () =>
    set({
      byId: {},
      orderedIds: [],
      terminalUsageIds: new Set<string>(),
      byParent: new Map<string, SubagentEntry[]>(),
    }),
}));

export const useSubagentStore = createSelectors(useSubagentStoreBase);
