/**
 * Zustand store for chat state shared across deeply-nested components.
 *
 * Wrapped with `createSelectors` for auto-generated per-field hooks.
 * Selector-based subscriptions let each consumer re-render only when
 * its slice changes — critical during streaming where `messages`
 * updates at ~50 ms cadence.
 *
 * **Primary API** — per-field selectors (finest granularity):
 * ```ts
 * const messages = useChatStore.use.messages();
 * ```
 *
 * **Non-React code** — use `.getState()` in callbacks, effects, handlers:
 * ```ts
 * const { messages } = useChatStore.getState();
 * ```
 *
 * Interaction state lives in its own store (`useInteractionStore`).
 * Turn state lives in its own store (`useTurnStore`).
 *
 * @see {@link https://zustand.docs.pmnd.rs/}
 * @see {@link https://zustand.docs.pmnd.rs/learn/guides/auto-generating-selectors}
 */

import { useEffect } from "react";
import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors.js";
import type { DisplayAttachment, DisplayMessage } from "@/domains/chat/utils/reconcile.js";

// ---------------------------------------------------------------------------
// Store shape
// ---------------------------------------------------------------------------

export interface ChatState {
  /** Current transcript messages for the active conversation. */
  messages: DisplayMessage[];
  /** Key identifying the active conversation, or `null` when none is selected. */
  activeConversationKey: string | null;
  /** Current assistant ID, or `null` before the assistant is resolved. */
  assistantId: string | null;
}

export interface ChatActions {
  /** Send a user message (with optional attachments) to the active conversation. */
  sendMessage: (content: string, attachments?: DisplayAttachment[]) => Promise<void>;
}

export type ChatStore = ChatState & ChatActions;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const NOOP_SEND: ChatActions["sendMessage"] = async () => {};

const useChatStoreBase = create<ChatStore>()(() => ({
  messages: [],
  activeConversationKey: null,
  assistantId: null,
  sendMessage: NOOP_SEND,
}));

export const useChatStore = createSelectors(useChatStoreBase);

// ---------------------------------------------------------------------------
// Sync hook — bridges parent-owned state into the store
// ---------------------------------------------------------------------------

export interface ChatStoreSyncProps {
  messages: DisplayMessage[];
  activeConversationKey: string | null;
  assistantId: string | null;
  sendMessage: (content: string, attachments?: DisplayAttachment[]) => Promise<void>;
}

/**
 * Pushes parent-owned state into the Zustand store so descendant
 * components can subscribe via selectors. Call this in the component
 * that owns the chat state (e.g. `ChatPage`).
 */
export function useSyncChatStore(props: ChatStoreSyncProps): void {
  const {
    messages,
    activeConversationKey,
    assistantId,
    sendMessage,
  } = props;

  useEffect(() => {
    useChatStore.setState({
      messages,
      activeConversationKey,
      assistantId,
    });
  }, [messages, activeConversationKey, assistantId]);

  useEffect(() => {
    useChatStore.setState({
      sendMessage,
    });
  }, [sendMessage]);
}


