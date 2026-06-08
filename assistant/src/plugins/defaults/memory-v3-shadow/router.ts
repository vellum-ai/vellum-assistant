/**
 * Memory v3 — L1 leaf router.
 *
 * One forced-tool LLM call per turn that picks which leaves of the topic tree
 * to open for the next reply. The design mirrors `../v2/router.ts`:
 *   - resolve the configured provider via `getConfiguredProvider`,
 *   - call `provider.sendMessage` with a forced `tool_choice`,
 *   - validate the tool input via Zod,
 *   - map numbered IDs back to leaf paths.
 *
 * Cache strategy. The numbered leaf block is the single largest input and is
 * STABLE across turns — it changes only when leaves are added/removed/edited.
 * We render it first in the user message and tag it with an ephemeral
 * `cache_control` breakpoint so the provider can serve it from the prompt
 * cache turn after turn. The trailing recent-context / current-message block
 * changes every turn, so it carries no breakpoint.
 *
 * Failure handling. A *model-call* failure is not the same as the model
 * choosing to open everything, so the two no longer share an outcome:
 *   - explicit `ids` → open exactly those leaves,
 *   - explicit empty array (`ids: []`) → open nothing (deliberate abstention),
 *   - omitted `ids` → open nothing: the router must name the leaves it wants,
 *     never the whole tree (~137 leaves would fan out a full L2 pass per turn),
 *   - infrastructure failure (provider unavailable, a throw that survived the
 *     provider's own retries, no usable `tool_use`, or a schema mismatch) →
 *     open nothing after a short re-prompt retry, degrading to the deterministic
 *     recall lanes (always-on core, the BM25 needle, the carry-forward working
 *     set) that the orchestrator unions in regardless.
 */

import { z } from "zod";

import {
  extractToolUse,
  getConfiguredProvider,
} from "../../../providers/provider-send-message.js";
import type { Message, ToolDefinition } from "../../../providers/types.js";
import { getLogger } from "../../../util/logger.js";
import { retryForResult } from "./llm-retry.js";
import { cachedTextBlock } from "./provider-blocks.js";
import type { LeafPath, LeafTree, MemoryRoutingTurn } from "./types.js";

const log = getLogger("memory-v3-router");

/** Tool name forced via `tool_choice`. Shared constant so tests can match it. */
const OPEN_LEAVES_TOOL_NAME = "open_leaves";

const OpenLeavesSchema = z.object({
  // Optional so the field can be absent on the wire, but an omitted `ids` opens
  // nothing — the router must name the leaves it wants, never the whole tree.
  ids: z.array(z.number().int()).optional(),
});

const OPEN_LEAVES_TOOL: ToolDefinition = {
  name: OPEN_LEAVES_TOOL_NAME,
  description:
    "Open the leaves whose contents could plausibly bear on the next reply. " +
    "Lean toward inclusion — a missed relevant leaf is a worse error than an " +
    "unused one. Pass the chosen IDs explicitly; return `[]` only when nothing " +
    "in the tree could possibly help.",
  input_schema: {
    type: "object",
    properties: {
      ids: {
        type: "array",
        items: { type: "integer" },
      },
    },
  },
};

const SYSTEM_PROMPT = `You route a conversation turn to the leaves of a topic tree that should be opened for the next reply.

Each leaf has a numbered ID, a path, and a description of what it holds. Decide which leaves to open by weighing four signals:

- Topic — entities, projects, and events named or implied by the turn.
- Register — the affect and mode of the message (e.g. playful, distressed, formal). A register signal is enough to open a leaf even when no entity is named.
- Recent context — the immediately preceding exchange, which resolves references like "this", "that", or "the same thing" to concrete topics.
- Situation — the current date and a live scratchpad of what is salient right now. A date or state cue can make a leaf relevant even when the message never names it (e.g. a person whose anniversary is today, an active thread).

Include on doubt: open every leaf that could plausibly hold something useful. Missing a relevant leaf is a worse error than opening an unused one. Call \`open_leaves\` with the chosen IDs explicitly; return \`[]\` only when nothing in the tree could possibly help.`;

/** Leaves sorted deterministically by path so the numbered block is stable. */
function sortedLeaves(tree: LeafTree): LeafPath[] {
  return [...tree.leaves.keys()].sort();
}

/**
 * Render the STATIC numbered leaf block from a pre-sorted path list. Identical
 * across turns for any given tree, which is what makes the prompt-cache
 * breakpoint pay off.
 */
function renderLeafBlockFromPaths(tree: LeafTree, paths: LeafPath[]): string {
  const lines = paths.map((path, i) => {
    const description = tree.leaves.get(path)?.description ?? "";
    // Collapse the (possibly multi-line) description to a single line so each
    // leaf is exactly one numbered entry.
    const oneLine = description.replace(/\s+/g, " ").trim();
    return `[${i + 1}] ${path} — ${oneLine}`;
  });
  return `<leaves>\n${lines.join("\n")}\n</leaves>`;
}

/**
 * Render the static numbered leaf block for a tree. Exported for the test that
 * locks the byte-identical cache invariant; `routeL1` renders from its already
 * sorted path list to avoid sorting twice.
 */
export function renderLeafBlock(tree: LeafTree): string {
  return renderLeafBlockFromPaths(tree, sortedLeaves(tree));
}

/**
 * Run the L1 router for one turn. Returns the leaf paths to open — only ever the
 * leaves the model names explicitly. An omitted `ids`, an explicit `[]`, or an
 * infrastructure failure (after a short re-prompt retry) all open nothing,
 * degrading to the deterministic recall lanes the orchestrator unions in.
 */
export async function routeL1(
  turn: MemoryRoutingTurn,
  tree: LeafTree,
): Promise<LeafPath[]> {
  const paths = sortedLeaves(tree);
  if (paths.length === 0) return [];

  const provider = await getConfiguredProvider("memoryV3RouteL1");
  if (!provider) {
    log.warn(
      "L1 router provider unavailable; degrading to deterministic lanes",
    );
    return [];
  }

  const userMsg: Message = {
    role: "user",
    content: [
      cachedTextBlock(renderLeafBlockFromPaths(tree, paths)),
      {
        type: "text",
        text:
          (turn.situationalContext
            ? `<situation>${turn.situationalContext}</situation>\n`
            : "") +
          `<recent_context>${turn.recentContext}</recent_context>\n` +
          `<current_message>${turn.currentMessage}</current_message>`,
      },
    ],
  };

  // One forced-tool call, retried a few times so a transient malformed response
  // (no usable tool_use, or tool input that fails the schema) re-prompts before
  // we give up. `null` from an attempt means "unusable, retry"; the provider
  // layer already backs off transient throws, so this loop adds no delay.
  const parsed = await retryForResult(async () => {
    const response = await provider.sendMessage([userMsg], {
      tools: [OPEN_LEAVES_TOOL],
      systemPrompt: SYSTEM_PROMPT,
      config: {
        callSite: "memoryV3RouteL1" as const,
        tool_choice: { type: "tool" as const, name: OPEN_LEAVES_TOOL_NAME },
      },
    });
    const toolBlock = extractToolUse(response);
    if (!toolBlock || toolBlock.name !== OPEN_LEAVES_TOOL_NAME) return null;
    const result = OpenLeavesSchema.safeParse(toolBlock.input);
    return result.success ? result.data : null;
  });

  if (parsed === null) {
    log.warn(
      "L1 router could not obtain a selection after retries; degrading to deterministic lanes",
    );
    return [];
  }

  // An omitted `ids` field means the model named no leaves — open nothing rather
  // than the whole tree. Only explicitly listed IDs open leaves.
  if (parsed.ids === undefined) return [];

  // Map 1-based IDs back to leaf paths, dropping out-of-range IDs without
  // throwing. De-duplicate while preserving model-returned order.
  const seen = new Set<number>();
  const selected: LeafPath[] = [];
  for (const id of parsed.ids) {
    if (id < 1 || id > paths.length || seen.has(id)) continue;
    seen.add(id);
    selected.push(paths[id - 1]);
  }
  return selected;
}
