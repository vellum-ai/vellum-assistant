/**
 * The memory reads are the two queries whose answers are derived from assistant
 * config, and both use hand-rolled query keys the generated `assistantConfig`
 * invalidation doesn't reach. A key that drifts from its query fails silently:
 * nothing throws, the invalidation just misses, and the Memory tab keeps
 * serving a pre-write answer for five minutes. Pin the keys to their queries.
 */
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";

import { memoryGraphOptions } from "./get-memory-graph";
import { memoryStatsOptions } from "./get-memory-stats";
import { invalidateMemoryQueries } from "./invalidate-memory-queries";

const ASSISTANT = "assistant-123";
const OTHER = "assistant-456";

/** Seed a query as fresh (not stale) so invalidation is observable. */
function seed(client: QueryClient, queryKey: readonly unknown[]) {
  client.setQueryData(queryKey, { kind: "unsupported" });
  return () => client.getQueryState(queryKey)?.isInvalidated === true;
}

describe("invalidateMemoryQueries", () => {
  test("invalidates both memory reads for the assistant", () => {
    const client = new QueryClient();
    const graphInvalidated = seed(
      client,
      memoryGraphOptions(ASSISTANT).queryKey,
    );
    const statsInvalidated = seed(
      client,
      memoryStatsOptions(ASSISTANT).queryKey,
    );

    invalidateMemoryQueries(client, ASSISTANT);

    expect(graphInvalidated()).toBe(true);
    expect(statsInvalidated()).toBe(true);
  });

  test("leaves another assistant's cached memory alone", () => {
    // Both keys are assistant-scoped; a switch between assistants must not
    // discard the one the user isn't looking at.
    const client = new QueryClient();
    const otherGraph = seed(client, memoryGraphOptions(OTHER).queryKey);
    const otherStats = seed(client, memoryStatsOptions(OTHER).queryKey);

    invalidateMemoryQueries(client, ASSISTANT);

    expect(otherGraph()).toBe(false);
    expect(otherStats()).toBe(false);
  });
});
