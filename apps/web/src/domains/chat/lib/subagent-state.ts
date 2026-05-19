/**
 * Subagent-level state machine for tracking spawned subagent lifecycles.
 *
 * Maintains a map of SubagentEntry records keyed by subagentId, with an
 * ordered list of IDs for stable rendering. Accepts typed domain events
 * and applies pure transitions so UI components can derive display state
 * deterministically.
 *
 * Follows the same pattern as the turn state machine
 * (`turn-state-machine.ts`) and interaction state machine
 * (`interaction-state-machine.ts`).
 *
 * @see https://react.dev/learn/extracting-state-logic-into-a-reducer
 */

import type { SubagentStatus, SubagentInnerEvent } from "@/domains/chat/lib/event-types.js";
export type { SubagentStatus } from "@/domains/chat/lib/event-types.js";

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

export interface SubagentMapState {
  byId: Record<string, SubagentEntry>;
  orderedIds: string[];
}

export const INITIAL_SUBAGENT_STATE: SubagentMapState = {
  byId: {},
  orderedIds: [],
};

// ---------------------------------------------------------------------------
// Domain events
// ---------------------------------------------------------------------------

export interface SubagentSpawned {
  type: "SUBAGENT_SPAWNED";
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
}

export interface SubagentStatusChanged {
  type: "SUBAGENT_STATUS_CHANGED";
  subagentId: string;
  status: SubagentStatus;
  error?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalCost?: number;
}

export interface SubagentEventReceived {
  type: "SUBAGENT_EVENT_RECEIVED";
  subagentId: string;
  event: SubagentInnerEvent;
  timestamp: number;
}

export interface SubagentDetailLoaded {
  type: "SUBAGENT_DETAIL_LOADED";
  subagentId: string;
  status?: SubagentStatus;
  objective?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalCost?: number;
  events: SubagentTimelineEvent[];
}

export interface SubagentConversationIdSet {
  type: "SUBAGENT_CONVERSATION_ID_SET";
  subagentId: string;
  conversationId: string;
}

export interface SubagentReset {
  type: "SUBAGENT_RESET";
}

export type SubagentAction =
  | SubagentSpawned
  | SubagentStatusChanged
  | SubagentEventReceived
  | SubagentDetailLoaded
  | SubagentConversationIdSet
  | SubagentReset;

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
// Reducer
// ---------------------------------------------------------------------------

export function subagentReducer(
  state: SubagentMapState,
  action: SubagentAction,
): SubagentMapState {
  switch (action.type) {
    case "SUBAGENT_SPAWNED": {
      if (state.byId[action.subagentId]) {
        return state;
      }
      const entry: SubagentEntry = {
        subagentId: action.subagentId,
        label: action.label,
        objective: action.objective,
        status: action.status ?? "pending",
        isFork: action.isFork ?? false,
        error: action.error,
        inputTokens: 0,
        outputTokens: 0,
        totalCost: 0,
        spawnedAt: action.timestamp,
        events: [],
        conversationId: action.conversationId,
        parentMessageStableId: action.parentMessageStableId,
        parentMessageId: action.parentMessageId,
      };
      return {
        byId: { ...state.byId, [action.subagentId]: entry },
        orderedIds: [...state.orderedIds, action.subagentId],
      };
    }

    case "SUBAGENT_STATUS_CHANGED": {
      const existing = state.byId[action.subagentId];
      if (!existing) return state;

      return {
        ...state,
        byId: {
          ...state.byId,
          [action.subagentId]: {
            ...existing,
            status: action.status,
            error: action.error ?? existing.error,
            inputTokens: action.inputTokens ?? existing.inputTokens,
            outputTokens: action.outputTokens ?? existing.outputTokens,
            totalCost: action.totalCost ?? existing.totalCost,
          },
        },
      };
    }

    case "SUBAGENT_EVENT_RECEIVED": {
      const existing = state.byId[action.subagentId];
      if (!existing) return state;

      const eventType = mapInnerEventType(action.event);

      let innerContent: string;
      if (action.event.type === "tool_use_start" && action.event.input) {
        innerContent = summarizeToolInput(action.event.input);
      } else {
        innerContent =
          action.event.content ?? action.event.text ?? action.event.result ?? "";
      }

      // Coalesce consecutive text deltas into a single timeline event
      // (matches macOS behaviour where assistant_text_delta events are
      // accumulated into one "Response" row instead of creating many).
      if (eventType === "text" && action.event.type === "assistant_text_delta") {
        const lastEvent = existing.events[existing.events.length - 1];
        if (lastEvent && lastEvent.type === "text") {
          const updatedEvents = [...existing.events];
          updatedEvents[updatedEvents.length - 1] = {
            ...lastEvent,
            content: lastEvent.content + innerContent,
          };
          return {
            ...state,
            byId: {
              ...state.byId,
              [action.subagentId]: {
                ...existing,
                events: updatedEvents,
              },
            },
          };
        }
        // Don't create a new text event for an empty delta — wait for a
        // non-empty one to start a fresh coalesced run.
        if (!innerContent) {
          return state;
        }
      }

      // Skip message_complete — it carries no content and is only used
      // by macOS to attach a daemon message ID to the preceding text event.
      if (action.event.type === "message_complete") {
        return state;
      }

      const timelineEvent: SubagentTimelineEvent = {
        id: generateTimelineEventId(),
        type: eventType,
        content: innerContent,
        toolName: action.event.toolName,
        isError: action.event.isError,
        timestamp: action.timestamp,
      };

      return {
        ...state,
        byId: {
          ...state.byId,
          [action.subagentId]: {
            ...existing,
            events: [...existing.events, timelineEvent],
          },
        },
      };
    }

    case "SUBAGENT_DETAIL_LOADED": {
      const existing = state.byId[action.subagentId];
      if (!existing) {
        return state;
      }
      return {
        ...state,
        byId: {
          ...state.byId,
          [action.subagentId]: {
            ...existing,
            status: action.status ?? existing.status,
            objective: action.objective ?? existing.objective,
            inputTokens: action.inputTokens ?? existing.inputTokens,
            outputTokens: action.outputTokens ?? existing.outputTokens,
            totalCost: action.totalCost ?? existing.totalCost,
            events: action.events.length > 0 ? action.events : existing.events,
          },
        },
      };
    }

    case "SUBAGENT_CONVERSATION_ID_SET": {
      const existing = state.byId[action.subagentId];
      if (!existing) {
        return state;
      }
      return {
        ...state,
        byId: {
          ...state.byId,
          [action.subagentId]: {
            ...existing,
            conversationId: action.conversationId,
          },
        },
      };
    }

    case "SUBAGENT_RESET":
      return { ...INITIAL_SUBAGENT_STATE };

    default:
      return state;
  }
}
