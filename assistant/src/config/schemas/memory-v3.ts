import { z } from "zod";

/**
 * Memory v3 (section-grain lane retrieval) working-set configuration.
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

/**
 * Edge-lane tuning for the link-graph expansion that folds a turn's lexical and
 * dense seeds outward to their first-class neighbours.
 */
export const MemoryV3EdgeSchema = z
  .object({
    hubDegree: z
      .number({ error: "memory.v3.edge.hubDegree must be a number" })
      .int("memory.v3.edge.hubDegree must be an integer")
      .positive("memory.v3.edge.hubDegree must be a positive integer")
      .default(30)
      .describe(
        "In-degree above which an article is treated as a hub and excluded from edge expansion (too generic to be a useful surface).",
      ),
    seedCount: z
      .number({ error: "memory.v3.edge.seedCount must be a number" })
      .int("memory.v3.edge.seedCount must be an integer")
      .positive("memory.v3.edge.seedCount must be a positive integer")
      .default(18)
      .describe(
        "Number of top needle+dense seeds (in rank order) expanded by the edge lane.",
      ),
    perSeed: z
      .number({ error: "memory.v3.edge.perSeed must be a number" })
      .int("memory.v3.edge.perSeed must be an integer")
      .positive("memory.v3.edge.perSeed must be a positive integer")
      .default(6)
      .describe("Maximum neighbours surfaced per expanded seed."),
    cap: z
      .number({ error: "memory.v3.edge.cap must be a number" })
      .int("memory.v3.edge.cap must be an integer")
      .positive("memory.v3.edge.cap must be a positive integer")
      .default(45)
      .describe(
        "Hard cap on the total number of distinct articles surfaced by the edge lane.",
      ),
  })
  .describe("Memory v3 edge-lane (link-graph expansion) tuning.");

export const MemoryV3ConfigSchema = z
  .object({
    workingSet: MemoryV3WorkingSetSchema.default(
      MemoryV3WorkingSetSchema.parse({}),
    ),
    needleK: z
      .number({ error: "memory.v3.needleK must be a number" })
      .int("memory.v3.needleK must be an integer")
      .positive("memory.v3.needleK must be a positive integer")
      .default(100)
      .describe(
        "Number of section-grain BM25 needle articles folded into the candidate pool each turn.",
      ),
    denseK: z
      .number({ error: "memory.v3.denseK must be a number" })
      .int("memory.v3.denseK must be an integer")
      .positive("memory.v3.denseK must be a positive integer")
      .default(100)
      .describe(
        "Number of dense-lane articles folded into the candidate pool each turn.",
      ),
    edge: MemoryV3EdgeSchema.default(MemoryV3EdgeSchema.parse({})),
  })
  .describe(
    "Memory v3 — section-grain lane retrieval with a carry-forward working set",
  );

export type MemoryV3Config = z.infer<typeof MemoryV3ConfigSchema>;
