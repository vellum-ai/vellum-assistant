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
 * Cache strategy. Two 1h ephemeral breakpoints carry the bulk of the
 * routing cost across turns:
 *   1. The last text block of the system prompt — the page index is the
 *      single largest input and changes only when concept pages are edited.
 *      Auto-applied by the Anthropic provider at the configured 1h TTL.
 *   2. The first user-message block (`<now>`) — stable across most turns
 *      since NOW.md only changes when the model rewrites it. We set the 1h
 *      TTL explicitly here to match the provider-side breakpoints; the
 *      default 5m would force unnecessary cache re-creation.
 * The Anthropic provider also auto-applies a 1h breakpoint on the last text
 * block of a turn-starting user message, so the trailing uncached block does
 * not need an explicit `cache_control`.
 *
 * This module is pure orchestration — it does not mutate activation state,
 * write any files, or update the conversation. PR 10 wires it into
 * `injectMemoryV2Block`; until then nothing in the daemon calls it.
 */

import { z } from "zod";

import type { AssistantConfig } from "../../config/types.js";
import {
  getAssistantName,
  resolveUserName,
} from "../../daemon/identity-helpers.js";
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
import { resolveRouterPrompt } from "./prompts/router.js";
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
 * with out-of-range IDs dropped.
 */
export interface RouterResult {
  /** Selected page slugs in the order the model returned them. */
  selectedSlugs: string[];
  /** `null` on success; one of the failure reasons above otherwise. */
  failureReason: RouterFailureReason | null;
}

/** Tool name forced via `tool_choice`. Single shared constant so tests can match it. */
const ROUTER_TOOL_NAME = "select_pages_to_inject";

/**
 * Build the tool definition handed to the provider. The JSON schema is what
 * the model sees; the Zod schema below validates the response at runtime.
 *
 * `maxItems` mirrors the runtime `config.memory.v2.router.max_page_ids` cap
 * so the model is told the same upper bound the post-call truncation
 * enforces. Built per-call rather than module-scoped because the cap is
 * configurable per workspace.
 */
function buildRouterTool(maxPageIds: number): ToolDefinition {
  return {
    name: ROUTER_TOOL_NAME,
    description: `Choose up to ${maxPageIds} concept page IDs to inject for the next reply. Lean toward inclusion when in doubt — missing a relevant page is a worse error than surfacing unused ones. Return [] only when nothing in the index plausibly bears on the turn.`,
    input_schema: {
      type: "object",
      properties: {
        page_ids: {
          type: "array",
          items: { type: "integer" },
          maxItems: maxPageIds,
        },
      },
      required: ["page_ids"],
    },
  };
}

const RouterResultSchema = z.object({
  page_ids: z.array(z.number().int()),
});

/** Empty-result helper so call sites don't reconstruct the shape inline. */
function emptyResult(reason: RouterFailureReason | null): RouterResult {
  return { selectedSlugs: [], failureReason: reason };
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

  const systemPrompt = resolveRouterPrompt(
    config.memory?.v2?.router?.router_prompt_path ?? null,
    {
      assistantName: getAssistantName(),
      userName: resolveUserName(workspaceDir),
      pageIndexBlock: pageIndex.rendered,
    },
  );

  // Already-injected slugs that map back to a current index ID. Slugs whose
  // page has been deleted since the prior turn drop out silently — the model
  // only sees IDs that still resolve.
  const priorIds: number[] = [];
  for (const entry of priorEverInjected) {
    const idx = pageIndex.bySlug.get(entry.slug);
    if (idx) priorIds.push(idx.id);
  }

  // Cache breakpoint 2 — `<now>` is stable across most turns (NOW.md only
  // changes when the model rewrites it), so the bulk of the user message
  // rides the cache. We use a 1h TTL to match the system-prompt breakpoint
  // and the provider's auto-applied breakpoints. The trailing block has no
  // `cache_control`; the Anthropic provider auto-applies a 1h breakpoint on
  // the last text block of a turn-starting user message, which covers it.
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

  const maxPageIds = config.memory?.v2?.router?.max_page_ids ?? 25;
  const routerTool = buildRouterTool(maxPageIds);

  let response;
  try {
    response = await provider.sendMessage(
      [userMsg],
      [routerTool],
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

  const truncated = inRangeIds.length > maxPageIds;
  const finalIds = truncated ? inRangeIds.slice(0, maxPageIds) : inRangeIds;
  if (truncated) {
    log.warn(
      { returned: inRangeIds.length, max: maxPageIds },
      "Router returned more page IDs than max_page_ids; truncating",
    );
  }

  // De-duplicate while preserving order — the index lookup alone wouldn't
  // catch repeats from the model.
  const seen = new Set<number>();
  const selectedSlugs: string[] = [];
  for (const id of finalIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const entry = pageIndex.byId.get(id);
    if (!entry) continue;
    selectedSlugs.push(entry.slug);
  }

  return { selectedSlugs, failureReason: null };
}

/**
 * Build a text content block carrying an ephemeral `cache_control`
 * breakpoint with a 1h TTL. The Anthropic SDK accepts the field as an extra
 * property on text blocks, but our internal `TextContent` type intentionally
 * omits it (only the Anthropic provider transforms it onto the wire), so we
 * reach through a `Record` cast here for the same reason `client.ts` does —
 * it keeps the core types provider-agnostic. The 1h TTL matches the
 * provider's auto-applied breakpoints (see `cacheTtl` in
 * `providers/anthropic/client.ts`); the `<now>` block is stable across most
 * turns, so default 5m would force unnecessary re-creation. The
 * `extended-cache-ttl-2025-04-11` beta header is added unconditionally for
 * non-Haiku models in `client.ts`, so this works without any call-site
 * config.
 */
function cachedTextBlock(text: string): ContentBlock {
  const block: ContentBlock = { type: "text", text };
  (block as unknown as Record<string, unknown>).cache_control = {
    type: "ephemeral",
    ttl: "1h",
  };
  return block;
}
