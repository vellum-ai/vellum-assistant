/**
 * A query cache for one Storybook story: a `QueryClient` whose queries never
 * retry or go stale, seeded with the data the story's component reads, and a
 * decorator that provides it. A story whose component fetches through a query
 * hook renders from the seeded entries and never asks the network.
 *
 * Seeding is a callback on the client rather than a list of key and value
 * pairs, so each entry keeps the type a generated query key carries:
 * `client.setQueryData(configGetQueryKey(...), CONFIG)` still checks `CONFIG`.
 */

import type { Decorator } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";

/** Writes the entries a story's component reads into its query cache. */
export type SeedQueryCache = (client: QueryClient) => void;

/**
 * A query client for a story. Nothing retries, so an unseeded query settles as
 * an error at once instead of looping. A seeded entry never goes stale, and
 * nothing refetches it on mount, focus or reconnect, even under a query's own
 * finite `staleTime`, so none of those replaces it with a request to an
 * assistant the story does not have. A query that sets its own
 * `refetchInterval` still polls, since no client default can stop that. A query
 * with no data still loads on mount, so a story of a loading or error state
 * keeps it. Nothing is garbage-collected, so an entry seeded for a query that
 * mounts later (a section that starts collapsed) is still there.
 */
export function createStoryQueryClient(seed?: SeedQueryCache): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity,
        gcTime: Infinity,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      },
    },
  });
  seed?.(client);
  return client;
}

/**
 * A decorator giving a story its own query cache. The client is made once,
 * when the decorator is, so a story's re-renders keep what it has fetched;
 * give each story that needs a different cache its own call.
 */
export function withQueryCache(
  seed?: SeedQueryCache,
): (Story: Parameters<Decorator>[0]) => ReactElement {
  const client = createStoryQueryClient(seed);
  return function WithQueryCache(Story) {
    return (
      <QueryClientProvider client={client}>
        <Story />
      </QueryClientProvider>
    );
  };
}
