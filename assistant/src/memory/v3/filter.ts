/**
 * Memory v3 — fast dense-hit filter.
 *
 * The dense scout lane surfaces embedding-similarity candidates that span
 * subtrees: some are meaningful cross-domain associations worth carrying into
 * the gate, others are spurious near-neighbors that only crowd the slate. This
 * module makes **one cheap LLM call** to keep the meaningful associations and
 * drop the noise, *before* the more expensive selection gate runs.
 *
 * What it judges. Only the bounded dense candidate set (the scout lane is
 * already capped at ~50–200 by quota/MMR — the filter never sees the whole
 * corpus). Hot pages and near-exact sparse hits arrive via the scouts'
 * `sticky` / `bypass` sets and are **never judged**: a literal keyword hit or a
 * page the user has been touching is a strong enough signal that we shouldn't
 * make it earn its place through a fallible cheap judgment, and the downstream
 * gate force-injects every sticky slug regardless — judging it could not change
 * its fate. The `bypass` subset is additionally unioned straight into `kept`.
 *
 * Fail-open. If no provider is configured or the call errors / returns an
 * unusable response, the filter keeps *all* judged dense candidates and surfaces
 * a `failureReason` so the loop can record that the filter was bypassed.
 * Dropping candidates on a model outage would silently starve retrieval; keeping
 * them is the safe degradation (the downstream gate still narrows the slate).
 *
 * No LLM call when there is nothing to judge. A dense set fully covered by
 * sticky short-circuits to `kept` = the bypass-relevant slugs (no judged
 * additions), with no provider round-trip.
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
import type { LlmCallSink } from "./llm-capture.js";
import { renderConversationContext } from "./prompt-context.js";
import {
  FILTER_SYSTEM_PROMPT,
  resolveV3SystemPrompt,
} from "./prompts/system-prompts.js";

const log = getLogger("memory-v3-filter");

/** Tool name forced via `tool_choice`. Shared constant so tests can match it. */
const FILTER_TOOL_NAME = "filter_dense_hits";

/**
 * Arguments to one filter invocation.
 *
 * `dense` is the bounded dense scout result; only its slugs that are *not*
 * already in `sticky` are judged. `sticky` is the keep-in-the-running set (hot +
 * near-exact sparse) the downstream gate force-injects regardless of this
 * filter, so judging a sticky page wastes an LLM call that can never change its
 * fate. `bypass` is the subset of sticky strong enough to skip judgment that the
 * filter also unions straight into `kept`. Sticky slugs that also appear in the
 * dense lane are excluded from the judged set and never sent to the model.
 */
export interface FilterDenseHitsArgs {
  input: RetrievalInput;
  dense: ScoutResult;
  sticky: Set<string>;
  bypass: Set<string>;
  /** Optional debug sink — emits one record for the filter's LLM call. */
  capture?: LlmCallSink;
  /**
   * Provider override seam for tests. Production leaves this unset and the
   * filter resolves `getConfiguredProvider("memoryV3Filter")`. `null` is
   * distinct from `undefined`: passing `null` simulates "no provider
   * configured" and exercises the fail-open path without resolving the real
   * registry.
   */
  provider?: Provider | null;
}

export interface FilterDenseHitsResult {
  /** Final kept slugs: bypass ∪ judged-kept. */
  kept: string[];
  /** Inspection trace: which dense slugs were judged and which were dropped. */
  trace: { judged: string[]; dropped: string[] };
  /**
   * Non-null when the filter could not judge (no provider, provider throw,
   * missing tool_use, schema mismatch) and therefore failed open by keeping all
   * dense candidates. The loop can surface this to flag a bypassed filter.
   */
  failureReason?: string;
}

/**
 * Build the forced tool definition. `keep_slugs` is the model's subset of the
 * judged candidate set to retain; everything judged-but-not-kept is dropped.
 * Mirrors the forced-tool pattern of v2's `select_pages_to_inject`.
 */
function buildFilterTool(judgedSlugs: readonly string[]): ToolDefinition {
  return {
    name: FILTER_TOOL_NAME,
    description:
      "From the candidate concept pages surfaced by embedding similarity for " +
      "the current turn, keep the ones that are meaningful associations worth " +
      "surfacing and drop the spurious near-neighbors. Return keep_slugs as the " +
      "subset to retain — choose only from the candidate set. Lean toward " +
      "keeping a plausible cross-domain association over dropping it.",
    input_schema: {
      type: "object",
      properties: {
        keep_slugs: {
          type: "array",
          items: { type: "string", enum: [...judgedSlugs] },
          description:
            "The subset of candidate page slugs to keep. Choose only from the candidate set.",
        },
        reasoning: {
          type: "string",
          description:
            "One short sentence: why these hits were kept and the rest dropped.",
        },
      },
      required: ["keep_slugs"],
    },
  };
}

const FilterToolResultSchema = z.object({
  keep_slugs: z.array(z.string()),
  reasoning: z.string().optional(),
});

/**
 * Compose the final result. `kept` = bypass slugs ∪ judged-kept (de-duplicated,
 * bypass first then judged-kept in the model's returned order). `trace` records
 * exactly which dense slugs were judged and which the model dropped.
 */
function buildResult(
  bypass: Set<string>,
  judged: readonly string[],
  judgedKept: readonly string[],
  failureReason?: string,
): FilterDenseHitsResult {
  const keptSet = new Set<string>(bypass);
  const kept: string[] = [...bypass];
  for (const slug of judgedKept) {
    if (keptSet.has(slug)) continue;
    keptSet.add(slug);
    kept.push(slug);
  }
  const keptJudged = new Set(judgedKept);
  const dropped = judged.filter((slug) => !keptJudged.has(slug));
  return {
    kept,
    trace: { judged: [...judged], dropped },
    ...(failureReason !== undefined ? { failureReason } : {}),
  };
}

/**
 * Run the fast dense-hit filter for one pass.
 *
 * Makes at most one forced-tool LLM call over the *judged* set (dense slugs not
 * already in `sticky`). Sticky slugs are force-selected by the downstream gate
 * regardless of this filter, so they are excluded from judgment; bypass slugs
 * are additionally kept unconditionally here. On an empty judged set no call is
 * made. Any failure (no provider, provider throw, missing tool_use, schema
 * mismatch) fails open: every judged dense candidate is kept and a
 * `failureReason` is returned.
 */
export async function filterDenseHits(
  args: FilterDenseHitsArgs,
): Promise<FilterDenseHitsResult> {
  const { input, dense, sticky, bypass } = args;

  // Sticky slugs (hot + near-exact sparse) are force-selected by the gate
  // regardless of this filter, so judging them wastes an LLM call that can't
  // change their fate. Exclude the full sticky set (a superset of bypass) from
  // the judged set; only the remaining dense near-neighbors are judged.
  const judged = dense.slugs.filter((slug) => !sticky.has(slug));

  // Nothing to judge → no LLM call. Kept is just the bypass-relevant slugs.
  if (judged.length === 0) {
    return buildResult(bypass, judged, judged);
  }

  // Resolve the provider. A `provider` key in args (including explicit `null`)
  // takes precedence so tests inject a stub; production omits it and resolves
  // the configured `memoryV3Filter` call site.
  const provider =
    args.provider !== undefined
      ? args.provider
      : await getConfiguredProvider("memoryV3Filter");

  if (!provider) {
    log.warn(
      "memoryV3Filter provider unavailable; failing open (keeping all dense)",
    );
    return buildResult(bypass, judged, judged, "no_provider");
  }

  const systemPrompt = resolveV3SystemPrompt(
    FILTER_SYSTEM_PROMPT,
    input.config.memory?.v3?.prompts?.filter,
    input.workspaceDir,
  );

  const userMsg: Message = {
    role: "user",
    content: [
      {
        type: "text",
        text: renderConversationContext(input),
      },
      {
        type: "text",
        text: `<candidate_slugs>\n${judged.join("\n")}\n</candidate_slugs>`,
      },
    ],
  };

  const filterTool = buildFilterTool(judged);

  const startedAt = Date.now();
  let response;
  try {
    response = await provider.sendMessage([userMsg], {
      tools: [filterTool],
      systemPrompt,
      config: {
        callSite: "memoryV3Filter" as const,
        tool_choice: { type: "tool" as const, name: FILTER_TOOL_NAME },
      },
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch (err) {
    log.warn({ err }, "Filter provider call threw; failing open (keep all)");
    return buildResult(bypass, judged, judged, "api_error");
  }

  args.capture?.({
    lane: "filter",
    callSite: "memoryV3Filter",
    request: { systemPrompt, messages: [userMsg], tools: [filterTool] },
    response,
    ms: Date.now() - startedAt,
  });

  const toolBlock = extractToolUse(response);
  if (!toolBlock || toolBlock.name !== FILTER_TOOL_NAME) {
    log.warn(
      { stopReason: response.stopReason },
      "Filter model returned no filter_dense_hits tool_use; failing open (keep all)",
    );
    return buildResult(bypass, judged, judged, "tool_use_missing");
  }

  const parsed = FilterToolResultSchema.safeParse(toolBlock.input);
  if (!parsed.success) {
    log.warn(
      { error: parsed.error.message },
      "Filter tool input did not match schema; failing open (keep all)",
    );
    return buildResult(bypass, judged, judged, "schema_mismatch");
  }

  // Restrict the model's keep set to the judged candidates (it can only keep
  // what it was shown) and preserve its returned order.
  const judgedSet = new Set(judged);
  const seen = new Set<string>();
  const judgedKept: string[] = [];
  for (const slug of parsed.data.keep_slugs) {
    if (!judgedSet.has(slug)) continue;
    if (seen.has(slug)) continue;
    seen.add(slug);
    judgedKept.push(slug);
  }

  return buildResult(bypass, judged, judgedKept);
}
