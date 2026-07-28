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
 * moved into the newly created group; `rename` carries the target group id and
 * a snapshot of its current name and icon, captured at request time so a
 * background groups refetch can't reset the inputs mid-edit (mirrors
 * `rename-request-store`).
 */
export type GroupNameRequest =
  | { mode: "create"; conversation: Conversation }
  | {
      mode: "rename";
      groupId: string;
      currentName: string;
      currentIcon: string | null;
    };

interface GroupNameRequestState {
  groupNameRequest: GroupNameRequest | null;
}

interface GroupNameRequestActions {
  requestCreateGroup: (conversation: Conversation) => void;
  requestRenameGroup: (
    groupId: string,
    currentName: string,
    currentIcon: string | null,
  ) => void;
  clearGroupNameRequest: () => void;
}

type GroupNameRequestStore = GroupNameRequestState & GroupNameRequestActions;

const useGroupNameRequestStoreBase = create<GroupNameRequestStore>((set) => ({
  groupNameRequest: null,
  requestCreateGroup: (conversation) =>
    set({ groupNameRequest: { mode: "create", conversation } }),
  requestRenameGroup: (groupId, currentName, currentIcon) =>
    set({
      groupNameRequest: { mode: "rename", groupId, currentName, currentIcon },
    }),
  clearGroupNameRequest: () => set({ groupNameRequest: null }),
}));

export const useGroupNameRequestStore = createSelectors(
  useGroupNameRequestStoreBase,
);
