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

import { createSelectors } from "@/utils/create-selectors.js";
import type { SubagentStatus, SubagentInnerEvent } from "@/domains/chat/lib/event-types.js";

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
}

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

  setConversationId: (subagentId: string, conversationId: string) => void;

  reset: () => void;
}

export type SubagentStore = SubagentState & SubagentActions;

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

const INITIAL_STATE: SubagentState = {
  byId: {},
  orderedIds: [],
};

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

    set({
      byId: { ...byId, [params.subagentId]: entry },
      orderedIds: [...orderedIds, params.subagentId],
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

  reset: () => set({ ...INITIAL_STATE }),
}));

export const useSubagentStore = createSelectors(useSubagentStoreBase);
