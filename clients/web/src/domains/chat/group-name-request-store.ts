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
 * A pending group-name dialog.
 *
 * `create` optionally carries a conversation to move into the new group. Two
 * entry points share it: "New group…" on a conversation's menu (creates, then
 * moves that conversation in) and "New group…" on the sidebar's own context
 * menu (creates an empty group and leaves it for the user to fill). The
 * conversation is what distinguishes them, so the dialog itself needs no mode
 * beyond create/rename.
 *
 * `rename` carries the target group id and a snapshot of its current name and
 * icon, captured at request time so a background groups refetch can't reset
 * the inputs mid-edit (mirrors `rename-request-store`).
 */
export type GroupNameRequest =
  | { mode: "create"; conversation?: Conversation }
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
  /** Omit `conversation` to create an empty group. */
  requestCreateGroup: (conversation?: Conversation) => void;
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
