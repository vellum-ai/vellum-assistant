import { useHomeFeedQuery } from "@/domains/home/hooks/use-home-feed-query";

export function useHomeUnreadBadge(assistantId: string | null) {
  const homeFeedQuery = useHomeFeedQuery(assistantId);
  const hasUnreadHome =
    homeFeedQuery.data?.items.some((item) => item.status === "new") ?? false;
  return { hasUnreadHome };
}
