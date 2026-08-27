/**
 * channel-reference-store: the one external-channel message pinned to the
 * Vellum composer.
 *
 * One at a time, by construction: the state is a single slot rather than a
 * list, so "reference this instead" is the only thing a second pick can mean
 * and there is no ordering question to answer on send. Staged quotes are a
 * list because each carries its own reply; a channel reference carries none.
 *
 * Read by:
 * - `ChannelTranscriptPanel` (stages / unstages picks from the drawer rows)
 * - `ChannelReferenceChip` (renders the staged slot above the composer)
 * - `ChatComposer` (a staged reference counts as sendable content)
 * - `useComposerSubmit` (folds it into the outgoing message, then clears)
 * - `ChatMainPanel` (reconciles on conversation switch and flag changes)
 */

import { create } from "zustand";

import type { ChannelReference } from "@/domains/chat/channel-sidecar/channel-reference";
import { createSelectors } from "@/utils/create-selectors";

interface ChannelReferenceState {
  reference: ChannelReference | null;
}

interface ChannelReferenceActions {
  setReference: (reference: ChannelReference) => void;
  /**
   * Stage `reference`, or clear the slot when the same row is already staged.
   * Powers the drawer's per-row toggle, where picking the staged row again
   * takes it back off the composer.
   */
  toggleReference: (reference: ChannelReference) => void;
  clearReference: () => void;
  /**
   * Settle the slot as its owning context changes: clears when the sidecar
   * flag is off (a disabled feature leaves no composer state behind), or when
   * the staged row belongs to a conversation other than `conversationId`. A
   * reference staged in the conversation on screen, with the flag on,
   * survives untouched, so closing and reopening the drawer keeps it.
   */
  reconcileReference: (context: {
    conversationId: string | null;
    sidecarEnabled: boolean;
  }) => void;
}

type ChannelReferenceStore = ChannelReferenceState & ChannelReferenceActions;

const useChannelReferenceStoreBase = create<ChannelReferenceStore>()(
  (set, get) => ({
    reference: null,

    setReference: (reference) => set({ reference }),

    toggleReference: (reference) => {
      const current = get().reference;
      const isSameRow =
        current != null &&
        current.messageId === reference.messageId &&
        current.conversationId === reference.conversationId;
      set({ reference: isSameRow ? null : reference });
    },

    clearReference: () => {
      if (get().reference === null) {
        return;
      }
      set({ reference: null });
    },

    reconcileReference: ({ conversationId, sidecarEnabled }) => {
      const current = get().reference;
      if (current === null) {
        return;
      }
      if (sidecarEnabled && current.conversationId === conversationId) {
        return;
      }
      set({ reference: null });
    },
  }),
);

export const useChannelReferenceStore = createSelectors(
  useChannelReferenceStoreBase,
);
