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
 * The trailing user-message block holds `<last_turn>` content that changes
 * every call (new user turn + new prior assistant reply), so we pass
 * `disableTurnStartCache: true` to the provider to suppress its auto-applied
 * 1h breakpoint there — caching it would create unused cache entries (pure
 * cache_creation cost with no future hit).
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
import type { DrizzleDb } from "../db-connection.js";
import { computeInjectionScores } from "./injection-events.js";
import type { PageIndex } from "./page-index.js";
import {
  getPageIndex,
  partitionPageIndex,
  splitTier1,
  splitTier2,
} from "./page-index.js";
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
 * Tags which batch a router-selected slug came from. Tier 3 carries the
 * batch index so the inspector can distinguish e.g. `tier3:0` from
 * `tier3:3` — useful for debugging hash bucketing and batch-quality
 * regressions per tier 3 bucket.
 */
export type RouterSource = "tier1" | "tier2" | `tier3:${number}`;

/**
 * Result of a single router call. `selectedSlugs` preserves the order the
 * model returned and is already capped at `config.memory.v2.router.max_page_ids`
 * with out-of-range IDs dropped. `sourceBySlug` attributes each selection
 * to the batch it came from for inspector display.
 */
export interface RouterResult {
  /** Selected page slugs in the order the model returned them. */
  selectedSlugs: string[];
  /**
   * Per-slug provenance covering every entry in `selectedSlugs`. Empty when
   * `failureReason !== null` or no batch returned any selections.
   */
  sourceBySlug: ReadonlyMap<string, RouterSource>;
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

/**
 * Per-batch internal result. The orchestrator stamps provenance during the
 * union so individual batches never need to know their own tier tag.
 */
interface RouterBatchResult {
  selectedSlugs: string[];
  failureReason: RouterFailureReason | null;
}

/** Empty orchestrator result. */
function emptyResult(reason: RouterFailureReason | null): RouterResult {
  return { selectedSlugs: [], sourceBySlug: new Map(), failureReason: reason };
}

/** Empty batch result — slimmer shape; orchestrator builds provenance. */
function emptyBatchResult(
  reason: RouterFailureReason | null,
): RouterBatchResult {
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
  /**
   * Database handle for reading EMA scores when `tier2_size` is set. When
   * absent, tier 2 is silently skipped (pages flow tier 1 → tier 3). The
   * production caller (`injectViaRouter`) always passes it; tests that
   * only exercise tier 1 / tier 3 paths can omit it.
   */
  database?: DrizzleDb;
  /**
   * Per-call profile override forwarded to `getConfiguredProvider`. When
   * set, the `memoryRouter` call site resolves against this profile name
   * instead of the workspace active profile. The simulator route uses
   * this to compare different profiles against the same query; live
   * router callers leave it unset.
   */
  overrideProfile?: string;
  /**
   * Skip the post-union truncation to `max_page_ids`. Used by the
   * simulator so the playground can show the full untruncated router
   * output across all batches. Live callers (`injectViaRouter`) leave
   * this unset so the bounded-injection contract holds.
   */
  disableUnionCap?: boolean;
  /**
   * Per-call inline router system-prompt override. Takes precedence
   * over `memory.v2.router.router_prompt_path` and the bundled body.
   * Used by the simulator playground for ad-hoc prompt comparisons.
   * Live callers leave this unset.
   */
  routerPromptOverride?: string;
}

/**
 * Run the router for one turn.
 *
 * Top-level orchestration. When `config.memory.v2.router.batch_size` is
 * `null` (default), the entire page index is sent in one call — bit-
 * identical to the pre-batching code path so v3's KV cache is preserved.
 * When set, `partitionPageIndex` splits the index into stable hash-bucketed
 * batches and we fire one provider call per batch in parallel; the selected
 * slugs are unioned across batches.
 *
 * Per-batch failure does not abort the turn — as long as at least one batch
 * returns a usable selection, the union is returned with `failureReason:
 * null`. Only when EVERY batch fails do we surface a failure; in that case
 * the first batch's reason is returned for parity with the single-batch
 * v3 behavior.
 *
 * Single batch error semantics, preserved from v3:
 * - `empty_index` — workspace has no concept pages or skill entries.
 * - `no_provider` — `getConfiguredProvider("memoryRouter")` returned null.
 * - `api_error` — any uncaught throw during the provider call (incl. abort).
 * - `tool_use_missing` — the model returned no `select_pages_to_inject` tool_use.
 * - `schema_mismatch` — tool input failed Zod validation.
 */
export async function runRouter(
  params: RunRouterParams,
): Promise<RouterResult> {
  const { workspaceDir, priorEverInjected, config } = params;

  const pageIndex = await getPageIndex(workspaceDir);
  if (pageIndex.entries.length === 0) {
    return emptyResult("empty_index");
  }

  const provider = await getConfiguredProvider("memoryRouter", {
    ...(params.overrideProfile !== undefined
      ? { overrideProfile: params.overrideProfile }
      : {}),
  });
  if (!provider) {
    log.warn("memoryRouter provider unavailable; router skipped");
    return emptyResult("no_provider");
  }

  const batchSize = config.memory?.v2?.router?.batch_size ?? null;
  const tier1Size = config.memory?.v2?.router?.tier1_size ?? null;
  const tier2Size = config.memory?.v2?.router?.tier2_size ?? null;

  // Carve in tier order so each later tier sees only what's left. With
  // every tier disabled (defaults) we hit the bit-identical single-batch
  // path that preserves v3's KV cache.
  const { tier1, rest: afterTier1 } = splitTier1(pageIndex, tier1Size);

  let tier2: PageIndex | null = null;
  let afterTier2: PageIndex = afterTier1;
  if (tier2Size !== null && params.database && afterTier1.entries.length > 0) {
    const slugs = afterTier1.entries.map((e) => e.slug);
    const scores = computeInjectionScores(params.database, slugs, Date.now());
    const split = splitTier2(afterTier1, tier2Size, scores);
    tier2 = split.tier2;
    afterTier2 = split.rest;
  } else if (tier2Size !== null && !params.database) {
    log.warn(
      "tier2_size set but no database passed to runRouter; skipping tier 2",
    );
  }

  const tier3Batches = partitionPageIndex(afterTier2, batchSize).filter(
    (b) => b.entries.length > 0,
  );

  // Tag each batch with its provenance string. Tier 3 batches carry their
  // bucket index so the inspector can attribute selections per-bucket.
  const taggedBatches: Array<{ source: RouterSource; index: PageIndex }> = [];
  if (tier1) taggedBatches.push({ source: "tier1", index: tier1 });
  if (tier2) taggedBatches.push({ source: "tier2", index: tier2 });
  tier3Batches.forEach((index, i) => {
    taggedBatches.push({ source: `tier3:${i}` as const, index });
  });
  if (taggedBatches.length === 0) {
    return emptyResult("empty_index");
  }

  const batchResults = await Promise.all(
    taggedBatches.map(({ index }) =>
      runRouterBatch({
        ...params,
        batchIndex: index,
        priorEverInjected,
        provider,
      }),
    ),
  );

  const successes = batchResults.filter((r) => r.failureReason === null);
  if (successes.length === 0) {
    // For the single-batch (K=null) path this preserves v3's behavior:
    // one batch, one failure reason surfaces directly.
    return emptyResult(batchResults[0].failureReason);
  }

  // Union selected slugs preserving first-seen order across batches; batch
  // ordering is deterministic so the union and provenance map are stable.
  // First-seen wins if a slug somehow appears in multiple batches (shouldn't
  // happen — tier 1/2/3 partition is disjoint — but be defensive).
  const sourceBySlug = new Map<string, RouterSource>();
  const selectedSlugs: string[] = [];
  for (let i = 0; i < batchResults.length; i++) {
    const result = batchResults[i];
    const source = taggedBatches[i].source;
    for (const slug of result.selectedSlugs) {
      if (sourceBySlug.has(slug)) continue;
      sourceBySlug.set(slug, source);
      selectedSlugs.push(slug);
    }
  }
  if (successes.length < batchResults.length) {
    log.warn(
      {
        totalBatches: batchResults.length,
        failedBatches: batchResults.length - successes.length,
        failureReasons: batchResults
          .filter((r) => r.failureReason !== null)
          .map((r) => r.failureReason),
      },
      "Some router batches failed; returning union of successful batches",
    );
  }

  // Each per-batch call caps at max_page_ids, but the union across batches can
  // exceed it (e.g. 10 batches × 10 selections each ≫ 25 cap). Apply a final
  // truncation so RouterResult honors the contract that injection.ts trusts.
  // Iteration order above is tier 1 → tier 2 → tier 3:0 → … so earlier-tier
  // slugs win the truncation. The simulator passes `disableUnionCap` so the
  // playground can show the full untruncated union for analysis.
  if (!params.disableUnionCap) {
    const maxPageIds = config.memory?.v2?.router?.max_page_ids ?? 25;
    if (selectedSlugs.length > maxPageIds) {
      log.warn(
        { unionSize: selectedSlugs.length, max: maxPageIds },
        "Router union across batches exceeded max_page_ids; truncating",
      );
      const dropped = selectedSlugs.splice(maxPageIds);
      for (const slug of dropped) sourceBySlug.delete(slug);
    }
  }
  return { selectedSlugs, sourceBySlug, failureReason: null };
}

interface RunRouterBatchParams extends RunRouterParams {
  batchIndex: PageIndex;
  provider: NonNullable<Awaited<ReturnType<typeof getConfiguredProvider>>>;
}

/**
 * Route one batch of the page index. Uses batch-local IDs everywhere
 * (including `<already_injected_ids>`, which is filtered to slugs present
 * in this batch). Provider is passed in by the orchestrator so we don't
 * re-resolve it N times for an N-batch turn.
 */
async function runRouterBatch(
  params: RunRouterBatchParams,
): Promise<RouterBatchResult> {
  const {
    workspaceDir,
    userMessage,
    assistantMessage,
    nowText,
    priorEverInjected,
    config,
    signal,
    batchIndex,
    provider,
  } = params;

  const systemPrompt = resolveRouterPrompt(
    config.memory?.v2?.router?.router_prompt_path ?? null,
    workspaceDir,
    {
      assistantName: getAssistantName(),
      userName: resolveUserName(workspaceDir),
      pageIndexBlock: batchIndex.rendered,
    },
    params.routerPromptOverride ?? null,
  );

  // Filter prior-injected to slugs present in THIS batch and map to
  // batch-local IDs. The model in batch B can't reference global IDs that
  // aren't in its prompt, so listing them would just be noise.
  const priorIds: number[] = [];
  for (const entry of priorEverInjected) {
    const local = batchIndex.bySlug.get(entry.slug);
    if (local) priorIds.push(local.id);
  }

  // Render `<last_turn>` chronologically: the prior assistant reply came
  // first, then the just-arrived user message that triggered this call.
  // On conversation start `assistantMessage` is the empty string — skip the
  // assistant line in that case so we don't emit a dangling `[assistant]:`.
  const lastTurnLines: string[] = [];
  if (assistantMessage.trim().length > 0) {
    lastTurnLines.push(`[assistant]: ${assistantMessage}`);
  }
  lastTurnLines.push(`[user]: ${userMessage}`);
  const lastTurnBlock = `<last_turn>\n${lastTurnLines.join("\n")}\n</last_turn>`;

  const userMsg: Message = {
    role: "user",
    content: [
      cachedTextBlock(`<now>\n${nowText}\n</now>`),
      {
        type: "text",
        text:
          `<already_injected_ids>\n${priorIds.join(", ")}\n</already_injected_ids>\n\n` +
          lastTurnBlock,
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
          disableTurnStartCache: true,
        },
        ...(signal ? { signal } : {}),
      },
    );
  } catch (err) {
    log.warn({ err }, "Router provider call threw; treating as api_error");
    return emptyBatchResult("api_error");
  }

  const toolBlock = extractToolUse(response);
  if (!toolBlock || toolBlock.name !== ROUTER_TOOL_NAME) {
    log.warn(
      { stopReason: response.stopReason },
      "Router model returned no select_pages_to_inject tool_use block",
    );
    return emptyBatchResult("tool_use_missing");
  }

  const parsed = RouterResultSchema.safeParse(toolBlock.input);
  if (!parsed.success) {
    log.warn(
      { error: parsed.error.message },
      "Router tool input did not match schema",
    );
    return emptyBatchResult("schema_mismatch");
  }

  const N = batchIndex.entries.length;
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

  // De-duplicate BEFORE applying the cap — `[1, 1, 2]` with max=2 must
  // yield 2 distinct slugs, not collapse to 1 after slicing duplicates.
  const dedupedIds = Array.from(new Set(inRangeIds));

  const truncated = dedupedIds.length > maxPageIds;
  const finalIds = truncated ? dedupedIds.slice(0, maxPageIds) : dedupedIds;
  if (truncated) {
    log.warn(
      { returned: dedupedIds.length, max: maxPageIds },
      "Router returned more page IDs than max_page_ids; truncating",
    );
  }

  const selectedSlugs: string[] = [];
  for (const id of finalIds) {
    const entry = batchIndex.byId.get(id);
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
