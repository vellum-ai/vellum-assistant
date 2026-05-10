/**
 * Memory v2 — Sonnet router orchestration.
 *
 * Replaces the per-turn spreading-activation page selector with a single LLM
 * call. Given the rendered page index, the most recent user/assistant turn,
 * and the list of pages already injected on prior turns, the router returns a
 * small set of concept-page IDs to inject for the next reply.
 *
 * The design mirrors `sweep-job.ts`:
 *   - resolve the configured provider via `getConfiguredProvider`,
 *   - call `provider.sendMessage` with a forced `tool_choice`,
 *   - validate the tool input via Zod,
 *   - map back to slugs and let the caller drive injection.
 *
 * Cache strategy. Two ephemeral breakpoints carry the bulk of the routing
 * cost across turns:
 *   1. The last text block of the system prompt — the page index is the
 *      single largest input and changes only when concept pages are edited.
 *   2. The first user-message block (`<now>`) — stable across consecutive
 *      router calls within the same minute even though the trailing
 *      already-injected/last-turn block changes every turn.
 * The Anthropic provider also auto-applies a 1h breakpoint on the last text
 * block of a turn-starting user message, so the trailing uncached block does
 * not need an explicit `cache_control`.
 *
 * This module is pure orchestration — it does not mutate activation state,
 * write any files, or update the conversation. PR 10 wires it into
 * `injectMemoryV2Block`; until then nothing in the daemon calls it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import type { AssistantConfig } from "../../config/types.js";
import { getAssistantName } from "../../daemon/identity-helpers.js";
import {
  extractToolUse,
  getConfiguredProvider,
} from "../../providers/provider-send-message.js";
import type {
  ContentBlock,
  Message,
  ToolDefinition,
} from "../../providers/types.js";
import { getLogger } from "../../util/logger.js";
import { getPageIndex } from "./page-index.js";
import { renderRouterPrompt } from "./prompts/router.js";
import type { EverInjectedEntry } from "./types.js";

const log = getLogger("memory-v2-router");

/**
 * Reasons the router may fall short of returning a usable selection. The
 * caller (PR 10) maps each reason to a fallback path; the closed string-
 * literal union lets that dispatch stay exhaustive without a brittle
 * free-form string match.
 */
export type RouterFailureReason =
  | "no_provider"
  | "tool_use_missing"
  | "schema_mismatch"
  | "api_error"
  | "empty_index";

/**
 * Result of a single router call. `selectedSlugs` preserves the order the
 * model returned and is already capped at `config.memory.v2.router.max_page_ids`
 * with out-of-range IDs dropped. `rawIds` is the model-returned ID list before
 * mapping (post-truncation, post-range-filter) for diagnostics.
 */
export interface RouterResult {
  /** Selected page slugs in the order the model returned them. */
  selectedSlugs: string[];
  /** Numeric IDs the model returned (post-filter, post-truncate). */
  rawIds: number[];
  /** `null` on success; one of the failure reasons above otherwise. */
  failureReason: RouterFailureReason | null;
}

/** Tool name forced via `tool_choice`. Single shared constant so tests can match it. */
const ROUTER_TOOL_NAME = "select_pages_to_inject";

/**
 * Tool definition handed to the provider. The JSON schema is what the model
 * sees; the Zod schema below validates the response at runtime.
 *
 * `maxItems: 25` matches the schema-level upper bound on
 * `config.memory.v2.router.max_page_ids` so the model can't blow past the
 * runtime cap by emitting more IDs than the provider hard-limits accept.
 */
const ROUTER_TOOL: ToolDefinition = {
  name: ROUTER_TOOL_NAME,
  description:
    "Choose up to N concept page IDs to inject for the next reply. Return [] if nothing in the index is relevant — abstaining is encouraged when the turn is small-talk or already adequately covered by already_injected_ids.",
  input_schema: {
    type: "object",
    properties: {
      page_ids: {
        type: "array",
        items: { type: "integer" },
        maxItems: 25,
      },
    },
    required: ["page_ids"],
  },
};

const RouterResultSchema = z.object({
  page_ids: z.array(z.number().int()),
});

/** Empty-result helper so call sites don't reconstruct the shape inline. */
function emptyResult(reason: RouterFailureReason | null): RouterResult {
  return { selectedSlugs: [], rawIds: [], failureReason: reason };
}

interface RunRouterParams {
  workspaceDir: string;
  userMessage: string;
  assistantMessage: string;
  /** Verbatim contents to inject into `<now>...</now>` on this turn. */
  nowText: string;
  /** Slugs already injected on prior turns (used to seed `<already_injected_ids>`). */
  priorEverInjected: readonly EverInjectedEntry[];
  config: AssistantConfig;
  signal?: AbortSignal;
}

/**
 * Run the router for one turn. The implementation steps (mirroring
 * `sweep-job.ts` end-to-end):
 *
 *   1. Build the page index. If the workspace has no concept pages and no
 *      seeded skill entries, abstain immediately with `empty_index`.
 *   2. Resolve the configured provider for the `memoryRouter` call site.
 *      Missing → `no_provider` so the caller can fall back to spreading
 *      activation or an empty injection.
 *   3. Build system + user prompts. The system prompt is the rendered
 *      router template with the page index inlined and gets one ephemeral
 *      breakpoint at the end (the page-index block). The user message is
 *      *two* text blocks: the cached `<now>` block and the uncached
 *      already-injected/last-turn block.
 *   4. Force `tool_choice` so the model can only emit `select_pages_to_inject`.
 *   5. Parse the tool input via Zod. Anything off-shape collapses to
 *      `schema_mismatch`.
 *   6. Map IDs to slugs through the page index, dropping IDs outside
 *      `[1, N]` and truncating at `max_page_ids`.
 *
 * Any uncaught throw inside the call (network, provider SDK error, abort)
 * collapses to `api_error` and is logged at warn so callers can keep going
 * without crashing the daemon. `AbortSignal.aborted` errors are *not*
 * special-cased; they propagate as `api_error` because the caller treats
 * "router didn't finish" the same regardless of cause.
 */
export async function runRouter(
  params: RunRouterParams,
): Promise<RouterResult> {
  const {
    workspaceDir,
    userMessage,
    assistantMessage,
    nowText,
    priorEverInjected,
    config,
    signal,
  } = params;

  const pageIndex = await getPageIndex(workspaceDir);
  if (pageIndex.entries.length === 0) {
    return emptyResult("empty_index");
  }

  const provider = await getConfiguredProvider("memoryRouter");
  if (!provider) {
    log.warn("memoryRouter provider unavailable; router skipped");
    return emptyResult("no_provider");
  }

  const systemPrompt = renderRouterPrompt({
    assistantName: getAssistantName(),
    userName: resolveUserName(workspaceDir),
    pageIndexBlock: pageIndex.rendered,
  });

  // Already-injected slugs that map back to a current index ID. Slugs whose
  // page has been deleted since the prior turn drop out silently — the model
  // only sees IDs that still resolve.
  const priorIds: number[] = [];
  for (const entry of priorEverInjected) {
    const idx = pageIndex.bySlug.get(entry.slug);
    if (idx) priorIds.push(idx.id);
  }

  // Cache breakpoint 2 — `<now>` is stable for the duration of a minute, so
  // the bulk of the user message rides the cache when the assistant chains
  // tool calls. The trailing block has no `cache_control`; the Anthropic
  // provider auto-applies a 1h breakpoint on the last text block of a
  // turn-starting user message, which covers it.
  const userMsg: Message = {
    role: "user",
    content: [
      cachedTextBlock(`<now>\n${nowText}\n</now>`),
      {
        type: "text",
        text:
          `<already_injected_ids>\n${priorIds.join(", ")}\n</already_injected_ids>\n\n` +
          `<last_turn>\n[user]: ${userMessage}\n[assistant]: ${assistantMessage}\n</last_turn>`,
      },
    ],
  };

  let response;
  try {
    response = await provider.sendMessage(
      [userMsg],
      [ROUTER_TOOL],
      systemPrompt,
      {
        config: {
          callSite: "memoryRouter" as const,
          tool_choice: { type: "tool" as const, name: ROUTER_TOOL_NAME },
        },
        ...(signal ? { signal } : {}),
      },
    );
  } catch (err) {
    log.warn({ err }, "Router provider call threw; treating as api_error");
    return emptyResult("api_error");
  }

  const toolBlock = extractToolUse(response);
  if (!toolBlock || toolBlock.name !== ROUTER_TOOL_NAME) {
    log.warn(
      { stopReason: response.stopReason },
      "Router model returned no select_pages_to_inject tool_use block",
    );
    return emptyResult("tool_use_missing");
  }

  const parsed = RouterResultSchema.safeParse(toolBlock.input);
  if (!parsed.success) {
    log.warn(
      { error: parsed.error.message },
      "Router tool input did not match schema",
    );
    return emptyResult("schema_mismatch");
  }

  const N = pageIndex.entries.length;
  const max = config.memory?.v2?.router?.max_page_ids ?? 25;

  const inRangeIds: number[] = [];
  const droppedIds: number[] = [];
  for (const id of parsed.data.page_ids) {
    if (id >= 1 && id <= N) {
      inRangeIds.push(id);
    } else {
      droppedIds.push(id);
    }
  }
  if (droppedIds.length > 0) {
    log.warn(
      { droppedIds, indexSize: N },
      "Router returned page IDs outside the valid range; dropping",
    );
  }

  const truncated = inRangeIds.length > max;
  const finalIds = truncated ? inRangeIds.slice(0, max) : inRangeIds;
  if (truncated) {
    log.warn(
      { returned: inRangeIds.length, max },
      "Router returned more page IDs than max_page_ids; truncating",
    );
  }

  // De-duplicate while preserving order — the index lookup alone wouldn't
  // catch repeats from the model.
  const seen = new Set<number>();
  const selectedSlugs: string[] = [];
  const rawIds: number[] = [];
  for (const id of finalIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const entry = pageIndex.byId.get(id);
    if (!entry) continue;
    rawIds.push(id);
    selectedSlugs.push(entry.slug);
  }

  return { selectedSlugs, rawIds, failureReason: null };
}

/**
 * Build a text content block carrying an ephemeral `cache_control`
 * breakpoint. The Anthropic SDK accepts the field as an extra property on
 * text blocks, but our internal `TextContent` type intentionally omits it
 * (only the Anthropic provider transforms it onto the wire), so we reach
 * through a `Record` cast here for the same reason `client.ts` does — it
 * keeps the core types provider-agnostic.
 */
function cachedTextBlock(text: string): ContentBlock {
  const block: ContentBlock = { type: "text", text };
  (block as unknown as Record<string, unknown>).cache_control = {
    type: "ephemeral",
  };
  return block;
}

/**
 * Read the guardian's display name from `users/default.md`. Mirrors
 * `sweep-job.ts`'s `resolveUserName` so the two background jobs agree on
 * which file they read and what label they fall back to.
 */
function resolveUserName(workspaceDir: string): string | null {
  try {
    const content = readFileSync(
      join(workspaceDir, "users", "default.md"),
      "utf-8",
    );
    const match = content.match(/\*\*Name:\*\*\s*(.+)/);
    return match?.[1]?.trim() || null;
  } catch {
    return null;
  }
}
