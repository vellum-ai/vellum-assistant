/**
 * Session-scoped registry of conversations the server has reported as
 * missing (HTTP 404 on `GET /v1/conversations/:id`).
 *
 * A 404 on the detail endpoint is an answer, not a transient failure: the
 * conversation is gone server-side. Two consumers act on it:
 *
 * - `useActiveConversation` stops fetching the row once its id is
 *   registered, so a dead selection can not spin repeated detail requests
 *   (several components mount that hook against the same selected
 *   conversation, and each would otherwise issue its own 404-ing fetch).
 * - `useConversationLoader` reacts to the *active* conversation being
 *   registered by reconciling the list and routing the user to a safe
 *   chat route, and refuses to re-select a registered id during landing,
 *   so recovery cannot loop back onto the same missing conversation.
 *
 * Not persisted: a session that never sees the 404 keeps working, and a
 * later session re-asks the server, which is the only authority on
 * whether the conversation came back (a fork, an import, a restore).
 *
 * @see {@link https://zustand.docs.pmnd.rs/}
 */

import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";

// ---------------------------------------------------------------------------
// Keying
// ---------------------------------------------------------------------------

/**
 * Composite registry key. A conversation id alone is not enough: ids are
 * UUIDs minted per assistant, but the registry is consulted with the pair
 * the API path carries (`/v1/assistants/:assistant_id/conversations/:id`),
 * and keying on the pair keeps a missing row on one assistant from
 * suppressing a detail fetch for an id that only coincidentally matches.
 *
 * `\u0000` separator: cannot appear in either id, so the pair is
 * unambiguous in both directions.
 */
function missingConversationKey(
  assistantId: string,
  conversationId: string,
): string {
  return `${assistantId}\u0000${conversationId}`;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface MissingConversationState {
  /**
   * Registered `(assistantId, conversationId)` pairs, keyed by
   * {@link missingConversationKey}. Presence (`true`) is the whole value;
   * there is nothing useful to record about a row the server does not have.
   */
  missing: Readonly<Record<string, true>>;
  /**
   * Register a pair. Idempotent: marking an already-registered pair keeps
   * the existing state object (no re-render, no re-run of the loader's
   * recovery effect).
   */
  markMissing: (assistantId: string, conversationId: string) => void;
}

export const useMissingConversationStore = createSelectors(
  create<MissingConversationState>()((set, get) => ({
    missing: {},
    markMissing: (assistantId, conversationId) => {
      const key = missingConversationKey(assistantId, conversationId);
      if (get().missing[key]) {
        return;
      }
      set({ missing: { ...get().missing, [key]: true } });
    },
  })),
);

// ---------------------------------------------------------------------------
// Plain-function API (imperative readers, outside React)
// ---------------------------------------------------------------------------

/** Whether the server has reported this conversation missing this session. */
export function isConversationMissing(
  assistantId: string | null,
  conversationId: string | null,
): boolean {
  if (!assistantId || !conversationId) {
    return false;
  }
  return Boolean(
    useMissingConversationStore.getState().missing[
      missingConversationKey(assistantId, conversationId)
    ],
  );
}

/** Register a conversation the server reported as missing (404). */
export function markConversationMissing(
  assistantId: string,
  conversationId: string,
): void {
  useMissingConversationStore
    .getState()
    .markMissing(assistantId, conversationId);
}

/**
 * React-side read for the pair a component cares about, as a boolean so a
 * selector returns a primitive (stable across renders unless it flips).
 */
export function useIsConversationMissing(
  assistantId: string | null,
  conversationId: string | null,
): boolean {
  return useMissingConversationStore((state) =>
    assistantId && conversationId
      ? Boolean(
          state.missing[
            missingConversationKey(assistantId, conversationId)
          ],
        )
      : false,
  );
}
