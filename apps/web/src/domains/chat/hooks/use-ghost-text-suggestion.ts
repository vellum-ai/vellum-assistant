import { useQuery } from "@tanstack/react-query";

import { fetchSuggestion } from "@/domains/chat/api/suggestion-api";
import type { DisplayMessage } from "@/domains/chat/utils/reconcile";

interface UseGhostTextSuggestionParams {
  assistantId: string | null;
  conversationId: string | null;
  messages: DisplayMessage[];
  /**
   * Current composer input. The hook itself doesn't read or guard against
   * input changes — the gate is render-time: when the user has typed
   * anything, callers ignore the returned value (`ChatComposer` already
   * does this via `computeGhostSuffix` and we just return `null` here as a
   * convenience).
   */
  input: string;
}

/**
 * Server-state hook for the after-turn autocomplete ghost text shown in
 * the chat composer.
 *
 * Architecture (LUM-2009): the suggestion is a server-derived value keyed
 * by `(assistantId, conversationId, lastCompleteAssistantMsgId)` and
 * belongs in TanStack Query, not in component-local `useState`. The query
 * key gives us:
 *
 *   - **Dedup** — same key → no new fetch (the prior `lastSuggestionMsgIdRef`
 *     is gone).
 *   - **Implicit clear on send / on conversation switch** — when the
 *     latest message becomes a user message (after send) or
 *     `conversationId` changes, the key derives a new value or `null`
 *     and the previous cache entry is no longer matched. No
 *     `setSuggestion(null)` plumbing needed.
 *   - **Implicit suppression while streaming** — `lastCompleteAssistantMsgId`
 *     gates on `!isStreaming`, so the query is disabled until the
 *     assistant's reply is complete.
 *
 * The "user has typed since the fetch started" guard is *not* in this
 * hook. It's a render-time concern; the consumer either ignores the
 * value when `input` is non-empty (see `computeGhostSuffix` in
 * `ChatComposer`) or relies on us returning `null` early here.
 */
export function useGhostTextSuggestion({
  assistantId,
  conversationId,
  messages,
  input,
}: UseGhostTextSuggestionParams): string | null {
  // The fetch is keyed on the *latest completed assistant message*; if the
  // last row is a user message (just sent) or an in-flight assistant
  // stream, there is nothing to suggest *from*. Anything else (no
  // messages, missing assistant id, etc.) also disables the query.
  const lastMsg = messages[messages.length - 1];
  const lastCompleteAssistantMsgId =
    lastMsg && lastMsg.role === "assistant" && !lastMsg.isStreaming
      ? lastMsg.id ?? null
      : null;

  const enabled =
    Boolean(assistantId) &&
    Boolean(conversationId) &&
    Boolean(lastCompleteAssistantMsgId);

  const query = useQuery({
    queryKey: [
      "chat",
      "suggestion",
      assistantId,
      conversationId,
      lastCompleteAssistantMsgId,
    ] as const,
    queryFn: ({ signal }) =>
      fetchSuggestion(
        assistantId as string,
        conversationId as string,
        lastCompleteAssistantMsgId as string,
        signal,
      ),
    enabled,
    // The suggestion never changes for a given (conversation, last
    // assistant message) tuple, so cache it forever per key. The implicit
    // refresh trigger is the user sending or the assistant replying,
    // which switches us to a new key.
    staleTime: Infinity,
    gcTime: 5 * 60 * 1000,
    // Don't retry — a missed suggestion is purely cosmetic and we don't
    // want to fight a daemon that returns null repeatedly.
    retry: false,
  });

  if (input) return null;
  return query.data?.suggestion ?? null;
}
