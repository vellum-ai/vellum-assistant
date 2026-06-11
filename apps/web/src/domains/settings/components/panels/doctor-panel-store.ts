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
  selectedHistorySessionId: string | null;
  appliedHistorySessionId: string | null;
  historyAutoLoadAttempted: boolean;
  sending: boolean;
  starting: boolean;
  ending: boolean;

  /** ID of the entry currently being streamed into (message_delta). */
  streamingEntryId: string | null;

  /** Monotonic counter for generating unique entry IDs. */
  entryCounter: number;
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

  /** Clear everything — entries, history, input (assistant change / new session). */
  reset: () => void;

  setInputValue: (v: string) => void;
  setThinking: (v: boolean) => void;
  setPendingApproval: (v: boolean) => void;
  setPendingBackup: (v: boolean) => void;
  setSessionId: (id: string | null) => void;
  setSessionStatus: (s: PanelStatus) => void;
  setSelectedHistorySessionId: (id: string | null) => void;
  setAppliedHistorySessionId: (id: string | null) => void;
  setHistoryAutoLoadAttempted: (v: boolean) => void;
  setSending: (v: boolean) => void;
  setStarting: (v: boolean) => void;
  setEnding: (v: boolean) => void;
  setStreamingEntryId: (id: string | null) => void;
  setEntries: (entries: ChatEntry[]) => void;
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
  selectedHistorySessionId: null,
  appliedHistorySessionId: null,
  historyAutoLoadAttempted: false,
  sending: false,
  starting: false,
  ending: false,
  streamingEntryId: null,
  entryCounter: 0,

  // Actions
  nextId: () => {
    const id = `entry-${get().entryCounter + 1}`;
    set({ entryCounter: get().entryCounter + 1 });
    return id;
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
      sessionStatus: "idle",
      pendingApproval: false,
      pendingBackup: false,
      thinking: false,
      streamingEntryId: null,
      sending: false,
      starting: false,
      ending: false,
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
      selectedHistorySessionId: null,
      appliedHistorySessionId: null,
      historyAutoLoadAttempted: false,
      sending: false,
      starting: false,
      ending: false,
      streamingEntryId: null,
      entryCounter: 0,
    });
  },

  setInputValue: (v) => set({ inputValue: v }),
  setThinking: (v) => set({ thinking: v }),
  setPendingApproval: (v) => set({ pendingApproval: v }),
  setPendingBackup: (v) => set({ pendingBackup: v }),
  setSessionId: (id) => set({ sessionId: id }),
  setSessionStatus: (s) => set({ sessionStatus: s }),
  setSelectedHistorySessionId: (id) => set({ selectedHistorySessionId: id }),
  setAppliedHistorySessionId: (id) => set({ appliedHistorySessionId: id }),
  setHistoryAutoLoadAttempted: (v) => set({ historyAutoLoadAttempted: v }),
  setSending: (v) => set({ sending: v }),
  setStarting: (v) => set({ starting: v }),
  setEnding: (v) => set({ ending: v }),
  setStreamingEntryId: (id) => set({ streamingEntryId: id }),
  setEntries: (entries) => set({ entries }),
}));

export const useDoctorPanelStore = createSelectors(useDoctorPanelStoreBase);
