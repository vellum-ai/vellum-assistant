import { z } from "zod";

/**
 * Memory v3 (topic-tree routing) working-set configuration.
 *
 * The working set is the per-conversation set of concept pages carried
 * forward across turns. Eviction keeps it bounded: pages unseen for longer
 * than `evictWindow` turns are dropped, and the set is capped at `maxPages`.
 */
export const MemoryV3WorkingSetSchema = z
  .object({
    maxPages: z
      .number({ error: "memory.v3.workingSet.maxPages must be a number" })
      .int("memory.v3.workingSet.maxPages must be an integer")
      .positive("memory.v3.workingSet.maxPages must be a positive integer")
      .default(150)
      .describe(
        "Upper bound on the number of pages retained in the working set. Once exceeded, the least-salient non-pinned pages are evicted until the set fits.",
      ),
    evictWindow: z
      .number({ error: "memory.v3.workingSet.evictWindow must be a number" })
      .int("memory.v3.workingSet.evictWindow must be an integer")
      .positive("memory.v3.workingSet.evictWindow must be a positive integer")
      .default(5)
      .describe(
        "Number of turns a non-pinned page may go unseen before it is evicted from the working set.",
      ),
  })
  .describe("Memory v3 working-set retention/eviction tuning.");

export const MemoryV3ConfigSchema = z
  .object({
    workingSet: MemoryV3WorkingSetSchema.default(
      MemoryV3WorkingSetSchema.parse({}),
    ),
  })
  .describe("Memory v3 — topic-tree routing with a carry-forward working set");

export type MemoryV3Config = z.infer<typeof MemoryV3ConfigSchema>;
