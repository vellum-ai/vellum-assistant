/**
 * Memory v3 — selection gate.
 *
 * The gate is the final step of one retrieval pass. After the scouts, the tree
 * walk, the edge expansion, and the sticky carry-over have each contributed
 * candidate page slugs, the gate makes one capable LLM call over the *unioned*
 * candidate set and decides:
 *
 *   - **ready** — finalize the selection and inject for the next reply, or
 *   - **more**  — the candidates don't yet cover the turn; emit follow-up
 *     questions that seed the next pass. These questions are the gate's own
 *     *generated* queries (a refined sub-question), NOT a replay of the
 *     original user message — the loop feeds them back to the scouts/tree on
 *     the next iteration.
 *
 * The gate also returns the final ordered `selectedSlugs` (the order the model
 * returned, with sticky slugs guaranteed present). Sticky pages are never
 * dropped: they were injected on a prior turn and removing them mid-conversation
 * would silently amnesia the assistant, so we union them back in even when the
 * model omits them.
 *
 * Scope — brief generation is deferred. The full v3 design pairs the selection
 * with a ~1000-token voice brief, but that brief is only consumed when v3 is
 * actually injected (a later cutover). In shadow mode the harness injects v2
 * and only compares selections, so this module produces the selection +
 * `GateDecision` only — matching what the harness trace already models. The
 * brief-generation seam is marked below; do not build voice synthesis here.
 *
 * Fail-safe. If no provider is configured or the provider call errors/returns
 * an unusable response, the gate fails *open*: it returns
 * `decision: { decision: "ready" }` and selects every candidate. A retrieval
 * loop that can't reach the model should still inject what it found rather than
 * inject nothing.
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
import type { GateDecision } from "../v2/harness/trace.js";
import type { LlmCallSink } from "./llm-capture.js";
import { renderConversationContext } from "./prompt-context.js";
import {
  GATE_SYSTEM_PROMPT,
  resolveV3SystemPrompt,
} from "./prompts/system-prompts.js";

const log = getLogger("memory-v3-gate");

/** Tool name forced via `tool_choice`. Shared constant so tests can match it. */
const GATE_TOOL_NAME = "decide_selection";

/**
 * Arguments to one gate invocation.
 *
 * `candidates` is the accumulated candidate set for this pass — the union of
 * scouts-kept, tree pages, edge-pulled, and sticky slugs. `sticky` is the
 * subset that was injected on a prior turn and must survive: it is always a
 * subset of `candidates` in practice, but the gate unions it back into both
 * the prompt and the final selection defensively.
 */
export interface RunGateArgs {
  input: RetrievalInput;
  candidates: Set<string>;
  sticky: Set<string>;
  passNumber: number;
  /**
   * Per-candidate one-line summaries, keyed by slug. When present, candidates
   * are rendered to the model as `slug — summary` so the gate can judge
   * relevance on page content rather than the slug alone. Missing entries fall
   * back to the bare slug; the forced tool's `selected_slugs` enum stays
   * slug-only. The loop passes this only when `memory.v3.gateCandidateSummaries`
   * is set.
   */
  summaryBySlug?: ReadonlyMap<string, string>;
  /** Optional debug sink — emits one record for the gate's LLM call. */
  capture?: LlmCallSink;
  /**
   * Provider override seam for tests. Production leaves this unset and the
   * gate resolves `getConfiguredProvider("memoryV3Gate")`. `null` is distinct
   * from `undefined`: passing `null` simulates "no provider configured" and
   * exercises the fail-safe path without resolving the real registry.
   */
  provider?: Provider | null;
}

export interface RunGateResult {
  decision: GateDecision;
  /** Final page slugs in the model's returned order; sticky guaranteed present. */
  selectedSlugs: string[];
}

/**
 * Build the forced tool definition. `selected_slugs` is the ordered final
 * selection; `decision` is the ready/more verdict; `questions` carries the
 * generated follow-up queries on "more" (ignored on "ready"). Mirrors the
 * forced-tool pattern of v2's `select_pages_to_inject`.
 */
function buildGateTool(candidateSlugs: readonly string[]): ToolDefinition {
  return {
    name: GATE_TOOL_NAME,
    description:
      "Decide whether the accumulated candidate pages are sufficient to answer " +
      "the next turn. Return decision='ready' with the final ordered selection " +
      "when the candidates cover the turn; return decision='more' with one or " +
      "more generated follow-up questions (NOT the original message) to seed " +
      "another retrieval pass when coverage is incomplete.",
    input_schema: {
      type: "object",
      properties: {
        decision: { type: "string", enum: ["ready", "more"] },
        selected_slugs: {
          type: "array",
          items: { type: "string", enum: [...candidateSlugs] },
          description:
            "Final ordered page slugs to inject. Each candidate is listed as " +
            "`slug — summary` when summaries are available; return only the slug " +
            "(left of the em-dash), and only from the candidate set. Prefer keeping " +
            "a plausibly-relevant page over dropping it; for a list / 'all of X' / " +
            "breadth request, include every candidate that plausibly applies rather " +
            "than trimming to the most prominent few.",
        },
        questions: {
          type: "array",
          items: { type: "string" },
          description:
            "When decision='more', the generated follow-up questions seeding the next pass.",
        },
        reasoning: {
          type: "string",
          description:
            "One short sentence: why this ready/more verdict, and which " +
            "candidates were kept or dropped.",
        },
      },
      required: ["decision"],
    },
  };
}

const GateToolResultSchema = z.object({
  decision: z.enum(["ready", "more"]),
  selected_slugs: z.array(z.string()).optional(),
  questions: z.array(z.string()).optional(),
  reasoning: z.string().optional(),
});

/**
 * Render the candidate list for the prompt. With summaries available each line
 * is `slug — summary` so the model can judge relevance on content; without them
 * it falls back to the bare slug. The slug (left of the em-dash) is what the
 * `selected_slugs` enum constrains, so the model always answers in slugs.
 */
function renderCandidateLines(
  slugs: readonly string[],
  summaryBySlug: ReadonlyMap<string, string> | undefined,
): string {
  return slugs
    .map((slug) => {
      const summary = summaryBySlug?.get(slug);
      return summary ? `${slug} — ${summary}` : slug;
    })
    .join("\n");
}

/**
 * Order a slug selection: keep the model's returned order, restricted to the
 * candidate set, then append any sticky slugs the model omitted (sticky is
 * never dropped). De-duplicates while preserving first-seen order.
 */
function orderSelection(
  modelSlugs: readonly string[],
  candidates: Set<string>,
  sticky: Set<string>,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const slug of modelSlugs) {
    if (!candidates.has(slug)) continue; // model can only pick from candidates
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
  }
  for (const slug of sticky) {
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
  }
  return out;
}

/**
 * Fail-safe result: inject every candidate and declare the pass ready. Used
 * when the provider is unavailable or the call cannot produce a usable
 * decision. Ordering puts sticky last via `orderSelection` with an empty
 * model selection, so candidates come first then any sticky not already in
 * the set.
 */
function failSafe(candidates: Set<string>, sticky: Set<string>): RunGateResult {
  return {
    decision: { decision: "ready" },
    selectedSlugs: orderSelection([...candidates], candidates, sticky),
  };
}

/**
 * Run the gate for one pass.
 *
 * Makes one forced-tool LLM call over the candidate set and maps the result to
 * a `GateDecision` plus the final ordered selection. Sticky slugs are always
 * present in the selection. Any failure (no provider, provider throw, missing
 * tool_use, schema mismatch) falls back to selecting all candidates with a
 * "ready" decision.
 */
export async function runGate(args: RunGateArgs): Promise<RunGateResult> {
  const { input, candidates, sticky, passNumber } = args;

  const candidateSlugs = [...candidates];

  // Resolve the provider. A `provider` key in args (including explicit `null`)
  // takes precedence so tests inject a stub; production omits it and resolves
  // the configured `memoryV3Gate` call site.
  const provider =
    args.provider !== undefined
      ? args.provider
      : await getConfiguredProvider("memoryV3Gate");

  if (!provider) {
    log.warn("memoryV3Gate provider unavailable; gate failing open (ready)");
    return failSafe(candidates, sticky);
  }

  const systemPrompt = resolveV3SystemPrompt(
    GATE_SYSTEM_PROMPT,
    input.config.memory?.v3?.prompts?.gate,
    input.workspaceDir,
  );

  const stickySlugs = [...sticky];
  const userMsg: Message = {
    role: "user",
    content: [
      {
        type: "text",
        text: renderConversationContext(input),
      },
      {
        type: "text",
        text:
          `<pass_number>${passNumber}</pass_number>\n\n` +
          `<sticky_slugs>\n${stickySlugs.join("\n")}\n</sticky_slugs>\n\n` +
          `<candidates>\n` +
          `${renderCandidateLines(candidateSlugs, args.summaryBySlug)}\n` +
          `</candidates>`,
      },
    ],
  };

  const gateTool = buildGateTool(candidateSlugs);

  const startedAt = Date.now();
  let response;
  try {
    response = await provider.sendMessage([userMsg], [gateTool], systemPrompt, {
      config: {
        callSite: "memoryV3Gate" as const,
        tool_choice: { type: "tool" as const, name: GATE_TOOL_NAME },
      },
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch (err) {
    log.warn({ err }, "Gate provider call threw; failing open (ready)");
    return failSafe(candidates, sticky);
  }

  args.capture?.({
    lane: "gate",
    callSite: "memoryV3Gate",
    request: { systemPrompt, messages: [userMsg], tools: [gateTool] },
    response,
    ms: Date.now() - startedAt,
  });

  const toolBlock = extractToolUse(response);
  if (!toolBlock || toolBlock.name !== GATE_TOOL_NAME) {
    log.warn(
      { stopReason: response.stopReason },
      "Gate model returned no decide_selection tool_use; failing open (ready)",
    );
    return failSafe(candidates, sticky);
  }

  const parsed = GateToolResultSchema.safeParse(toolBlock.input);
  if (!parsed.success) {
    log.warn(
      { error: parsed.error.message },
      "Gate tool input did not match schema; failing open (ready)",
    );
    return failSafe(candidates, sticky);
  }

  const selectedSlugs = orderSelection(
    parsed.data.selected_slugs ?? [],
    candidates,
    sticky,
  );

  const reasoning = parsed.data.reasoning?.trim() || undefined;

  if (parsed.data.decision === "more") {
    const questions = (parsed.data.questions ?? []).filter(
      (q) => q.trim().length > 0,
    );
    const decision: GateDecision = {
      decision: "more",
      ...(questions.length > 0 ? { questions } : {}),
      ...(reasoning ? { reasoning } : {}),
    };
    return { decision, selectedSlugs };
  }

  // brief generation lands at cutover (P5) — shadow mode injects v2, so this
  // gate produces only the selection + decision. Do NOT synthesize a voice
  // brief here.
  return {
    decision: { decision: "ready", ...(reasoning ? { reasoning } : {}) },
    selectedSlugs,
  };
}
