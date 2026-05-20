/**
 * Zustand store for chat state shared across deeply-nested components.
 *
 * Selector-based subscriptions let each consumer re-render only when
 * its slice changes — critical during streaming where `messages`
 * updates at ~50 ms cadence.
 *
 * **Primary API** — selector-based (finest granularity):
 * ```ts
 * const messages = useChatStore((s) => s.messages);
 * ```
 *
 * **Convenience hooks** — grouped slices for common patterns:
 * - `useChatState()` — state slice (messages, conversation key, assistant ID)
 * - `useChatActions()` — stable action refs (sendMessage)
 *
 * Interaction state lives in its own store (`useInteractionStore`).
 * Turn state lives in its own store (`useTurnStore`).
 *
 * Reference: {@link https://zustand.docs.pmnd.rs/}
 */

import { useEffect } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/shallow";

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

export const useChatStore = create<ChatStore>()(() => ({
  messages: [],
  activeConversationKey: null,
  assistantId: null,
  sendMessage: NOOP_SEND,
}));

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

// ---------------------------------------------------------------------------
// Consumer hooks
// ---------------------------------------------------------------------------

/**
 * Read-only chat state (messages, active conversation, assistant ID).
 * Re-renders only when one of these three values changes.
 * Use `useChatActions()` if you only need to dispatch.
 */
export function useChatState(): ChatState {
  return useChatStore(
    useShallow((s) => ({
      messages: s.messages,
      activeConversationKey: s.activeConversationKey,
      assistantId: s.assistantId,
    })),
  );
}

/**
 * Stable action refs (sendMessage).
 * Does **not** re-render when messages or active conversation change.
 */
export function useChatActions(): ChatActions {
  return useChatStore(
    useShallow((s) => ({
      sendMessage: s.sendMessage,
    })),
  );
}

/**
 * Full store snapshot. Prefer `useChatState()` or `useChatActions()`
 * to minimize re-renders — this hook re-renders on any store change.
 */
export function useChatSnapshot(): ChatStore {
  return useChatStore(useShallow((s) => s));
}
