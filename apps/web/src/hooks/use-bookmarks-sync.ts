/**
 * Bus consumer for cross-client bookmark invalidation.
 *
 * The daemon publishes `bookmark.created` / `bookmark.deleted` over SSE after
 * every mutation so any other connected client refreshes its bookmark list in
 * lock-step. This hook listens on the event bus and invalidates the shared
 * bookmark query when one of those events lands.
 *
 * The discriminant is read as a plain string: the published
 * `@vellumai/assistant-api` event union does not model bookmark events, so a
 * typed `=== "bookmark.created"` comparison would not narrow.
 *
 * References:
 * - EVENT_BUS.md — bus subscription contract
 * - hooks/use-document-editor-sync.ts — sibling SSE bus consumer
 */

import { useQueryClient } from "@tanstack/react-query";

import { bookmarksGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

export function useBookmarksSync(): void {
  const queryClient = useQueryClient();
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();

  useBusSubscription("sse.event", (envelope) => {
    const type = (envelope.message as { type?: string }).type;
    if (type !== "bookmark.created" && type !== "bookmark.deleted") return;
    if (!assistantId) return;
    void queryClient.invalidateQueries({
      queryKey: bookmarksGetQueryKey({ path: { assistant_id: assistantId } }),
    });
  });
}
