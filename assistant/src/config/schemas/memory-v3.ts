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
      .nonnegative("memory.v3.hotSet.k must be a non-negative integer")
      .default(40)
      .describe(
        "Number of top frecency-scored pages included in the hot-set lane. 0 disables the lane.",
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

/**
 * Entity-lane tuning: the heading-anchored named-entity match. A distinctive
 * token the message shares with a `## ` section heading surfaces that section,
 * so a named entity (person, place, project, product, bot) the additive needle
 * buries under a long message's bulk theme is retrieved on the exact-name
 * signal instead.
 */
export const MemoryV3EntitySchema = z
  .object({
    enabled: z
      .boolean({ error: "memory.v3.entity.enabled must be a boolean" })
      .default(true)
      .describe(
        "Whether the entity lane runs: surface the section whose `## ` heading names a distinctive entity the message mentions. Recall-additive and ~free when the message names no catalogued entity.",
      ),
    idfFloor: z
      .number({ error: "memory.v3.entity.idfFloor must be a number" })
      .nonnegative("memory.v3.entity.idfFloor must be a non-negative number")
      .default(4)
      .describe(
        'Minimum corpus IDF for a `## ` heading token to become an entity key. Excludes hub tokens (e.g. "vellum") common enough that an exact match cannot disambiguate; those pages ride the core/hot lanes instead.',
      ),
    cap: z
      .number({ error: "memory.v3.entity.cap must be a number" })
      .int("memory.v3.entity.cap must be an integer")
      .positive("memory.v3.entity.cap must be a positive integer")
      .default(8)
      .describe(
        "Hard cap on the number of distinct entity-heading articles surfaced per turn.",
      ),
  })
  .describe(
    "Memory v3 entity-lane (heading-anchored named-entity match) tuning.",
  );

/**
 * Per-turn injection-gate tuning: thresholds the retrieval signals must clear
 * for the gate to open and run the selector. The gate runs only when the
 * `memory-v3-injection-gate` feature flag (the rollout switch) AND the
 * `enabled` kill-switch below are both on.
 */
export const MemoryV3GateSchema = z
  .object({
    enabled: z
      .boolean({ error: "memory.v3.gate.enabled must be a boolean" })
      .default(true)
      .describe(
        "Whether the injection gate may run at all. false forces the full selection process every turn regardless of the `memory-v3-injection-gate` feature flag; true (default) defers to the flag.",
      ),
    denseThreshold: z
      .number({ error: "memory.v3.gate.denseThreshold must be a number" })
      .min(0)
      .max(1)
      .default(0.66)
      .describe(
        "Top-1 dense cosine similarity must clear this for a dense pass.",
      ),
    sparseThreshold: z
      .number({ error: "memory.v3.gate.sparseThreshold must be a number" })
      .min(0)
      .max(1)
      .default(0.35)
      .describe(
        "Normalized top-1 BM25F must clear this for any sparse signal.",
      ),
    sparseOnlyThreshold: z
      .number({ error: "memory.v3.gate.sparseOnlyThreshold must be a number" })
      .min(0)
      .max(1)
      .default(0.75)
      .describe(
        "Higher normalized-BM25F bar to pass on sparse signal alone when dense fails.",
      ),
    denseClusterThreshold: z
      .number({
        error: "memory.v3.gate.denseClusterThreshold must be a number",
      })
      .min(0)
      .max(1)
      .default(0.6)
      .describe(
        "Floor every top-3 dense score must clear for a borderline-cluster pass.",
      ),
    denseClusterMaxDelta: z
      .number({ error: "memory.v3.gate.denseClusterMaxDelta must be a number" })
      .min(0)
      .max(1)
      .default(0.02)
      .describe(
        "Maximum spread (max-min) within the top-3 dense cluster for a cluster pass.",
      ),
    topK: z
      .number({ error: "memory.v3.gate.topK must be a number" })
      .int("memory.v3.gate.topK must be an integer")
      .positive("memory.v3.gate.topK must be a positive integer")
      .default(5)
      .describe(
        "Number of top candidates examined per retriever (dense, sparse).",
      ),
    bm25NormK: z
      .union([z.number().positive(), z.null()])
      .default(null)
      .describe(
        "BM25F normalization constant k in norm = raw/(raw+k). null = built-in default (auto-calibration pending).",
      ),
    bypassForCore: z
      .boolean({ error: "memory.v3.gate.bypassForCore must be a boolean" })
      .default(false)
      .describe(
        "When the gate closes, still run selectPool over only the stable prefix (core/hot/fresh/skills) instead of skipping entirely. Off by default — the gate is a hard skip.",
      ),
  })
  .describe(
    "Memory v3 per-turn injection gate tuning (thresholds; the gate runs when the `memory-v3-injection-gate` feature flag AND `enabled` are both on).",
  );

// NOTE: a retired `workingSet` sub-config (maxPages/evictWindow for the old
// per-turn carry set) used to live here. Existing user config files may still
// contain the key; zod default unknown-key stripping accepts and ignores it,
// so legacy configs keep parsing. Do not make this object `.strict()`.
//
// The retrieval tuning defaults across these sub-schemas (hotSet.k, freshSet.k,
// learnedEdges.cap, edge.{seedCount,perSeed,cap}) and the top-level needleK /
// denseK / replyQueryK / selectorEnabled are the FULL (established-corpus)
// profile. Sparse-corpus assistants run the lean new-user profile
// (`resolveV3Tuning` / `MEMORY_V3_NEW_USER_TUNING` in the v3 plugin's
// `tuning-profile.ts`) until they cross `MEMORY_V3_FULL_PROFILE_MIN_PAGES` real
// concept pages, at which point these configured values take effect.
export const MemoryV3ConfigSchema = z
  .object({
    live: z
      .boolean({ error: "memory.v3.live must be a boolean" })
      .default(false)
      .describe(
        "Whether memory-v3 is the live injected memory source, suppressing v2 injection. Off by default; brand-new assistants are switched on at creation via a workspace migration, while existing assistants stay on v2 until explicitly enabled.",
      ),
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
      .nonnegative("memory.v3.needleK must be a non-negative integer")
      .default(100)
      .describe(
        "Number of section-grain BM25 needle articles folded into the candidate pool each turn. 0 disables the needle lane.",
      ),
    denseK: z
      .number({ error: "memory.v3.denseK must be a number" })
      .int("memory.v3.denseK must be an integer")
      .nonnegative("memory.v3.denseK must be a non-negative integer")
      .default(100)
      .describe(
        "Number of dense-lane articles folded into the candidate pool each turn after embedding the turn query. 0 disables dense retrieval for both current-message and reply-query passes.",
      ),
    replyQueryK: z
      .number({ error: "memory.v3.replyQueryK must be a number" })
      .int("memory.v3.replyQueryK must be an integer")
      .nonnegative("memory.v3.replyQueryK must be a non-negative integer")
      .default(12)
      .describe(
        "Per-lane article budget for the reply-query finder pass: needle and dense each re-run over the assistant's previous message as separate queries (never concatenated with the user's message). 0 disables the pass. Deliberately small next to needleK/denseK — the pass adds the assistant-side retrieval signal, not a second full sweep.",
      ),
    selectorEnabled: z
      .boolean({ error: "memory.v3.selectorEnabled must be a boolean" })
      .default(true)
      .describe(
        "Whether to run the memory-v3 selector LLM callsite over the candidate pool. When false, every pooled candidate is passed through to injection directly; an empty pool produces no memory block.",
      ),
    selectorPromptPath: z
      .string({ error: "memory.v3.selectorPromptPath must be a string" })
      .nullable()
      .default(null)
      .describe(
        "Optional path to a file whose contents replace the bundled per-turn selector system prompt (the instructions that tell the selector which candidate pages to keep). Relative paths resolve under the workspace root; absolute paths and a leading `~/` (expanded to the home directory) are honored only when they still resolve inside the workspace root — a path that lands outside the workspace (including via symlinks) is rejected. The selector prompt takes no placeholders — the candidate pool is supplied separately as the user message — so the file is used verbatim. If the file is rejected, missing, unreadable, empty, or over 1 MiB, the bundled prompt is used and a warning is logged.",
      ),
    edge: MemoryV3EdgeSchema.default(MemoryV3EdgeSchema.parse({})),
    entity: MemoryV3EntitySchema.default(MemoryV3EntitySchema.parse({})),
    gate: MemoryV3GateSchema.default(MemoryV3GateSchema.parse({})),
  })
  .describe("Memory v3 — section-grain lane retrieval");

export type MemoryV3Config = z.infer<typeof MemoryV3ConfigSchema>;
