import { onlineManager } from "@tanstack/react-query";

import { isTransientNetworkError } from "@/utils/is-transient-network-error";

export type ConversationAssetSource =
  | "apps"
  | "documents"
  | "attachments"
  | "frames";

export interface ConversationAssetSourceState {
  supported: boolean;
  hasData: boolean;
  pending: boolean;
  fetching: boolean;
  failure: "load" | "refresh" | "page" | null;
  scope: "conversation" | "loaded-history";
}

export function conversationAssetSourceState(query: {
  data: unknown;
  isError: boolean;
  error: Error | null;
  isFetching: boolean;
  isFetchNextPageError?: boolean;
}): ConversationAssetSourceState {
  const hasData = query.data !== undefined;
  const waitsForReconnect =
    isTransientNetworkError(query.error) && !onlineManager.isOnline();
  const failed = query.isError && !waitsForReconnect;
  return {
    supported: true,
    hasData,
    pending: !hasData && !failed,
    fetching: query.isFetching,
    failure: failed
      ? query.isFetchNextPageError
        ? "page"
        : hasData
          ? "refresh"
          : "load"
      : null,
    scope: "conversation",
  };
}

export function summarizeAssetSources(sources: ConversationAssetSourceState[]) {
  const active = sources.filter((source) => source.supported);
  const failed = active.some((source) => source.failure !== null);
  const pending = active.some((source) => source.pending);
  return {
    status: failed
      ? ("error" as const)
      : pending
        ? ("pending" as const)
        : ("ready" as const),
    allFailed:
      active.length > 0 &&
      active.every((source) => source.failure !== null && !source.hasData),
    exact: sources.every(
      (source) =>
        source.supported &&
        source.hasData &&
        !source.failure &&
        source.scope === "conversation",
    ),
  };
}

export function retryConversationAssetQuery(
  query: Parameters<typeof conversationAssetSourceState>[0] & {
    refetch: (options: { cancelRefetch: boolean }) => Promise<unknown>;
    fetchNextPage?: (options: { cancelRefetch: boolean }) => Promise<unknown>;
  },
): void {
  if (!conversationAssetSourceState(query).failure || query.isFetching) {
    return;
  }
  if (query.isFetchNextPageError && query.fetchNextPage) {
    void query.fetchNextPage({ cancelRefetch: false });
  } else {
    void query.refetch({ cancelRefetch: false });
  }
}
