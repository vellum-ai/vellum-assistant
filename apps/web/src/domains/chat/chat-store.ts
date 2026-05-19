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
 * - `useChatActions()` — stable action refs (sendMessage, dispatchers)
 *
 * Reference: {@link https://zustand.docs.pmnd.rs/}
 */

import { type Dispatch, useEffect } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/shallow";

import type { DisplayAttachment, DisplayMessage } from "@/domains/chat/lib/reconcile.js";
import type { DomainEvent } from "@/domains/chat/lib/turn-state-machine.js";
import type { InteractionEvent } from "@/domains/chat/lib/interaction-state-machine.js";

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
  /** Dispatch a turn state-machine event. */
  dispatchTurn: Dispatch<DomainEvent>;
  /** Dispatch an interaction state-machine event. */
  dispatchInteraction: Dispatch<InteractionEvent>;
}

export type ChatStore = ChatState & ChatActions;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const NOOP_SEND: ChatActions["sendMessage"] = async () => {};
const NOOP_DISPATCH: Dispatch<never> = () => {};

export const useChatStore = create<ChatStore>()(() => ({
  messages: [],
  activeConversationKey: null,
  assistantId: null,
  sendMessage: NOOP_SEND,
  dispatchTurn: NOOP_DISPATCH as Dispatch<DomainEvent>,
  dispatchInteraction: NOOP_DISPATCH as Dispatch<InteractionEvent>,
}));

// ---------------------------------------------------------------------------
// Sync hook — bridges parent-owned state into the store
// ---------------------------------------------------------------------------

export interface ChatStoreSyncProps {
  messages: DisplayMessage[];
  activeConversationKey: string | null;
  assistantId: string | null;
  sendMessage: (content: string, attachments?: DisplayAttachment[]) => Promise<void>;
  dispatchTurn: Dispatch<DomainEvent>;
  dispatchInteraction: Dispatch<InteractionEvent>;
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
    dispatchTurn,
    dispatchInteraction,
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
      dispatchTurn,
      dispatchInteraction,
    });
  }, [sendMessage, dispatchTurn, dispatchInteraction]);
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
 * Stable action dispatchers (sendMessage, dispatchTurn, dispatchInteraction).
 * Does **not** re-render when messages or active conversation change.
 */
export function useChatActions(): ChatActions {
  return useChatStore(
    useShallow((s) => ({
      sendMessage: s.sendMessage,
      dispatchTurn: s.dispatchTurn,
      dispatchInteraction: s.dispatchInteraction,
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
