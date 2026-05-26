/**
 * Memory v3 — tree-walk model driver.
 *
 * The *intelligence* half of the v3 tree descent. `traversal.ts` owns the
 * mechanical, provider-free walk (`walkTree`); this module supplies the
 * per-node `descend` decision that walk injects, and wires the whole thing into
 * a single `runTreeWalk` entry point.
 *
 * Per visited node the driver makes one cheap LLM call (`memoryV3Descent`) over
 * the node's *composed* index — `composeNodeIndex` renders one line per child
 * (sub-node summary or leaf page summary) plus the node's routing hints — and
 * asks which child *nodes* to descend into. The prompt also carries the
 * conversation context (the just-arrived turn + NOW) and the surviving scout
 * hits, so descent is **scout-seeded but not scout-bound**: the model sees where
 * the cheap lanes already landed, yet still feels pressure to descend branches
 * the scouts missed. A driver that only ratified the scouts would re-introduce
 * the recall cliff the tree walk exists to avoid.
 *
 * Scout seeding works at two layers:
 *   1. **Start set** — `runTreeWalk` derives seed *node* ids from scout-surfaced
 *      *page* slugs via the tree's `pageParents` reverse edges (a scout hit on
 *      `page:foo` seeds every node that lists `page:foo` as a child), unioned
 *      with any explicit `seeds`. `walkTree` fans out from `tree.root` + seeds.
 *   2. **Descend pressure** — the surviving scout slugs are rendered into every
 *      descend prompt so the model can prefer (but is not forced onto) branches
 *      that contain them.
 *
 * Reasoning capture. The `createDescender` signature returns plain `ChildRef[]`
 * (the chosen node children) to match the driver contract; the model's stated
 * rationale is written into a side map keyed by node id. `runTreeWalk` adapts
 * the descender into `walkTree`'s `DescendResult`-returning hook by pairing each
 * node's chosen children with its recorded reasoning, so every emitted
 * `TreeLevel` carries the model's reason for its descend/skip split — making a
 * wrong high-level skip observable rather than silent.
 *
 * Fail-safe. When no provider is configured (or a per-node call errors / returns
 * an unusable response) the descender descends *nothing* for that node and
 * records the reason. The walk still terminates and still collects every leaf
 * page it reached before the failure; it just stops exploring deeper from the
 * affected node. Failing closed (descend nothing) rather than open (descend all)
 * keeps a broken provider from blowing the breadth budget across the whole tree.
 *
 * This module is currently unwired — a later PR composes it into the loop.
 */

import { z } from "zod";

import {
  extractToolUse,
  getConfiguredProvider,
} from "../../providers/provider-send-message.js";
import type {
  Message,
  Provider,
  ToolDefinition,
} from "../../providers/types.js";
import { getLogger } from "../../util/logger.js";
import type { RetrievalInput } from "../v2/harness/retriever.js";
import type { ScoutResult } from "../v2/harness/trace.js";
import type { PageIndex } from "../v2/page-index.js";
import { composeNodeIndex } from "./index-composition.js";
import { renderConversationContext } from "./prompt-context.js";
import {
  DESCENT_SYSTEM_PROMPT,
  resolveV3SystemPrompt,
} from "./prompts/system-prompts.js";
import type { WalkResult } from "./traversal.js";
import { walkTree } from "./traversal.js";
import type { ChildRef, TreeIndex } from "./tree-index.js";

const log = getLogger("memory-v3-tree-walk");

/** Tool name forced via `tool_choice`. Shared constant so tests can match it. */
const DESCEND_TOOL_NAME = "choose_branches";

/**
 * The descend decision the driver hands to `walkTree`. Returns the subset of
 * `children` (node refs only) to recurse into. Matches the PR contract: a plain
 * `ChildRef[]` promise. The model's reasoning is threaded out-of-band via the
 * side map populated by {@link createDescender}, not the return value, so this
 * signature stays small.
 */
export type Descender = (
  nodeId: string,
  children: ChildRef[],
) => Promise<ChildRef[]>;

/** Arguments to {@link createDescender}. */
export interface CreateDescenderArgs {
  input: RetrievalInput;
  tree: TreeIndex;
  pages: PageIndex;
  /** Surviving scout hits — rendered into the prompt as descend pressure. */
  scouts: ScoutResult[];
  /** Explicit seed node ids (folded into the prompt's seed context). */
  seeds: string[];
  /**
   * Provider override seam for tests. Production omits it and the descender
   * resolves `getConfiguredProvider("memoryV3Descent")` per call. Explicit
   * `null` is distinct from `undefined`: it simulates "no provider configured"
   * and exercises the fail-safe path without touching the real registry.
   */
  provider?: Provider | null;
}

/** Arguments to {@link runTreeWalk}. Identical to the descender's args. */
export type RunTreeWalkArgs = CreateDescenderArgs;

/**
 * The forced-tool input schema. `descend` lists the bare node ids the model
 * chose to recurse into; `reasoning` is its stated rationale for the
 * descend/skip split. Mirrors v2's `select_pages_to_inject` forced-tool shape.
 */
const DescendToolResultSchema = z.object({
  descend: z.array(z.string()),
  reasoning: z.string().optional(),
});

/**
 * Build the forced tool definition for one node. `descend` is constrained to
 * the node ids actually offered as `node:` children so the model can only pick
 * from genuine branches (the walk filters anyway, but constraining the schema
 * keeps the model honest and the trace clean).
 */
function buildDescendTool(offeredNodeIds: readonly string[]): ToolDefinition {
  return {
    name: DESCEND_TOOL_NAME,
    description:
      "Choose which child nodes of the current memory-tree node to descend " +
      "into for the current turn. Prefer branches likely to contain pages " +
      "that bear on the turn; you may favor branches the scout hits point at, " +
      "but descend other promising branches too — missing a relevant subtree " +
      "is worse than descending an extra one. Return an empty list only when " +
      "no child node plausibly bears on the turn.",
    input_schema: {
      type: "object",
      properties: {
        descend: {
          type: "array",
          items:
            offeredNodeIds.length > 0
              ? { type: "string", enum: [...offeredNodeIds] }
              : { type: "string" },
          description:
            "Bare ids of the child nodes to descend into. Choose only from " +
            "the offered node children.",
        },
        reasoning: {
          type: "string",
          description:
            "One short sentence: why these branches were descended and the " +
            "rest skipped.",
        },
      },
      required: ["descend"],
    },
  };
}

/**
 * Render the surviving scout hits as descend pressure — the page slugs each
 * lane surfaced, grouped by lane. Empty string when there are no scout hits, so
 * the prompt omits the block entirely.
 */
function renderScoutHits(scouts: readonly ScoutResult[]): string {
  const lines: string[] = [];
  for (const scout of scouts) {
    if (scout.slugs.length === 0) continue;
    lines.push(`[${scout.lane}]: ${scout.slugs.join(", ")}`);
  }
  if (lines.length === 0) return "";
  return `<scout_hits>\n${lines.join("\n")}\n</scout_hits>`;
}

/** Fail-safe descend result: descend nothing, recording why on the side map. */
function failClosed(
  nodeId: string,
  reasoning: string,
  reasoningByNode: Map<string, string>,
): ChildRef[] {
  reasoningByNode.set(nodeId, reasoning);
  return [];
}

/**
 * Create the per-node descend decision driving {@link walkTree}.
 *
 * The returned function makes one forced-tool `memoryV3Descent` call per node
 * over its composed index, returning the chosen `node:` children. The model's
 * reasoning for each node is written into `reasoningByNode` (keyed by node id)
 * rather than the return value, so the small `Descender` signature is preserved
 * and {@link runTreeWalk} can merge the reasoning into each `TreeLevel`.
 *
 * Provider resolution honors the `provider` arg (including explicit `null` for
 * the fail-safe path) and otherwise resolves the configured call site once per
 * call. Any failure — no provider, provider throw, missing/mismatched tool_use
 * — fails closed (descend nothing) with the reason recorded.
 */
export function createDescender(
  args: CreateDescenderArgs,
  reasoningByNode: Map<string, string>,
): Descender {
  const { input, tree, pages, scouts } = args;
  const conversationContext = renderConversationContext(input);
  const scoutHits = renderScoutHits(scouts);
  // Resolve the descent system prompt once for the whole walk — config is
  // stable across the per-node calls, so there is no reason to re-resolve
  // (and re-read any override file) per node.
  const systemPrompt = resolveV3SystemPrompt(
    DESCENT_SYSTEM_PROMPT,
    input.config.memory?.v3?.prompts?.descent,
    input.workspaceDir,
  );

  return async (nodeId: string, children: ChildRef[]): Promise<ChildRef[]> => {
    const offeredNodes = children.filter((c) => c.kind === "node");
    // No node children to descend — nothing to ask the model. Record an empty
    // reasoning so the level still reflects the (trivial) decision.
    if (offeredNodes.length === 0) {
      reasoningByNode.set(nodeId, "");
      return [];
    }

    const provider =
      args.provider !== undefined
        ? args.provider
        : await getConfiguredProvider("memoryV3Descent");
    if (!provider) {
      log.warn(
        { nodeId },
        "memoryV3Descent provider unavailable; descending nothing",
      );
      return failClosed(
        nodeId,
        "no provider configured — descended nothing",
        reasoningByNode,
      );
    }

    const indexBlock = composeNodeIndex(nodeId, tree, pages);
    const offeredNodeIds = offeredNodes.map((c) => c.ref);

    const userMsg: Message = {
      role: "user",
      content: [
        { type: "text", text: conversationContext },
        {
          type: "text",
          text:
            (scoutHits ? `${scoutHits}\n\n` : "") +
            `<node id="${nodeId}">\n${indexBlock}\n</node>`,
        },
      ],
    };

    const descendTool = buildDescendTool(offeredNodeIds);

    let response;
    try {
      response = await provider.sendMessage(
        [userMsg],
        [descendTool],
        systemPrompt,
        {
          config: {
            callSite: "memoryV3Descent" as const,
            tool_choice: { type: "tool" as const, name: DESCEND_TOOL_NAME },
          },
          ...(input.signal ? { signal: input.signal } : {}),
        },
      );
    } catch (err) {
      log.warn(
        { err, nodeId },
        "Descent provider call threw; descending nothing",
      );
      return failClosed(
        nodeId,
        "descent call failed — descended nothing",
        reasoningByNode,
      );
    }

    const toolBlock = extractToolUse(response);
    if (!toolBlock || toolBlock.name !== DESCEND_TOOL_NAME) {
      log.warn(
        { stopReason: response.stopReason, nodeId },
        "Descent model returned no choose_branches tool_use; descending nothing",
      );
      return failClosed(
        nodeId,
        "model returned no descend decision — descended nothing",
        reasoningByNode,
      );
    }

    const parsed = DescendToolResultSchema.safeParse(toolBlock.input);
    if (!parsed.success) {
      log.warn(
        { error: parsed.error.message, nodeId },
        "Descent tool input did not match schema; descending nothing",
      );
      return failClosed(
        nodeId,
        "descend decision failed validation — descended nothing",
        reasoningByNode,
      );
    }

    reasoningByNode.set(nodeId, parsed.data.reasoning ?? "");

    // Map the chosen bare ids back to the offered ChildRefs. The walk filters
    // bogus / unoffered refs anyway, but resolving against the offered set here
    // keeps the returned ChildRefs canonical.
    const offeredById = new Map(offeredNodes.map((c) => [c.ref, c]));
    const chosen: ChildRef[] = [];
    for (const id of parsed.data.descend) {
      const ref = offeredById.get(id);
      if (ref) chosen.push(ref);
    }
    return chosen;
  };
}

/**
 * Derive the seed *node* ids for the walk from the surviving scout *page* hits.
 *
 * Scouts surface concept-page slugs; the tree's `pageParents` reverse edges map
 * each page slug to the node(s) that list it as a child. Seeding the walk at
 * those parent nodes drops the model in near where the cheap lanes already
 * landed (layer 1 of scout seeding), while the walk still fans out from the
 * root and the descend pressure (layer 2) keeps it from collapsing onto the
 * scouts. Explicit `seeds` are unioned in. Order is deterministic: explicit
 * seeds first (in given order), then scout-derived parents in scout/slug order.
 */
export function deriveSeedNodes(
  tree: TreeIndex,
  scouts: readonly ScoutResult[],
  seeds: readonly string[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };
  for (const id of seeds) push(id);
  for (const scout of scouts) {
    for (const slug of scout.slugs) {
      const parents = tree.pageParents.get(slug);
      if (!parents) continue;
      for (const parent of parents) push(parent);
    }
  }
  return out;
}

/**
 * Drive a full scout-seeded tree walk for one retrieval pass.
 *
 * Wires {@link createDescender} into {@link walkTree} with `breadthBudget` /
 * `maxDepth` drawn from `config.memory.v3` (on `input.config`) and the start set
 * seeded by {@link deriveSeedNodes}. Returns the collected leaf pages and the
 * per-node `TreeLevel[]`, each level carrying the model's recorded reasoning.
 *
 * The descender records reasoning into a node-keyed side map; this function
 * adapts it into `walkTree`'s `DescendResult`-returning hook by pairing each
 * node's chosen children with its recorded reason, so the walk threads the
 * reasoning onto every emitted level.
 */
export async function runTreeWalk(args: RunTreeWalkArgs): Promise<WalkResult> {
  const { input, tree, scouts, seeds } = args;
  const v3 = input.config.memory?.v3;
  const breadthBudget = v3?.breadthBudget ?? 6;
  const maxDepth = v3?.maxDepth ?? 6;

  const reasoningByNode = new Map<string, string>();
  const descender = createDescender(args, reasoningByNode);

  const seedNodes = deriveSeedNodes(tree, scouts, seeds);

  return walkTree(tree, {
    seeds: seedNodes,
    breadthBudget,
    maxDepth,
    descend: async (nodeId, children) => {
      const descend = await descender(nodeId, [...children]);
      return { descend, reasoning: reasoningByNode.get(nodeId) ?? "" };
    },
  });
}
