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
 * asks two things: which child *nodes* to descend into, and which leaf *pages*
 * offered at this node to keep for the answer. Selecting pages at every level is
 * what makes the walk a curated retrieval rather than a bulk dump: only pages
 * the model keeps reach the candidate set.
 *
 * The walk descends from `tree.root` only — it is not seeded mid-tree. Scout
 * hits steer it solely as **descend pressure**: the surviving scout slugs are
 * rendered into every descend prompt so the model prefers (but is not forced
 * onto) branches that contain them. The scout-surfaced pages themselves already
 * reach the gate directly via the loop, so the walk's job is to find the
 * relevant pages the scouts missed and to keep only what bears on the turn.
 *
 * The decision returned per node — `{ descend, keep, reasoning }` — is handed
 * straight to `walkTree`, so every emitted `TreeLevel` carries the model's
 * reason for its descend/skip split, making a wrong high-level skip observable
 * rather than silent.
 *
 * Fail-safe. When no provider is configured (or a per-node call errors / returns
 * an unusable response) the descender descends *nothing* and keeps *nothing* for
 * that node, recording the reason. The walk still terminates; it just stops
 * exploring and collecting from the affected node. Failing closed keeps a broken
 * provider from blowing the breadth budget, and the scout hits already in the
 * candidate set keep the turn from going memory-blind.
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
import type { LlmCallSink } from "./llm-capture.js";
import { renderConversationContext } from "./prompt-context.js";
import {
  DESCENT_SYSTEM_PROMPT,
  resolveV3SystemPrompt,
} from "./prompts/system-prompts.js";
import type {
  DescendDecision,
  DescendResult,
  WalkResult,
} from "./traversal.js";
import { walkTree } from "./traversal.js";
import type { ChildRef, TreeIndex } from "./tree-index.js";

const log = getLogger("memory-v3-tree-walk");

/** Tool name forced via `tool_choice`. Shared constant so tests can match it. */
const DESCEND_TOOL_NAME = "choose_branches";

/** Arguments to {@link createDescender}. */
export interface CreateDescenderArgs {
  input: RetrievalInput;
  tree: TreeIndex;
  pages: PageIndex;
  /** Surviving scout hits — rendered into the prompt as descend pressure. */
  scouts: ScoutResult[];
  /** Optional debug sink — emits one record per descender LLM call (per node). */
  capture?: LlmCallSink;
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
 * chose to recurse into; `keep_pages` lists the leaf page slugs it chose to keep
 * for the answer; `reasoning` is its stated rationale. Mirrors v2's
 * `select_pages_to_inject` forced-tool shape.
 */
const DescendToolResultSchema = z.object({
  descend: z.array(z.string()),
  keep_pages: z.array(z.string()).optional(),
  reasoning: z.string().optional(),
});

/**
 * Build the forced tool definition for one node. `descend` is constrained to the
 * offered `node:` child ids and `keep_pages` to the offered `page:` child slugs,
 * so the model can only pick from genuine children (the walk filters anyway, but
 * constraining the schema keeps the model honest and the trace clean).
 */
function buildDescendTool(
  offeredNodeIds: readonly string[],
  offeredPageSlugs: readonly string[],
): ToolDefinition {
  return {
    name: DESCEND_TOOL_NAME,
    description:
      "At the current memory-tree node, decide two things for the current " +
      "turn: which child NODES to descend into to find more relevant pages, " +
      "and which leaf PAGES offered here to keep for the answer. Prefer " +
      "branches and pages likely to bear on the turn; lean toward keeping a " +
      "plausibly-relevant page over dropping it — missing a relevant page or " +
      "subtree is worse than including an extra one. Return empty lists only " +
      "when nothing here plausibly bears on the turn.",
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
            "Bare ids of the child NODES to descend into. Choose only from " +
            "the offered node children.",
        },
        keep_pages: {
          type: "array",
          items:
            offeredPageSlugs.length > 0
              ? { type: "string", enum: [...offeredPageSlugs] }
              : { type: "string" },
          description:
            "Slugs of the leaf PAGES offered at this node to keep for the " +
            "answer. Choose only from the offered page children.",
        },
        reasoning: {
          type: "string",
          description:
            "One short sentence: why these branches and pages were chosen " +
            "and the rest skipped.",
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

/** Fail-safe decision: descend nothing and keep nothing, recording why. */
function failClosed(reasoning: string): DescendResult {
  return { descend: [], keep: [], reasoning };
}

/**
 * Resolve the bare ids/slugs the model returned back to the `ChildRef`s the node
 * actually offered, dropping anything not offered. The walk filters again, but
 * resolving here keeps the returned refs canonical.
 */
function resolveOffered(
  refs: readonly string[],
  offered: Map<string, ChildRef>,
): ChildRef[] {
  const out: ChildRef[] = [];
  for (const ref of refs) {
    const child = offered.get(ref);
    if (child) out.push(child);
  }
  return out;
}

/**
 * Create the per-node decision driving {@link walkTree}.
 *
 * The returned {@link DescendDecision} makes one forced-tool `memoryV3Descent`
 * call per node that has any children, over its composed index, and returns the
 * `node:` children to descend plus the `page:` children to keep — with the
 * model's reasoning inline. A node with no children at all skips the call.
 *
 * Provider resolution honors the `provider` arg (including explicit `null` for
 * the fail-safe path) and otherwise resolves the configured call site once per
 * call. Any failure — no provider, provider throw, missing/mismatched tool_use
 * — fails closed (descend and keep nothing) with the reason recorded.
 */
export function createDescender(args: CreateDescenderArgs): DescendDecision {
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

  return async (
    nodeId: string,
    children: ReadonlyArray<ChildRef>,
  ): Promise<DescendResult> => {
    const offeredNodes = children.filter((c) => c.kind === "node");
    const offeredPages = children.filter((c) => c.kind === "page");
    // No children at all — nothing to ask the model.
    if (offeredNodes.length === 0 && offeredPages.length === 0) {
      return { descend: [], keep: [], reasoning: "" };
    }

    const provider =
      args.provider !== undefined
        ? args.provider
        : await getConfiguredProvider("memoryV3Descent");
    if (!provider) {
      log.warn(
        { nodeId },
        "memoryV3Descent provider unavailable; descending and keeping nothing",
      );
      return failClosed("no provider configured — descended and kept nothing");
    }

    const indexBlock = composeNodeIndex(nodeId, tree, pages);
    const offeredNodeIds = offeredNodes.map((c) => c.ref);
    const offeredPageSlugs = offeredPages.map((c) => c.ref);

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

    const descendTool = buildDescendTool(offeredNodeIds, offeredPageSlugs);

    const startedAt = Date.now();
    let response;
    try {
      response = await provider.sendMessage([userMsg], {
        tools: [descendTool],
        systemPrompt,
        config: {
          callSite: "memoryV3Descent" as const,
          tool_choice: { type: "tool" as const, name: DESCEND_TOOL_NAME },
        },
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch (err) {
      log.warn(
        { err, nodeId },
        "Descent provider call threw; descending and keeping nothing",
      );
      return failClosed("descent call failed — descended and kept nothing");
    }

    args.capture?.({
      lane: "descent",
      callSite: "memoryV3Descent",
      node: nodeId,
      request: { systemPrompt, messages: [userMsg], tools: [descendTool] },
      response,
      ms: Date.now() - startedAt,
    });

    const toolBlock = extractToolUse(response);
    if (!toolBlock || toolBlock.name !== DESCEND_TOOL_NAME) {
      log.warn(
        { stopReason: response.stopReason, nodeId },
        "Descent model returned no choose_branches tool_use; descending and keeping nothing",
      );
      return failClosed(
        "model returned no descend decision — descended and kept nothing",
      );
    }

    const parsed = DescendToolResultSchema.safeParse(toolBlock.input);
    if (!parsed.success) {
      log.warn(
        { error: parsed.error.message, nodeId },
        "Descent tool input did not match schema; descending and keeping nothing",
      );
      return failClosed(
        "descend decision failed validation — descended and kept nothing",
      );
    }

    const descend = resolveOffered(
      parsed.data.descend,
      new Map(offeredNodes.map((c) => [c.ref, c])),
    );
    // Recall-safe fallback: an *omitted* `keep_pages` means the model gave no
    // instruction at this node, so keep every offered page — dropping all pages
    // a node presented on a silent omission is the worse failure. An *explicit*
    // `[]` is the model genuinely keeping nothing here and is honored as-is.
    const keepSlugs = parsed.data.keep_pages ?? offeredPageSlugs;
    const keep = resolveOffered(
      keepSlugs,
      new Map(offeredPages.map((c) => [c.ref, c])),
    );
    return { descend, keep, reasoning: parsed.data.reasoning ?? "" };
  };
}

/**
 * Drive a full tree walk for one retrieval pass.
 *
 * Wires {@link createDescender} into {@link walkTree} with `breadthBudget` /
 * `maxDepth` drawn from `config.memory.v3` (on `input.config`). The walk starts
 * at `tree.root` only — scout hits steer it as descend pressure in the prompt,
 * not as mid-tree start points. Returns the kept leaf pages and the per-node
 * `TreeLevel[]`, each level carrying the model's recorded reasoning.
 */
export async function runTreeWalk(args: RunTreeWalkArgs): Promise<WalkResult> {
  const { input, tree } = args;
  const v3 = input.config.memory?.v3;
  const breadthBudget = v3?.breadthBudget ?? 6;
  const maxDepth = v3?.maxDepth ?? 6;

  return walkTree(tree, {
    breadthBudget,
    maxDepth,
    descend: createDescender(args),
  });
}
