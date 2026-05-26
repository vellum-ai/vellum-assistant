/**
 * Memory v3 route definitions — read-only diagnostics over the hand-authored
 * v3 tree DAG.
 *
 * Two operations, both side-effect-free (no LLM, no writes):
 *
 *   - `memory_v3_validate` — returns the {@link TreeValidationReport} from
 *     `validateTree(workspaceDir)` (orphan pages, cycles, dangling refs,
 *     stale-index, unknown edge targets).
 *   - `memory_v3_tree` — returns a JSON-serializable view of
 *     `getTreeIndex(workspaceDir)`: the root id, every node id, and each
 *     node's ordered child refs. `TreeIndex` is Map-based, so the handler
 *     flattens it into arrays/objects the wire protocol can carry.
 *
 * The v3 tree is authored by the v2 → v3 data-migration; these routes are the
 * on-demand inspection surface operators run while that migration is in flight.
 * They are NOT invoked on any turn.
 */

import { z } from "zod";

import { loadConfig } from "../../config/loader.js";
import type { AssistantConfig } from "../../config/types.js";
import { getDb } from "../../memory/db-connection.js";
import { readActivationLogsForShadowDiff } from "../../memory/memory-v2-activation-log-store.js";
import type {
  RetrievalCost,
  RetrievalInput,
} from "../../memory/v2/harness/retriever.js";
import type { DescentTrace } from "../../memory/v2/harness/trace.js";
import { loadNowText } from "../../memory/v2/now-text.js";
import type { LlmCallRecord } from "../../memory/v3/llm-capture.js";
import { runRetrievalLoop } from "../../memory/v3/loop.js";
import type {
  ShadowDiffResult,
  ShadowDiffTurn,
  SlugFrequency,
  UnpairedShadowTurn,
} from "../../memory/v3/shadow-diff.js";
import { computeShadowDiff } from "../../memory/v3/shadow-diff.js";
import { getTreeIndex } from "../../memory/v3/tree-index.js";
import type { TreeValidationReport } from "../../memory/v3/validate.js";
import { validateTree } from "../../memory/v3/validate.js";
import { getWorkspaceDir } from "../../util/platform.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// Re-export the loop trace/cost shapes so the CLI renderer can import them from
// this route module (type-only) without reaching across the
// `cli/no-daemon-internals` boundary into `memory/v2/harness/*`.
export type { RetrievalCost } from "../../memory/v2/harness/retriever.js";
export type {
  DescentPass,
  DescentTrace,
  EdgeExpansion,
  GateDecision,
  ScoutResult,
  TreeLevel,
} from "../../memory/v2/harness/trace.js";
export type { LlmCallRecord };
export type {
  ShadowDiffResult,
  ShadowDiffTurn,
  SlugFrequency,
  UnpairedShadowTurn,
};

// ── Validate ────────────────────────────────────────────────────────────

const MemoryV3ValidateParams = z.object({}).strict();

/**
 * Wire shape for `memory_v3_validate`. Identical to the daemon-internal
 * {@link TreeValidationReport} — every field is already serializable, so the
 * route forwards it verbatim. Re-exported as its own type so the CLI can
 * import it without reaching into the validator module.
 */
export type MemoryV3ValidateResult = TreeValidationReport;

async function handleValidate({
  body = {},
}: RouteHandlerArgs): Promise<MemoryV3ValidateResult> {
  // Read-only structural validation of the v3 tree. Like the v2 validate
  // route, it is intentionally ungated: operators dry-run it while the
  // v2 → v3 migration is mid-flight, well before any v3 flag flips.
  MemoryV3ValidateParams.parse(body);
  return validateTree(getWorkspaceDir());
}

// ── Tree ────────────────────────────────────────────────────────────────

const MemoryV3TreeParams = z.object({}).strict();

/** One node in the serialized tree view: its id and ordered child refs. */
export interface MemoryV3TreeNodeView {
  id: string;
  children: Array<{ kind: "node" | "page"; ref: string }>;
}

/**
 * JSON-serializable projection of the {@link TreeIndex}. `TreeIndex` keys its
 * adjacency by `Map`, which doesn't survive JSON, so the handler flattens it:
 * `root` is the entry-point node id and `nodes` is every node with its ordered
 * child refs. The CLI renderer walks `nodes`/`root` to print an indented tree,
 * marking shared-DAG re-entries.
 */
export interface MemoryV3TreeResult {
  root: string;
  nodes: MemoryV3TreeNodeView[];
}

async function handleTree({
  body = {},
}: RouteHandlerArgs): Promise<MemoryV3TreeResult> {
  MemoryV3TreeParams.parse(body);

  const tree = await getTreeIndex(getWorkspaceDir());

  const nodes: MemoryV3TreeNodeView[] = [...tree.nodes.keys()]
    .sort()
    .map((id) => ({
      id,
      children: (tree.childrenByNode.get(id) ?? []).map((child) => ({
        kind: child.kind,
        ref: child.ref,
      })),
    }));

  return { root: tree.root, nodes };
}

// ── Simulate ──────────────────────────────────────────────────────────────

/** The five v3 retrieval lanes, in fanout order. */
const V3_LANE_NAMES = ["hot", "sparse", "dense", "tree", "edges"] as const;

const MemoryV3SimulateParams = z
  .object({
    /** The ad-hoc user query to route a single synthetic turn against. */
    query: z.string().min(1, "memory.v3.simulate query must be non-empty"),
    /**
     * Optional `<now>` override. When omitted the live workspace NOW.md is
     * loaded so the run exercises production-like standing context.
     */
    nowText: z.string().optional(),
    /** Override `memory.v3.passCap` for this run only. */
    passCap: z
      .number()
      .int("memory.v3.simulate passCap must be an integer")
      .positive("memory.v3.simulate passCap must be positive")
      .optional(),
    /**
     * Restrict the run to this allowlist of lanes (others forced off). Omit to
     * inherit the live `memory.v3.lanes` toggles.
     */
    lanes: z.array(z.enum(V3_LANE_NAMES)).optional(),
  })
  .strict();

/** The v3 lane toggle block, echoed back so the caller sees what actually ran. */
export interface MemoryV3SimulateLanes {
  hot: boolean;
  sparse: boolean;
  dense: boolean;
  tree: boolean;
  edges: boolean;
}

/**
 * Wire shape for `memory_v3_simulate`. The loop's `sourceBySlug` Map is
 * flattened to a plain object (lane label per slug); `trace`/`cost` are already
 * JSON-serializable. `effectiveConfig` echoes the passCap + lane toggles the
 * run actually used after overrides were applied.
 */
export interface MemoryV3SimulateResult {
  query: string;
  selectedSlugs: string[];
  /** Per-slug provenance lane: `hot` | `sparse` | `dense` | `tree` | `edge`. */
  sourceBySlug: Record<string, string>;
  trace: DescentTrace;
  cost: RetrievalCost;
  /** Non-null when the dense filter failed open on any pass. */
  failureReason: string | null;
  /**
   * Every v3 LLM call made during the run (filter / each descender / gate),
   * with full input + raw response. Empty unless capture was on (it always is
   * for simulate). Read-only debug surface — persisted nowhere.
   */
  llmCalls: LlmCallRecord[];
  effectiveConfig: {
    passCap: number;
    lanes: MemoryV3SimulateLanes;
  };
}

/**
 * Overlay the simulate overrides on the live config. Only the v3 passCap + lane
 * toggles are exposed; everything else (providers, prompts, scout quotas) stays
 * exactly as a live turn would see it. `write.coactivation` is forced off so the
 * simulate stays strictly read-only — the loop's only persistence path is the
 * co-activation insert, which this guarantees never fires.
 */
function applyV3SimulateOverrides(
  live: AssistantConfig,
  overrides: { passCap?: number; lanes?: ReadonlyArray<string> },
): AssistantConfig {
  const liveV3 = live.memory.v3;
  const lanes = overrides.lanes
    ? {
        hot: overrides.lanes.includes("hot"),
        sparse: overrides.lanes.includes("sparse"),
        dense: overrides.lanes.includes("dense"),
        tree: overrides.lanes.includes("tree"),
        edges: overrides.lanes.includes("edges"),
      }
    : liveV3.lanes;
  return {
    ...live,
    memory: {
      ...live.memory,
      v3: {
        ...liveV3,
        ...(overrides.passCap !== undefined
          ? { passCap: overrides.passCap }
          : {}),
        lanes,
        write: { ...liveV3.write, coactivation: false },
      },
    },
  };
}

/**
 * Run the v3 retrieval loop read-only against a single ad-hoc query and return
 * its selection, per-lane provenance, and full descent trace. Mirrors the
 * single-turn semantics of `memory_v2_simulate_router` (the query becomes the
 * just-arrived `userMessage` of one synthetic turn) and the input-build of the
 * v3 shadow middleware, but persists nothing.
 *
 * The loop is invoked directly — it is NOT gated by `memory.v3.enabled` /
 * `.shadow` (those gates live in the shadow middleware), so operators can probe
 * v3 retrieval while the flags are still off.
 */
async function handleSimulate({
  body = {},
}: RouteHandlerArgs): Promise<MemoryV3SimulateResult> {
  const {
    query,
    nowText: rawNowText,
    passCap,
    lanes,
  } = MemoryV3SimulateParams.parse(body);

  const config = applyV3SimulateOverrides(loadConfig(), { passCap, lanes });

  const workspaceDir = getWorkspaceDir();
  const nowText =
    rawNowText !== undefined ? rawNowText : await loadNowText(workspaceDir);

  const input: RetrievalInput = {
    workspaceDir,
    recentTurnPairs: [{ assistantMessage: "", userMessage: query }],
    nowText,
    priorEverInjected: [],
    config,
  };

  const llmCalls: LlmCallRecord[] = [];
  const output = await runRetrievalLoop(input, {
    db: getDb(),
    capture: (record) => llmCalls.push(record),
  });

  const sourceBySlug: Record<string, string> = {};
  for (const [slug, lane] of output.sourceBySlug.entries()) {
    sourceBySlug[slug] = lane;
  }

  return {
    query,
    selectedSlugs: output.selectedSlugs,
    sourceBySlug,
    trace: output.trace ?? { passes: [] },
    cost: output.cost ?? {},
    failureReason: output.failureReason ?? null,
    llmCalls,
    effectiveConfig: {
      passCap: config.memory.v3.passCap,
      lanes: config.memory.v3.lanes,
    },
  };
}

// ── Shadow-diff ─────────────────────────────────────────────────────────

/** Default pairing tolerance: a shadow row + its router sibling land ~1-2s apart. */
const DEFAULT_SHADOW_DIFF_TOLERANCE_SEC = 10;
/** Default cap on per-turn detail rows returned (aggregates are unbounded). */
const DEFAULT_SHADOW_DIFF_LIMIT = 50;
/** Milliseconds per day, for the `sinceDays` read-window cutoff. */
const MS_PER_DAY = 86_400_000;

const MemoryV3ShadowDiffParams = z
  .object({
    /** Only consider shadow rows newer than this many days. Omit for all rows. */
    sinceDays: z
      .number()
      .positive("memory.v3.shadow-diff sinceDays must be positive")
      .optional(),
    /** Max |Δt| (seconds) to pair a shadow row with a router row. */
    toleranceSec: z
      .number()
      .positive("memory.v3.shadow-diff toleranceSec must be positive")
      .optional(),
    /** Cap on per-turn detail rows in the response (newest first). */
    limit: z
      .number()
      .int("memory.v3.shadow-diff limit must be an integer")
      .positive("memory.v3.shadow-diff limit must be positive")
      .optional(),
  })
  .strict();

/**
 * Compare the v3 shadow selections against the live v2 router selections,
 * turn-for-turn, from the activation log. Read-only: reads `v3_shadow` rows and
 * the `router` rows they pair with (bounded to those conversations + time
 * span), then diffs each pair. Requires v3 shadow mode to have been running
 * (`memory.v3.enabled` + `.shadow`) so the `v3_shadow` rows exist; the route
 * itself runs no LLM and writes nothing.
 */
async function handleShadowDiff({
  body = {},
}: RouteHandlerArgs): Promise<ShadowDiffResult> {
  const { sinceDays, toleranceSec, limit } =
    MemoryV3ShadowDiffParams.parse(body);

  const sinceMs =
    sinceDays !== undefined ? Date.now() - sinceDays * MS_PER_DAY : null;
  const toleranceMs =
    (toleranceSec ?? DEFAULT_SHADOW_DIFF_TOLERANCE_SEC) * 1000;

  const { shadow, router } = readActivationLogsForShadowDiff({
    sinceMs,
    paddingMs: toleranceMs,
  });

  return computeShadowDiff(shadow, router, {
    toleranceMs,
    detailLimit: limit ?? DEFAULT_SHADOW_DIFF_LIMIT,
  });
}

// ── Route definitions ───────────────────────────────────────────────────

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "memory_v3_validate",
    method: "POST",
    endpoint: "memory/v3/validate",
    handler: handleValidate,
    summary: "Validate the memory v3 tree structure (read-only)",
    description:
      "Read-only structural validation of the hand-authored v3 tree DAG. Reports dangling child refs, orphan pages, cycles, stale compositional indexes, and unknown edge targets. Writes nothing and runs no LLM — operators dry-run it while the v2 → v3 migration is in flight.",
    tags: ["memory"],
    requestBody: MemoryV3ValidateParams,
  },
  {
    operationId: "memory_v3_tree",
    method: "POST",
    endpoint: "memory/v3/tree",
    handler: handleTree,
    summary: "Return a serializable view of the memory v3 tree DAG (read-only)",
    description:
      "Returns the v3 tree root id plus every node and its ordered child refs (page:/node:) as a JSON-serializable projection of the in-memory TreeIndex. Read-only; the CLI uses it to print an indented tree with shared-DAG re-entries marked.",
    tags: ["memory"],
    requestBody: MemoryV3TreeParams,
  },
  {
    operationId: "memory_v3_simulate",
    method: "POST",
    endpoint: "memory/v3/simulate",
    handler: handleSimulate,
    summary:
      "Dry-run the v3 retrieval loop against an ad-hoc query (read-only)",
    description:
      "Runs the v3 multi-lane bounded-descent retrieval loop read-only against a single synthetic turn built from the supplied query plus the live (or supplied) NOW context. Returns the selected page slugs, per-lane provenance, the full multi-pass descent trace, and accumulated cost. Optional passCap / lane-allowlist overrides apply on top of live config. Invoked directly (not gated by memory.v3.enabled/shadow) so operators can probe v3 retrieval before flipping the flags; writes nothing (co-activation persistence is forced off), though each pass still spends the loop's filter + gate LLM calls.",
    tags: ["memory"],
    requestBody: MemoryV3SimulateParams,
  },
  {
    operationId: "memory_v3_shadow_diff",
    method: "POST",
    endpoint: "memory/v3/shadow-diff",
    handler: handleShadowDiff,
    summary:
      "Diff v3 shadow selections against live v2 router selections (read-only)",
    description:
      "Compares the v3 shadow-mode selections against the live v2 router selections turn-for-turn, from the memory activation log. Pairs each v3_shadow row with the nearest v2 router row in the same conversation (by timestamp, within a tolerance — the turn columns use different counters), then reports per-turn and aggregate overlap, what v3 surfaced that v2 did not, and what v2 had that v3 dropped, broken down by v3 provenance lane. The v2 comparand is the router's fresh per-turn pick (status='injected'), not its accumulated in-context set. Requires that v3 shadow mode has been running so v3_shadow rows exist; the route runs no LLM and writes nothing.",
    tags: ["memory"],
    requestBody: MemoryV3ShadowDiffParams,
  },
];
