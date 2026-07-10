/**
 * Header-slot state for `ChatLayout`'s shared `ChatLayoutHeader`.
 *
 * Routes under `ChatLayout` populate the header's center and right
 * section. The setters are actions on this
 * store; consumers register their content from a `useEffect` and
 * clear it on unmount.
 *
 * Why a store instead of outlet context: routes under
 * `ActiveAssistantGate` see the gate's `<Outlet />` as their nearest
 * outlet, which wraps the matched child in
 * `<OutletContext.Provider value={undefined}>` — gated routes
 * therefore can't read a setter that `ChatLayout` published through
 * its own outlet context. A module-level store sidesteps the whole
 * Provider-stacking problem and matches the convention that
 * cross-route state lives in Zustand.
 *
 * @see https://reactrouter.com/start/framework/outlet
 */

import { create } from "zustand";
import type { ReactNode } from "react";

import { createSelectors } from "@/utils/create-selectors";
import type { Conversation } from "@/types/conversation-types";

// ---------------------------------------------------------------------------
// Header supplements — data-only values that ChatPage contributes to the
// header so ChatLayout can render the ConversationActionsMenu directly.
// ---------------------------------------------------------------------------

export interface ChatHeaderSupplements {
  hasPersistedMessage: boolean;
  /** Human label for the originating external channel (e.g. a Slack
   *  channel name, a Telegram sender) shown alongside the conversation
   *  title, or null for native Vellum conversations. */
  channelHeaderLabel: string | null;
  /** Origin channel id (`"slack"`, `"telegram"`, …) backing
   *  {@link channelHeaderLabel}, used to pick the channel icon. Null for
   *  native conversations. */
  channelHeaderChannelId: string | null;
  /** Secondary action callbacks — ChatPage-specific because they need
   *  access to the message list, active stream, or ChatPage-local state. */
  onForkConversation: (() => void) | null;
  onOpenInNewWindow: ((conversation: Conversation) => void) | null;
  onInspect: ((conversation: Conversation) => void) | null;
  onCopyConversation: (() => void) | null;
  onRefresh: (() => void) | null;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface ChatLayoutSlotsState {
  topBarCenter: ReactNode;
  topBarRightSlot: ReactNode;
  headerSupplements: ChatHeaderSupplements | null;
}

interface ChatLayoutSlotsActions {
  setTopBarCenter: (node: ReactNode) => void;
  setTopBarRightSlot: (node: ReactNode) => void;
  setHeaderSupplements: (supplements: ChatHeaderSupplements | null) => void;
}

type ChatLayoutSlotsStore = ChatLayoutSlotsState & ChatLayoutSlotsActions;

const useChatLayoutSlotsStoreBase = create<ChatLayoutSlotsStore>((set) => ({
  topBarCenter: null,
  topBarRightSlot: null,
  headerSupplements: null,
  setTopBarCenter: (topBarCenter) => set({ topBarCenter }),
  setTopBarRightSlot: (topBarRightSlot) => set({ topBarRightSlot }),
  setHeaderSupplements: (headerSupplements) => set({ headerSupplements }),
}));

export const useChatLayoutSlotsStore = createSelectors(
  useChatLayoutSlotsStoreBase,
);
