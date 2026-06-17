/**
 * Message bookmarks — client data layer.
 *
 * Wraps the generated bookmark API (`/v1/assistants/{id}/bookmarks`) in
 * TanStack Query so the list is fetched once and shared across every caller
 * (the per-message hover toggle and the Settings → Bookmarks tab). TanStack is
 * the single source of truth — there is no separate store mirroring the list.
 *
 * The query only runs when the `bookmarks` client feature flag is on AND an
 * assistant is resolved, so flag-off installs never hit the endpoint.
 *
 * Cross-client invalidation (a bookmark made in another tab/window) is handled
 * by `use-bookmarks-sync.ts`, which listens for the daemon's
 * `bookmark.created` / `bookmark.deleted` SSE events.
 */

import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  bookmarksGetOptions,
  bookmarksGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import {
  bookmarksBymessageByMessageIdDelete,
  bookmarksPost,
} from "@/generated/daemon/sdk.gen";
import type { BookmarksGetResponse } from "@/generated/daemon/types.gen";
import { captureError } from "@/lib/sentry/capture-error";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { toast } from "@vellumai/design-library";

/** A single bookmark row as returned by `GET /v1/.../bookmarks`. */
export type Bookmark = NonNullable<BookmarksGetResponse>["bookmarks"][number];

const EMPTY_BOOKMARKS: Bookmark[] = [];

/** Whether the `bookmarks` client feature flag is enabled. */
export function useBookmarksEnabled(): boolean {
  return useClientFeatureFlagStore.use.bookmarks();
}

/** Active assistant id + whether the shared bookmark query should run. */
function useBookmarkQueryGate(): { assistantId: string | null; enabled: boolean } {
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const enabled = useBookmarksEnabled() && Boolean(assistantId);
  return { assistantId, enabled };
}

/** Full bookmark list for the Settings tab, newest-first. */
export function useBookmarks(): {
  bookmarks: Bookmark[];
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
} {
  const { assistantId, enabled } = useBookmarkQueryGate();
  const query = useQuery({
    ...bookmarksGetOptions({ path: { assistant_id: assistantId ?? "" } }),
    enabled,
  });
  return {
    bookmarks: query.data?.bookmarks ?? EMPTY_BOOKMARKS,
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: () => {
      void query.refetch();
    },
  };
}

/**
 * Whether `messageId` is currently bookmarked. Uses a `select` so a message
 * row only re-renders when its own bookmarked state flips, not on every
 * change to the list.
 */
export function useIsBookmarked(messageId: string | undefined): boolean {
  const { assistantId, enabled } = useBookmarkQueryGate();
  const query = useQuery({
    ...bookmarksGetOptions({ path: { assistant_id: assistantId ?? "" } }),
    enabled,
    select: (res) =>
      messageId ? res.bookmarks.some((b) => b.messageId === messageId) : false,
  });
  return query.data ?? false;
}

/**
 * Returns a stable `toggle(messageId, conversationId, currentlyBookmarked)`
 * that creates or deletes a bookmark with an optimistic cache update (rolled
 * back on error), then invalidates to reconcile with the server. Mirrors the
 * imperative SDK-call pattern used by the Archive settings page.
 */
export function useBookmarkToggle(): (
  messageId: string,
  conversationId: string,
  currentlyBookmarked: boolean,
) => Promise<void> {
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const queryClient = useQueryClient();

  return useCallback(
    async (messageId, conversationId, currentlyBookmarked) => {
      if (!assistantId) return;
      const queryKey = bookmarksGetQueryKey({
        path: { assistant_id: assistantId },
      });

      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<BookmarksGetResponse>(queryKey);

      queryClient.setQueryData<BookmarksGetResponse>(queryKey, (old) => {
        const list = old?.bookmarks ?? [];
        if (currentlyBookmarked) {
          return { bookmarks: list.filter((b) => b.messageId !== messageId) };
        }
        if (list.some((b) => b.messageId === messageId)) return old;
        const now = Date.now();
        const optimistic: Bookmark = {
          id: `optimistic-${messageId}`,
          messageId,
          conversationId,
          conversationTitle: null,
          messagePreview: "",
          messageRole: "",
          messageCreatedAt: now,
          createdAt: now,
        };
        return { bookmarks: [optimistic, ...list] };
      });

      try {
        if (currentlyBookmarked) {
          await bookmarksBymessageByMessageIdDelete({
            path: { assistant_id: assistantId, messageId },
            throwOnError: true,
          });
        } else {
          await bookmarksPost({
            path: { assistant_id: assistantId },
            body: { messageId, conversationId },
            throwOnError: true,
          });
        }
      } catch (error) {
        if (previous !== undefined) {
          queryClient.setQueryData(queryKey, previous);
        }
        captureError(error, { context: "bookmark_toggle" });
        toast.error(
          currentlyBookmarked
            ? "Failed to remove bookmark."
            : "Failed to bookmark message.",
        );
      } finally {
        void queryClient.invalidateQueries({ queryKey });
      }
    },
    [assistantId, queryClient],
  );
}
