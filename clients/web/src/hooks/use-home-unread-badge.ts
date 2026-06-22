import { useHomeFeedQuery } from "@/domains/home/hooks/use-home-feed-query";

/**
 * Returns whether the home feed has any unread ("new") items for the
 * given assistant. Used to drive the sidebar badge indicator.
 */
export function useHomeUnreadBadge(assistantId: string | null) {
  const homeFeedQuery = useHomeFeedQuery(assistantId);
  const hasUnreadHome =
    homeFeedQuery.data?.items.some((item) => item.status === "new") ?? false;
  return { hasUnreadHome };
}
