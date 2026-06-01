/**
 * Shared rename-request state for conversations.
 *
 * Both `ChatLayout` (sidebar right-click) and `ChatConversationHeader`
 * (top-bar chevron menu) can trigger a rename. A single Zustand store
 * ensures only one `RenameConversationDialog` instance exists and both
 * triggers converge on the same state.
 *
 * `ChatLayout` owns the dialog; callers write to the store to request
 * a rename.
 */

import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";

interface RenameRequestState {
  renameRequest: { conversationId: string; currentTitle: string } | null;
}

interface RenameRequestActions {
  requestRename: (conversationId: string, currentTitle: string) => void;
  clearRename: () => void;
}

type RenameRequestStore = RenameRequestState & RenameRequestActions;

const useRenameRequestStoreBase = create<RenameRequestStore>((set) => ({
  renameRequest: null,
  requestRename: (conversationId, currentTitle) =>
    set({ renameRequest: { conversationId, currentTitle } }),
  clearRename: () => set({ renameRequest: null }),
}));

export const useRenameRequestStore = createSelectors(
  useRenameRequestStoreBase,
);
