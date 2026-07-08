/**
 * Zustand store for doctor panel state.
 *
 * Centralizes all doctor-panel state that was previously threaded as
 * 10+ individual `useState` setters through `useDoctorSSE` and
 * `useDoctorSession`. The event handlers in `doctor-event-handlers.ts`
 * read/write this store via the {@link DoctorPanelContext} interface,
 * keeping them independently testable.
 *
 * Wrapped with `createSelectors` for auto-generated per-field hooks.
 *
 * @see {@link https://zustand.docs.pmnd.rs/guides/auto-generating-selectors}
 */

import { create } from "zustand";

import type { ChatEntry, NewChatEntry } from "@/domains/settings/components/panels/doctor-history";
import { createSelectors } from "@/utils/create-selectors";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PanelStatus = "idle" | "active" | "completed" | "error";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface DoctorPanelState {
  entries: ChatEntry[];
  inputValue: string;
  thinking: boolean;
  sessionId: string | null;
  sessionStatus: PanelStatus;
  pendingApproval: boolean;
  pendingBackup: boolean;
  /** Set when the user clicks "New Session" — suppresses history queries
   * so the idle state is shown instead of re-loading the old session. */
  historyDismissed: boolean;

  /** ID of the entry currently being streamed into (message_delta). */
  streamingEntryId: string | null;

  /** Monotonic counter for generating unique entry IDs. */
  entryCounter: number;

  /** Tracks which assistant owns the current store state. */
  lastAssistantId: string | null;

  /** Latest Redis stream event ID that can be used to resume the Doctor stream. */
  latestReplayableSourceEventId: string | null;

  /** Redis stream event IDs already folded into the active Doctor transcript. */
  processedSourceEventIds: Set<string>;

  /**
   * Pending prompt flags captured at the moment of a *transport* stream
   * failure. Only `failStream` sets this — a server-terminal session error
   * never does — so its presence is what marks an error state as
   * re-attachable via Reconnect. Cleared on reconnect and on session reset.
   */
  reconnectSnapshot: { pendingApproval: boolean; pendingBackup: boolean } | null;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export interface DoctorPanelActions {
  nextId: () => string;
  appendEntry: (entry: NewChatEntry) => void;
  updateEntries: (updater: (entries: ChatEntry[]) => ChatEntry[]) => void;

  /** Reset session state but keep entries visible (end session). */
  teardown: () => void;

  /** Clear everything — entries, history, input (assistant change). */
  reset: () => void;

  /** Clear session + entries for "New Session" without resetting history flag. */
  resetForNewSession: () => void;

  setInputValue: (v: string) => void;
  setThinking: (v: boolean) => void;
  setPendingApproval: (v: boolean) => void;
  setPendingBackup: (v: boolean) => void;
  setSessionId: (id: string | null) => void;
  setSessionStatus: (s: PanelStatus) => void;
  setHistoryDismissed: (v: boolean) => void;

  setStreamingEntryId: (id: string | null) => void;
  setEntries: (entries: ChatEntry[]) => void;
  setReconnectSnapshot: (
    v: { pendingApproval: boolean; pendingBackup: boolean } | null,
  ) => void;
  resetReplayState: () => void;
  seedReplayState: (sourceEventIds: string[], latestSourceEventId: string | null) => void;
  recordReplayableSourceEventId: (sourceEventId: string) => boolean;
}

export type DoctorPanelStore = DoctorPanelState & DoctorPanelActions;

// ---------------------------------------------------------------------------
// Context interface for event handlers
//
// Matches the subset of the store that pure handlers need. Tests can
// provide a lightweight mock implementing this interface instead of a
// full Zustand store.
// ---------------------------------------------------------------------------

export interface DoctorPanelContext {
  updateEntries: (updater: (entries: ChatEntry[]) => ChatEntry[]) => void;
  setThinking: (v: boolean) => void;
  setPendingApproval: (v: boolean) => void;
  setPendingBackup: (v: boolean) => void;
  setSessionStatus: (s: PanelStatus) => void;
  appendEntry: (entry: NewChatEntry) => void;
  nextId: () => string;
  getStreamingEntryId: () => string | null;
  setStreamingEntryId: (id: string | null) => void;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const useDoctorPanelStoreBase = create<DoctorPanelStore>()((set, get) => ({
  // State
  entries: [],
  inputValue: "",
  thinking: false,
  sessionId: null,
  sessionStatus: "idle",
  pendingApproval: false,
  pendingBackup: false,
  historyDismissed: false,
  streamingEntryId: null,
  entryCounter: 0,
  lastAssistantId: null,
  latestReplayableSourceEventId: null,
  processedSourceEventIds: new Set(),
  reconnectSnapshot: null,

  // Actions
  nextId: () => {
    const next = get().entryCounter + 1;
    set({ entryCounter: next });
    return `entry-${next}`;
  },

  appendEntry: (entry) => {
    const id = get().nextId();
    set((s) => ({
      entries: [...s.entries, { ...entry, id, timestamp: Date.now() } as ChatEntry],
    }));
  },

  updateEntries: (updater) => {
    set((s) => ({ entries: updater(s.entries) }));
  },

  teardown: () => {
    set({
      sessionId: null,
      sessionStatus: "completed",
      pendingApproval: false,
      pendingBackup: false,
      thinking: false,
      streamingEntryId: null,
      latestReplayableSourceEventId: null,
      processedSourceEventIds: new Set(),
      reconnectSnapshot: null,
    });
  },

  reset: () => {
    set({
      entries: [],
      inputValue: "",
      thinking: false,
      sessionId: null,
      sessionStatus: "idle",
      pendingApproval: false,
      pendingBackup: false,
      historyDismissed: false,
      streamingEntryId: null,
      entryCounter: 0,
      latestReplayableSourceEventId: null,
      processedSourceEventIds: new Set(),
      reconnectSnapshot: null,
    });
  },

  resetForNewSession: () => {
    set({
      entries: [],
      inputValue: "",
      thinking: false,
      sessionId: null,
      sessionStatus: "idle",
      pendingApproval: false,
      pendingBackup: false,
      historyDismissed: true,
      streamingEntryId: null,
      entryCounter: 0,
      latestReplayableSourceEventId: null,
      processedSourceEventIds: new Set(),
      reconnectSnapshot: null,
    });
  },

  setInputValue: (v) => set({ inputValue: v }),
  setThinking: (v) => set({ thinking: v }),
  setPendingApproval: (v) => set({ pendingApproval: v }),
  setPendingBackup: (v) => set({ pendingBackup: v }),
  setSessionId: (id) => set({ sessionId: id }),
  setSessionStatus: (s) => set({ sessionStatus: s }),
  setHistoryDismissed: (v) => set({ historyDismissed: v }),
  setStreamingEntryId: (id) => set({ streamingEntryId: id }),
  setEntries: (entries) => set({ entries }),
  setReconnectSnapshot: (v) => set({ reconnectSnapshot: v }),
  resetReplayState: () => {
    set({
      latestReplayableSourceEventId: null,
      processedSourceEventIds: new Set(),
    });
  },
  seedReplayState: (sourceEventIds, latestSourceEventId) => {
    set({
      latestReplayableSourceEventId: latestSourceEventId,
      processedSourceEventIds: new Set(sourceEventIds),
    });
  },
  recordReplayableSourceEventId: (sourceEventId) => {
    const processedSourceEventIds = get().processedSourceEventIds;
    if (processedSourceEventIds.has(sourceEventId)) {
      return false;
    }
    set({
      latestReplayableSourceEventId: sourceEventId,
      processedSourceEventIds: new Set(processedSourceEventIds).add(
        sourceEventId,
      ),
    });
    return true;
  },
}));

export const useDoctorPanelStore = createSelectors(useDoctorPanelStoreBase);
