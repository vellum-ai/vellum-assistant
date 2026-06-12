import { z } from "zod";

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

/**
 * Hot-set lane tuning: the top-K pages by exponentially-decayed selection
 * frequency (frecency) folded into the candidate pool as a stable lane.
 */
export const MemoryV3HotSetSchema = z
  .object({
    k: z
      .number({ error: "memory.v3.hotSet.k must be a number" })
      .int("memory.v3.hotSet.k must be an integer")
      .positive("memory.v3.hotSet.k must be a positive integer")
      .default(40)
      .describe(
        "Number of top frecency-scored pages included in the hot-set lane.",
      ),
    halfLifeDays: z
      .number({ error: "memory.v3.hotSet.halfLifeDays must be a number" })
      .positive("memory.v3.hotSet.halfLifeDays must be a positive number")
      .default(14)
      .describe(
        "Frecency decay half-life in days: a selection this old contributes half the weight of one made now.",
      ),
  })
  .describe("Memory v3 hot-set lane (decayed selection frequency) tuning.");

/**
 * Fresh-set lane tuning: the top-K pages by most-recent on-disk modification
 * folded into the candidate pool as a stable-prefix lane. Recency covers the
 * window before the other lanes can reach a just-written page (no selection
 * history for the hot set; nothing lexical for the finders on summary-shaped
 * messages).
 */
export const MemoryV3FreshSetSchema = z
  .object({
    k: z
      .number({ error: "memory.v3.freshSet.k must be a number" })
      .int("memory.v3.freshSet.k must be an integer")
      .nonnegative("memory.v3.freshSet.k must be a non-negative integer")
      .default(100)
      .describe(
        "Number of most-recently-modified pages included in the fresh-set lane (0 disables the lane). Sized to cover roughly the last day or two of page writes — the recency window conversations reference most.",
      ),
  })
  .describe("Memory v3 fresh-set lane (page-modification recency) tuning.");

/**
 * Learned-edge lane tuning: a co-selection NPMI association graph over the
 * selection log, expanded alongside the static link graph. Behavioral edges
 * reach association-relevant pages no lexical, semantic, or authored-link
 * lane can surface.
 */
export const MemoryV3LearnedEdgesSchema = z
  .object({
    halfLifeDays: z
      .number({ error: "memory.v3.learnedEdges.halfLifeDays must be a number" })
      .positive("memory.v3.learnedEdges.halfLifeDays must be a positive number")
      .default(30)
      .describe(
        "Co-selection decay half-life in days: a selector call this old contributes half the weight of one made now.",
      ),
    minCount: z
      .number({ error: "memory.v3.learnedEdges.minCount must be a number" })
      .positive("memory.v3.learnedEdges.minCount must be a positive number")
      .default(3)
      .describe(
        "Minimum decayed co-occurrence mass for a pair to form an edge (the rare-pair noise floor).",
      ),
    npmiFloor: z
      .number({ error: "memory.v3.learnedEdges.npmiFloor must be a number" })
      .nonnegative(
        "memory.v3.learnedEdges.npmiFloor must be a non-negative number",
      )
      .default(0.2)
      .describe("Minimum NPMI for a pair to form an edge."),
    maxPerPage: z
      .number({ error: "memory.v3.learnedEdges.maxPerPage must be a number" })
      .int("memory.v3.learnedEdges.maxPerPage must be an integer")
      .nonnegative(
        "memory.v3.learnedEdges.maxPerPage must be a non-negative integer",
      )
      .default(6)
      .describe(
        "Maximum learned out-edges kept per page, strongest NPMI first (0 disables the lane).",
      ),
    perSeed: z
      .number({ error: "memory.v3.learnedEdges.perSeed must be a number" })
      .int("memory.v3.learnedEdges.perSeed must be an integer")
      .positive("memory.v3.learnedEdges.perSeed must be a positive integer")
      .default(3)
      .describe(
        "Maximum learned neighbours surfaced per expanded seed each turn.",
      ),
    cap: z
      .number({ error: "memory.v3.learnedEdges.cap must be a number" })
      .int("memory.v3.learnedEdges.cap must be an integer")
      .nonnegative("memory.v3.learnedEdges.cap must be a non-negative integer")
      .default(20)
      .describe(
        "Hard cap on total learned-lane surfaced articles per turn (0 disables the pass).",
      ),
  })
  .describe(
    "Memory v3 learned-edge lane (co-selection NPMI association graph) tuning.",
  );

/**
 * Ephemeral section-spotlight tuning: how many of the current turn's selected
 * finder hits render their matched section into the `<memory_spotlight>`
 * block, and how many previous turns' spotlight entries are carried along
 * before they age out. The block is strip-and-replaced every turn, so its
 * size is bounded by `n × (windowTurns + 1)` entries.
 */
export const MemoryV3SpotlightSchema = z
  .object({
    n: z
      .number({ error: "memory.v3.spotlight.n must be a number" })
      .int("memory.v3.spotlight.n must be an integer")
      .positive("memory.v3.spotlight.n must be a positive integer")
      .default(6)
      .describe(
        "Number of the current turn's selected finder hits whose matched sections render into the spotlight block.",
      ),
    windowTurns: z
      .number({ error: "memory.v3.spotlight.windowTurns must be a number" })
      .int("memory.v3.spotlight.windowTurns must be an integer")
      .nonnegative(
        "memory.v3.spotlight.windowTurns must be a non-negative integer",
      )
      .default(2)
      .describe(
        "Number of previous turns whose spotlight entries are carried into the current block before aging out (0 = current turn only).",
      ),
  })
  .describe("Memory v3 ephemeral section-spotlight tuning.");

/**
 * Prune-valve bounds on the resident (non-pruned) frozen-card footprint.
 *
 * Frozen cards accumulate in history with no per-turn bound, so the valve is
 * the structural backstop: once resident card bytes exceed
 * `maxResidentBytes`, the least-recently-selected non-core/non-hot cards are
 * pruned until the footprint is back at `targetResidentBytes`.
 *
 * Defaults rationale: production v2 ran 303KB of accumulated memory unpruned
 * on the widest observed conversation — 384KB max / 256KB target make the
 * valve insurance for growth beyond that, not routine behavior.
 */
export const MemoryV3PruneSchema = z
  .object({
    maxResidentBytes: z
      .number({ error: "memory.v3.prune.maxResidentBytes must be a number" })
      .int("memory.v3.prune.maxResidentBytes must be an integer")
      .positive("memory.v3.prune.maxResidentBytes must be a positive integer")
      .default(393216 /* 384KB */)
      .describe(
        "Resident (non-pruned) card bytes above which the prune valve fires.",
      ),
    targetResidentBytes: z
      .number({
        error: "memory.v3.prune.targetResidentBytes must be a number",
      })
      .int("memory.v3.prune.targetResidentBytes must be an integer")
      .positive(
        "memory.v3.prune.targetResidentBytes must be a positive integer",
      )
      .default(262144 /* 256KB */)
      .describe(
        "Resident card bytes a fired prune reduces the footprint to (must be below maxResidentBytes).",
      ),
  })
  .refine((value) => value.targetResidentBytes < value.maxResidentBytes, {
    error:
      "memory.v3.prune.targetResidentBytes must be less than memory.v3.prune.maxResidentBytes",
  })
  .describe("Memory v3 prune-valve (resident card footprint) bounds.");

// NOTE: a retired `workingSet` sub-config (maxPages/evictWindow for the old
// per-turn carry set) used to live here. Existing user config files may still
// contain the key; zod default unknown-key stripping accepts and ignores it,
// so legacy configs keep parsing. Do not make this object `.strict()`.
export const MemoryV3ConfigSchema = z
  .object({
    prune: MemoryV3PruneSchema.default(MemoryV3PruneSchema.parse({})),
    hotSet: MemoryV3HotSetSchema.default(MemoryV3HotSetSchema.parse({})),
    freshSet: MemoryV3FreshSetSchema.default(MemoryV3FreshSetSchema.parse({})),
    learnedEdges: MemoryV3LearnedEdgesSchema.default(
      MemoryV3LearnedEdgesSchema.parse({}),
    ),
    spotlight: MemoryV3SpotlightSchema.default(
      MemoryV3SpotlightSchema.parse({}),
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
    replyQueryK: z
      .number({ error: "memory.v3.replyQueryK must be a number" })
      .int("memory.v3.replyQueryK must be an integer")
      .nonnegative("memory.v3.replyQueryK must be a non-negative integer")
      .default(12)
      .describe(
        "Per-lane article budget for the reply-query finder pass: needle and dense each re-run over the assistant's previous message as separate queries (never concatenated with the user's message). 0 disables the pass. Deliberately small next to needleK/denseK — the pass adds the assistant-side retrieval signal, not a second full sweep.",
      ),
    edge: MemoryV3EdgeSchema.default(MemoryV3EdgeSchema.parse({})),
  })
  .describe("Memory v3 — section-grain lane retrieval");

export type MemoryV3Config = z.infer<typeof MemoryV3ConfigSchema>;
