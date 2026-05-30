/**
 * Memory v3 — L2 per-leaf page selector.
 *
 * After the L1 router (`./router.ts`) decides which leaves to open, the L2
 * selector runs ONE forced-tool LLM call PER opened leaf to pick which pages
 * inside that leaf are relevant for the next reply. `selectAcrossLeaves` fans
 * the per-leaf calls out with bounded concurrency.
 *
 * Cache strategy. Each leaf's `<pages>` block — the numbered list of its member
 * pages with their full summaries — is STABLE for that leaf: it changes only
 * when pages are added/removed or a summary is rewritten, never per turn. We
 * render it FIRST in the per-leaf user message and tag it with an ephemeral
 * `cache_control` breakpoint so the provider serves it from the prompt cache
 * turn after turn. The trailing recent-context / current-message block changes
 * every turn and carries no breakpoint. This mirrors `./router.ts`.
 *
 * Recall-safe fallbacks. Like the router, the selector exists to widen recall,
 * so every failure degrades toward selecting MORE pages, never fewer:
 *   - omitted `ids` → select ALL members of the leaf,
 *   - missing/failed tool_use, provider unavailable, or any throw → ALL members.
 * Only an explicit empty `ids: []` returns nothing (deliberate abstention).
 */

import { z } from "zod";

import {
  extractToolUse,
  getConfiguredProvider,
} from "../../providers/provider-send-message.js";
import type { Message, ToolDefinition } from "../../providers/types.js";
import { getLogger } from "../../util/logger.js";
import { mapLimit } from "../../util/map-limit.js";
import { cachedTextBlock } from "./provider-blocks.js";
import { membersOf } from "./tree.js";
import type { LeafPath, LeafTree, Slug, TurnContext } from "./types.js";

const log = getLogger("memory-v3-selector");

/** A page selected from an opened leaf, with whether the turn centers on it. */
export interface SelectedPage {
  slug: Slug;
  pinned: boolean;
}

/** Tool name forced via `tool_choice`. Shared constant so tests can match it. */
const SELECT_PAGES_TOOL_NAME = "select_pages";

const SelectPagesSchema = z.object({
  // Optional: an omitted `ids` field is the recall-safe "select everything"
  // signal, distinct from an explicit empty array (deliberate abstention).
  ids: z.array(z.number().int()).optional(),
  pinned_ids: z.array(z.number().int()).optional(),
});

const SELECT_PAGES_TOOL: ToolDefinition = {
  name: SELECT_PAGES_TOOL_NAME,
  description:
    "Select the pages in this leaf whose content is relevant or useful for " +
    "the next reply. Lean toward inclusion — a missed relevant page is a " +
    "worse error than an unused one. Pass `pinned_ids` for pages the " +
    "conversation is centrally about. Omit `ids` entirely to select every " +
    "page; return `[]` only when none of the pages could possibly help.",
  input_schema: {
    type: "object",
    properties: {
      ids: {
        type: "array",
        items: { type: "integer" },
      },
      pinned_ids: {
        type: "array",
        items: { type: "integer" },
      },
    },
  },
};

const SYSTEM_PROMPT = `This leaf of the topic tree is potentially relevant to the conversation. Select the pages whose content is relevant or useful for responding.

Be inclusive — include frame and affect matches, not just literal-topic matches. A page that shares the conversation's mode or register can be as useful as one that names the same entity. Missing a relevant page is a worse error than selecting an unused one.

If the conversation is centrally ABOUT a page (rather than only peripherally relevant to it), mark that page as pinned. Call \`select_pages\` with the chosen IDs. Omit \`ids\` to select every page; return \`[]\` only when none of the pages could possibly help.`;

/**
 * Render the STATIC numbered `<pages>` block for a leaf from its member slugs.
 * Identical across turns for a given leaf, which is what makes the per-leaf
 * prompt-cache breakpoint pay off. Summaries are rendered in full (no
 * truncation) so the selector sees each page's complete description.
 */
async function renderPagesBlock(
  members: Slug[],
  pageSummary: (slug: Slug) => Promise<string>,
): Promise<string> {
  const lines = await Promise.all(
    members.map(async (slug, i) => {
      const summary = await pageSummary(slug);
      return `[${i + 1}] ${slug} — ${summary}`;
    }),
  );
  return `<pages>\n${lines.join("\n")}\n</pages>`;
}

/**
 * Run the L2 selector for a single opened leaf. Returns the pages to inject.
 *
 * Recall-safe: any failure to obtain an explicit selection returns ALL members
 * of the leaf. Only an explicit empty `ids` array returns no pages.
 */
export async function selectFromLeaf(
  leaf: LeafPath,
  turn: TurnContext,
  tree: LeafTree,
  pageSummary: (slug: Slug) => Promise<string>,
): Promise<SelectedPage[]> {
  const members = membersOf(tree, leaf);
  if (members.length === 0) return [];

  const allMembers = (): SelectedPage[] =>
    members.map((slug) => ({ slug, pinned: false }));

  const provider = await getConfiguredProvider("memoryV3SelectL2");
  if (!provider) {
    log.warn({ leaf }, "memoryV3SelectL2 provider unavailable; selecting all");
    return allMembers();
  }

  const userMsg: Message = {
    role: "user",
    content: [
      cachedTextBlock(
        `<leaf>${leaf}</leaf>\n` +
          (await renderPagesBlock(members, pageSummary)),
      ),
      {
        type: "text",
        text:
          `<recent_context>${turn.recentContext}</recent_context>\n` +
          `<current_message>${turn.currentMessage}</current_message>`,
      },
    ],
  };

  let response;
  try {
    response = await provider.sendMessage([userMsg], {
      tools: [SELECT_PAGES_TOOL],
      systemPrompt: SYSTEM_PROMPT,
      config: {
        callSite: "memoryV3SelectL2" as const,
        tool_choice: { type: "tool" as const, name: SELECT_PAGES_TOOL_NAME },
      },
    });
  } catch (err) {
    log.warn({ err, leaf }, "L2 selector call threw; selecting all");
    return allMembers();
  }

  const toolBlock = extractToolUse(response);
  if (!toolBlock || toolBlock.name !== SELECT_PAGES_TOOL_NAME) {
    log.warn(
      { stopReason: response.stopReason, leaf },
      "L2 selector returned no select_pages tool_use; selecting all",
    );
    return allMembers();
  }

  const parsed = SelectPagesSchema.safeParse(toolBlock.input);
  if (!parsed.success) {
    log.warn(
      { error: parsed.error.message, leaf },
      "L2 selector tool input did not match schema; selecting all",
    );
    return allMembers();
  }

  // Omitted `ids` is the recall-safe "select everything" signal.
  if (parsed.data.ids === undefined) return allMembers();

  const pinned = new Set(parsed.data.pinned_ids ?? []);

  // Map 1-based IDs back to member slugs, dropping out-of-range IDs without
  // throwing. De-duplicate while preserving model-returned order.
  const seen = new Set<number>();
  const selected: SelectedPage[] = [];
  for (const id of parsed.data.ids) {
    if (id < 1 || id > members.length || seen.has(id)) continue;
    seen.add(id);
    selected.push({ slug: members[id - 1]!, pinned: pinned.has(id) });
  }
  return selected;
}

/**
 * Run the L2 selector across every opened leaf with bounded concurrency and
 * flatten the per-leaf selections.
 *
 * A page assigned to more than one opened leaf may appear more than once in the
 * result; de-duplication across leaves is the orchestrator's job in a later PR.
 */
export async function selectAcrossLeaves(
  leaves: LeafPath[],
  turn: TurnContext,
  tree: LeafTree,
  pageSummary: (slug: Slug) => Promise<string>,
  concurrency = 4,
): Promise<SelectedPage[]> {
  const perLeaf = await mapLimit(leaves, concurrency, (leaf) =>
    selectFromLeaf(leaf, turn, tree, pageSummary),
  );
  return perLeaf.flat();
}
