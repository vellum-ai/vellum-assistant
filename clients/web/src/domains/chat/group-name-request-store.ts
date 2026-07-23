/**
 * Shared group-name-dialog request state.
 *
 * "New group…" (from the move-to-group submenu) and group rename (from the
 * group actions menu / context menu) both open one `NameInputDialog`. A single
 * Zustand store ensures only one dialog instance exists and every trigger
 * converges on the same state. `ChatLayout` owns the dialog; callers write to
 * the store to request it.
 *
 * @see {@link https://zustand.docs.pmnd.rs/}
 */

import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";
import type { Conversation } from "@/types/conversation-types";

/**
 * A pending group-name dialog. `create` carries the conversation that will be
 * moved into the newly created group; `rename` carries only the target group
 * id (the current name is resolved from the groups query at open time).
 */
export type GroupNameRequest =
  | { mode: "create"; conversation: Conversation }
  | { mode: "rename"; groupId: string };

interface GroupNameRequestState {
  groupNameRequest: GroupNameRequest | null;
}

interface GroupNameRequestActions {
  requestCreateGroup: (conversation: Conversation) => void;
  requestRenameGroup: (groupId: string) => void;
  clearGroupNameRequest: () => void;
}

type GroupNameRequestStore = GroupNameRequestState & GroupNameRequestActions;

const useGroupNameRequestStoreBase = create<GroupNameRequestStore>((set) => ({
  groupNameRequest: null,
  requestCreateGroup: (conversation) =>
    set({ groupNameRequest: { mode: "create", conversation } }),
  requestRenameGroup: (groupId) =>
    set({ groupNameRequest: { mode: "rename", groupId } }),
  clearGroupNameRequest: () => set({ groupNameRequest: null }),
}));

export const useGroupNameRequestStore = createSelectors(
  useGroupNameRequestStoreBase,
);
