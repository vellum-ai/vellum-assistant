import { useQuery } from "@tanstack/react-query";

import { fetchSuggestion } from "@/domains/chat/api/suggestion-api";

const GHOST_TEXT_SUGGESTION_GC_MS = 5 * 60_000;

/**
 * Query-key factory for the ghost-text suggestion query.
 *
 * Exported so unrelated call sites (e.g. SSE handlers, daemon
 * push-driven invalidators) can invalidate or read from the same cache
 * entry without re-deriving the key shape.
 */
export function ghostTextSuggestionQueryKey(
  assistantId: string | null,
  conversationId: string | null,
  lastCompleteAssistantMsgId: string | null,
): readonly unknown[] {
  return [
    "chat",
    "suggestion",
    assistantId,
    conversationId,
    lastCompleteAssistantMsgId,
  ];
}

interface UseGhostTextSuggestionParams {
  assistantId: string | null;
  conversationId: string | null;
  /**
   * Id of the latest *completed* assistant message in the active
   * conversation, or `null` if the latest row is a user message, an
   * in-flight assistant stream, or nothing.
   *
   * The caller is responsible for this derivation (typically a
   * `useMemo` over the `messages` array). Keeping the hook parameter a
   * scalar makes its dependency surface explicit and means the hook
   * doesn't need to subscribe to message-array identity changes.
   */
  lastCompleteAssistantMsgId: string | null;
}

/**
 * Server-state hook for the after-turn autocomplete ghost text shown in
 * the chat composer.
 *
 * The suggestion is a server-derived value keyed by
 * `(assistantId, conversationId, lastCompleteAssistantMsgId)`. The query
 * key gives us:
 *
 *   - **Dedup** — same key → no new fetch.
 *   - **Implicit clear on send / on conversation switch** — when the
 *     latest message becomes a user message (after send) or
 *     `conversationId` changes, the key derives a new value or `null`
 *     and the previous cache entry is no longer matched.
 *   - **Implicit suppression while streaming** — `lastCompleteAssistantMsgId`
 *     is `null` until the assistant's reply finishes.
 *
 * The hook is *pure* w.r.t. composer input: it always returns the
 * cached suggestion (or `null` when nothing is cached). The render-time
 * gate that decides whether to show ghost text — and whether to show
 * the full suggestion or just the unrendered suffix — lives in
 * `ChatComposer.computeGhostSuffix`. Keeping that gate in one place
 * preserves the "type the prefix → see only the tail as ghost"
 * suffix-completion behavior.
 */
export function useGhostTextSuggestion({
  assistantId,
  conversationId,
  lastCompleteAssistantMsgId,
}: UseGhostTextSuggestionParams): string | null {
  const enabled =
    assistantId != null &&
    conversationId != null &&
    lastCompleteAssistantMsgId != null;

  const query = useQuery({
    queryKey: ghostTextSuggestionQueryKey(
      assistantId,
      conversationId,
      lastCompleteAssistantMsgId,
    ),
    queryFn: ({ signal }) =>
      fetchSuggestion(
        assistantId as string,
        conversationId as string,
        lastCompleteAssistantMsgId as string,
        signal,
      ),
    enabled,
    // The suggestion never changes for a given (conversation, last
    // assistant message) tuple, so cache it forever per key. The
    // implicit refresh trigger is the user sending or the assistant
    // replying, which switches us to a new key.
    staleTime: Infinity,
    gcTime: GHOST_TEXT_SUGGESTION_GC_MS,
    // Don't retry — a missed suggestion is purely cosmetic and we
    // don't want to fight a daemon that returns null repeatedly.
    retry: false,
  });

  return query.data?.suggestion ?? null;
}
