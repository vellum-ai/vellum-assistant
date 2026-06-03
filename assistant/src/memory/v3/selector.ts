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
 * Failure handling. A deliberate "select everything" and a model-call failure
 * are different events with different outcomes:
 *   - explicit `ids` → select exactly those pages,
 *   - explicit empty `ids: []` → select nothing (deliberate abstention),
 *   - omitted `ids` → select ALL members of the leaf (the recall-safe "this
 *     whole leaf is relevant" signal, e.g. "give me all of X"); bounded to one
 *     leaf, so unlike the router this stays a select-all,
 *   - infrastructure failure (provider unavailable, a throw that survived the
 *     provider's own retries, no usable `tool_use`, or a schema mismatch) →
 *     select nothing after a short re-prompt retry, degrading to the
 *     deterministic recall lanes (core, needle, carry-forward working set) the
 *     orchestrator unions in regardless.
 */

import { z } from "zod";

import {
  extractToolUse,
  getConfiguredProvider,
} from "../../providers/provider-send-message.js";
import type { Message, ToolDefinition } from "../../providers/types.js";
import { getLogger } from "../../util/logger.js";
import { mapLimit } from "../../util/map-limit.js";
import { retryForResult } from "./llm-retry.js";
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
    "Select the pages in this leaf whose content the reply would directly " +
    "draw on. Be selective — prefer a few precisely-relevant pages over many " +
    "loosely-related ones; a leaf opened on a weak signal may yield none. " +
    "Pass `pinned_ids` for pages the conversation is centrally about. Omit " +
    "`ids` only as a recall-safe fallback when you cannot judge the leaf " +
    "(selects every page); return `[]` when pages are present but none are " +
    "directly relevant.",
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

const SYSTEM_PROMPT = `This leaf of the topic tree is potentially relevant to the conversation. Select ONLY the pages whose content the reply to THIS message would directly draw on.

Be selective: exclude pages that are merely topically adjacent, part of the ever-present background, or only loosely related. Most opened leaves should contribute a few precisely-relevant pages, not most of their contents — a leaf opened on a weak signal may yield none.

A page can also be directly relevant because of the current situation — the date or the live scratchpad — not only the message: keep a page the situation makes pertinent (e.g. a person whose anniversary is today).

If the conversation is centrally ABOUT a page (rather than only peripherally relevant to it), mark that page as pinned. Call \`select_pages\` with the chosen IDs. Omit \`ids\` only as a recall-safe fallback when you cannot judge the leaf (selects every page); return \`[]\` when the pages are present but none are directly relevant.`;

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
 * An omitted `ids` selects ALL members (the recall-safe "whole leaf is
 * relevant" signal); an explicit `[]` selects none; an infrastructure failure
 * (after a short re-prompt retry) selects none, degrading to the deterministic
 * recall lanes the orchestrator unions in.
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
    log.warn(
      { leaf },
      "L2 selector provider unavailable; degrading to deterministic lanes",
    );
    return [];
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
      tools: [SELECT_PAGES_TOOL],
      systemPrompt: SYSTEM_PROMPT,
      config: {
        callSite: "memoryV3SelectL2" as const,
        tool_choice: { type: "tool" as const, name: SELECT_PAGES_TOOL_NAME },
      },
    });
    const toolBlock = extractToolUse(response);
    if (!toolBlock || toolBlock.name !== SELECT_PAGES_TOOL_NAME) return null;
    const result = SelectPagesSchema.safeParse(toolBlock.input);
    return result.success ? result.data : null;
  });

  if (parsed === null) {
    log.warn(
      { leaf },
      "L2 selector could not obtain a selection after retries; degrading to deterministic lanes",
    );
    return [];
  }

  // Omitted `ids` is the recall-safe "this whole leaf is relevant" signal.
  // Bounded to one leaf, so it stays a select-all (unlike the L1 router).
  if (parsed.ids === undefined) return allMembers();

  const pinned = new Set(parsed.pinned_ids ?? []);

  // Map 1-based IDs back to member slugs, dropping out-of-range IDs without
  // throwing. De-duplicate while preserving model-returned order.
  const seen = new Set<number>();
  const selected: SelectedPage[] = [];
  for (const id of parsed.ids) {
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
