/**
 * Memory v3 — single pool selector.
 *
 * Where the per-leaf L2 selector (`./selector.ts`) runs ONE forced-tool call per
 * opened leaf over that leaf's static `<pages>` block, the pool selector runs a
 * SINGLE forced-tool call over one unified candidate pool. Each candidate is a
 * page slug paired with a per-candidate `descriptor` the caller supplies — the
 * matched section text for a needle/dense hit, or a curated link description for
 * an edge page. The caller assembles the pool by unioning the section lanes; the
 * pool selector only decides which of those candidates the reply will draw on.
 *
 * No cache breakpoint. Unlike the per-leaf selector, whose `<pages>` block is
 * stable for a given leaf turn-after-turn (and so carries a `cache_control`
 * breakpoint), the pool is recomputed from per-turn section matches and is
 * therefore dynamic per turn. Caching a prefix that changes every turn would
 * never hit; carry-forward (the working set unioned in by the orchestrator) is
 * the cache mechanism here, not a static prefix breakpoint.
 *
 * Failure handling mirrors the per-leaf selector EXACTLY:
 *   - explicit `ids` → select exactly those candidates,
 *   - explicit empty `ids: []` → select none (deliberate abstention),
 *   - omitted `ids` → keep ALL candidates (the recall-safe "all of these are
 *     relevant" signal),
 *   - infrastructure failure (provider unavailable, a throw that survived the
 *     provider's own retries, no usable `tool_use`, or a schema mismatch) →
 *     select nothing after a short re-prompt retry, degrading to the
 *     deterministic recall lanes the orchestrator unions in regardless.
 */

import { z } from "zod";

import {
  extractToolUse,
  getConfiguredProvider,
} from "../../../providers/provider-send-message.js";
import type { Message, ToolDefinition } from "../../../providers/types.js";
import { getLogger } from "../../../util/logger.js";
import { truncate } from "../../../util/truncate.js";
import { retryForResult } from "./llm-retry.js";
import type { MemoryRoutingTurn, SelectedPage, Slug } from "./types.js";

const log = getLogger("memory-v3-pool-select");

/** A candidate page in the unified pool, with the descriptor that justifies it. */
export interface PoolCandidate {
  slug: Slug;
  /**
   * The text that justifies this candidate: a matched section for a
   * needle/dense hit, or a curated link description for an edge page. Rendered
   * (truncated) in the numbered candidate list the selector judges against.
   */
  descriptor: string;
}

/** Tool name forced via `tool_choice`. Shared constant so tests can match it. */
const SELECT_PAGES_TOOL_NAME = "select_pages";

/** Descriptors are truncated to keep the candidate list compact. */
const DESCRIPTOR_MAX_CHARS = 400;

const SelectPagesSchema = z.object({
  // Optional: an omitted `ids` field is the recall-safe "keep everything"
  // signal, distinct from an explicit empty array (deliberate abstention).
  ids: z.array(z.number().int()).optional(),
  pinned_ids: z.array(z.number().int()).optional(),
});

const SELECT_PAGES_TOOL: ToolDefinition = {
  name: SELECT_PAGES_TOOL_NAME,
  description:
    "Select the candidate pages whose content the reply would directly draw " +
    "on. Lean inclusive — when in doubt, keep a candidate; for a list or " +
    '"all of X" request keep every candidate that belongs. Pass `pinned_ids` ' +
    "for pages the conversation is centrally about. Omit `ids` only as a " +
    "recall-safe fallback when you cannot judge the pool (keeps every " +
    "candidate); return `[]` when candidates are present but none are " +
    "relevant.",
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

const SYSTEM_PROMPT = `You are given a pool of candidate memory pages, each surfaced because some part of it matched the conversation. Select every page whose specific content the reply to THIS message would directly draw on.

Lean inclusive: recall matters more than precision here, so when a candidate could plausibly inform the reply, keep it. For a list or an "all of X" request, keep EVERY candidate that belongs to X rather than guessing a representative subset.

A page can be relevant because of the current situation — the date or the live scratchpad — not only the message: keep a page the situation makes pertinent (e.g. a person whose anniversary is today).

If the conversation is centrally ABOUT a page (rather than only peripherally relevant to it), mark that page as pinned. Call \`select_pages\` with the chosen IDs. Omit \`ids\` only as a recall-safe fallback when you cannot judge the pool (keeps every candidate); return \`[]\` when candidates are present but none are relevant.`;

/** Collapse a descriptor to one line and cap its length for the candidate list. */
function renderDescriptor(descriptor: string): string {
  return truncate(descriptor.replace(/\s+/g, " ").trim(), DESCRIPTOR_MAX_CHARS);
}

/**
 * Render the numbered candidate list: one `[i] slug — descriptor` line per
 * candidate, descriptors collapsed to one line and length-capped. The pool is
 * dynamic per turn, so this block is NOT cached (see the module doc).
 */
function renderCandidateList(pool: PoolCandidate[]): string {
  const lines = pool.map(
    (c, i) => `[${i + 1}] ${c.slug} — ${renderDescriptor(c.descriptor)}`,
  );
  return `<candidates>\n${lines.join("\n")}\n</candidates>`;
}

/**
 * Run the single forced-tool selector over the unified candidate pool. Returns
 * the pages to inject.
 *
 * An omitted `ids` keeps ALL candidates (the recall-safe "all of these are
 * relevant" signal); an explicit `[]` keeps none; an infrastructure failure
 * (after a short re-prompt retry) keeps none, degrading to the deterministic
 * recall lanes the orchestrator unions in.
 */
export async function selectPool(
  pool: PoolCandidate[],
  turn: MemoryRoutingTurn,
): Promise<SelectedPage[]> {
  if (pool.length === 0) return [];

  const keepAll = (): SelectedPage[] =>
    pool.map((c) => ({ slug: c.slug, pinned: false }));

  const provider = await getConfiguredProvider("memoryV3SelectL2");
  if (!provider) {
    log.warn(
      { candidateCount: pool.length },
      "pool selector provider unavailable; degrading to deterministic lanes",
    );
    return [];
  }

  // The pool is dynamic per turn, so — unlike the per-leaf selector — there is
  // no static cache breakpoint here; carry-forward is the cache mechanism. The
  // candidate list and the per-turn context go in a single plain text block.
  const userMsg: Message = {
    role: "user",
    content: [
      {
        type: "text",
        text:
          `${renderCandidateList(pool)}\n` +
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
      { candidateCount: pool.length },
      "pool selector could not obtain a selection after retries; degrading to deterministic lanes",
    );
    return [];
  }

  // Omitted `ids` is the recall-safe "keep all candidates" signal.
  if (parsed.ids === undefined) return keepAll();

  const pinned = new Set(parsed.pinned_ids ?? []);

  // Map 1-based IDs back to candidate slugs, dropping out-of-range IDs without
  // throwing. De-duplicate while preserving model-returned order.
  const seen = new Set<number>();
  const selected: SelectedPage[] = [];
  for (const id of parsed.ids) {
    if (id < 1 || id > pool.length || seen.has(id)) continue;
    seen.add(id);
    selected.push({ slug: pool[id - 1]!.slug, pinned: pinned.has(id) });
  }
  return selected;
}
