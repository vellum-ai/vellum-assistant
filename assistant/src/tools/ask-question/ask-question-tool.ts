import { z } from "zod";

import { QuestionPrompter } from "../../permissions/question-prompter.js";
import { RiskLevel } from "../../permissions/types.js";
import {
  invalidToolInputResult,
  toToolInputSchema,
} from "../shared/zod-tool-schema.js";
import type {
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "../types.js";

// ── Input schema ────────────────────────────────────────────────────
// One Zod source for both runtime validation (via `TOOL_INPUT_SCHEMAS`)
// and the LLM-facing `input_schema` (derived with `toToolInputSchema`).

const OptionSchema = z.object({
  id: z
    .string()
    .min(1)
    .describe(
      "Stable identifier for this option (returned verbatim in the response).",
    ),
  label: z.string().min(1).describe("Short human-readable label."),
  description: z
    .string()
    .describe("Optional one-line context shown beneath the label.")
    .optional(),
});

// One question in a (possibly single-element) batch. Intentionally has no
// `id` field — per-question ids are daemon-assigned (`q1`, `q2`, ...) inside
// the prompter, never supplied by the LLM. This keeps the LLM-facing schema
// smaller and removes a validation surface (no duplicate-id check, no
// length cap on ids).
const SingleQuestionSchema = z.object({
  question: z.string().min(1).describe("The clarifying question to display."),
  description: z
    .string()
    .describe("Optional one-line context shown beneath the question.")
    .optional(),
  // 2–4 LLM-supplied options. The client renders a fixed 5th "Type
  // something else" slot for free-text, so the model must keep the
  // structured set to 4 or fewer.
  options: z
    .array(OptionSchema)
    .min(2)
    .max(4)
    .describe(
      "2–4 structured options. The UI always appends a free-text fallback slot, so do not include a 'something else' option here.",
    ),
  freeTextPlaceholder: z
    .string()
    .describe(
      "Optional placeholder text shown inside the free-text fallback input.",
    )
    .optional(),
});

// Cap at 5 questions per batch. Past that it starts to feel like a form,
// not a clarification — the model should be implementing, not asking. Any
// input with ≥6 entries is rejected with a clear Zod error.
const MAX_QUESTIONS_PER_BATCH = 5;

// Callers pass a (possibly single-element) batch of questions. `execute()`
// forwards them straight to the prompter. Loose so injected fields (e.g.
// `activity`) never fail validation.
export const askQuestionInputSchema = z.looseObject({
  questions: z
    .array(SingleQuestionSchema)
    .min(1)
    .max(MAX_QUESTIONS_PER_BATCH, {
      message: `At most ${MAX_QUESTIONS_PER_BATCH} questions per batch; split into multiple turns if you need more.`,
    })
    .describe(
      `1–${MAX_QUESTIONS_PER_BATCH} clarifying questions to ask in a single turn. Use a batch when several independent ambiguities block progress; ask one at a time when they're sequentially dependent. Past ${MAX_QUESTIONS_PER_BATCH} questions you should be implementing, not asking.`,
    ),
});

export type SingleQuestion = z.infer<typeof SingleQuestionSchema>;
export type AskQuestionInput = z.infer<typeof askQuestionInputSchema>;

// ── Tool description ────────────────────────────────────────────────

const DESCRIPTION = [
  "Use this tool whenever a request is ambiguous and can be resolved",
  "by 2–4 plausible interpretations or discrete choices. Prefer it over",
  "plain-text clarification — structured options are faster to answer and",
  "remove guessing.",
  "",
  "When in doubt between (a) asking inline and (b) calling ask_question with",
  "structured options: call ask_question. The structured choices are better UX.",
  "",
  'Example: given a request like "schedule lunch with Alice next week" where there',
  "are two plausible Alice contacts, ask which Alice with options like",
  '`{id: "alice_work", label: "Alice (work)"}` and',
  '`{id: "alice_personal", label: "Alice (personal)"}`.',
  "",
  "Batch related clarifications into one call by passing multiple entries in",
  "`questions` (up to 5). Each question gets its own page with a Skip button.",
  "",
  "When NOT to use this tool:",
  "- The answer is obvious from context or recent conversation.",
  "- The question is genuinely open-ended (more than ~4 plausible answers) —",
  "  fall back to plain text.",
  "- You're about to take a low-stakes reversible action and can adjust based",
  "  on feedback.",
  "",
  "If a question is skipped, proceed with reasonable defaults for that",
  "question; if every question in the batch is skipped, stop interrupting",
  "and use defaults across the board.",
  "",
  "Provide 2–4 options. A free-text fallback is always added by the UI — do not",
  "include a 'something else' option yourself.",
  "",
  "Each option needs a stable `id` (the value the response carries back) and a",
  "short human-readable `label`. Optional `description` adds one line of",
  "context shown beneath the label.",
].join("\n");

// ── Text fallback for channels without dynamic UI ───────────────────

/**
 * Render a batch of questions and their options as a plain-text block for
 * channels that can't display the interactive question card (Telegram, SMS,
 * …). Returned as the tool result so the model relays it to the user in its
 * reply — which is what actually gets delivered to the channel — and waits for
 * a free-text answer instead of re-invoking `ask_question`.
 *
 * Options are shown by `label` (+ optional `description`), never their `id`:
 * the id is the machine value the card would return, meaningless to a user
 * typing a free-text answer.
 */
export function formatQuestionsAsTextFallback(
  questions: SingleQuestion[],
): string {
  const multi = questions.length > 1;
  const header = multi
    ? `This channel can't display tappable option buttons. Present these ${questions.length} questions to the user as a plain-text message — list every option so they can reply with a choice or in their own words — then wait for their answer. Do not call ask_question again for these.`
    : "This channel can't display tappable option buttons. Present this question to the user as a plain-text message — list every option so they can reply with a choice or in their own words — then wait for their answer. Do not call ask_question again for this.";

  const blocks = questions.map((q, i) => {
    const lines: string[] = [];
    lines.push(
      multi ? `Question ${i + 1}: ${q.question}` : `Question: ${q.question}`,
    );
    if (q.description) {
      lines.push(q.description);
    }
    lines.push("Options:");
    for (const o of q.options) {
      lines.push(
        o.description ? `- ${o.label} — ${o.description}` : `- ${o.label}`,
      );
    }
    return lines.join("\n");
  });

  return [header, "", blocks.join("\n\n")].join("\n");
}

// ── Tool ────────────────────────────────────────────────────────────

/**
 * `ask_question` tool definition. Tests stub the prompter by mocking
 * `../../permissions/question-prompter.js` via `bun:test`'s `mock.module`
 * before importing this file — see `ask-question-tool.test.ts` for the
 * pattern.
 */
export const askQuestionTool = {
  name: "ask_question",
  description: DESCRIPTION,
  category: "interaction",
  executionTarget: "sandbox",
  defaultRiskLevel: RiskLevel.Low,
  input_schema: toToolInputSchema(askQuestionInputSchema),

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const parsed = askQuestionInputSchema.safeParse(input);
    if (!parsed.success) {
      return invalidToolInputResult("ask_question", parsed.error);
    }

    const questions: SingleQuestion[] = parsed.data.questions;

    // No interactive user is present to answer (scheduled/headless/background
    // turn). Don't park the turn on a prompt no one can resolve — proceed with
    // defaults immediately. Non-interactive turns are already instructed not to
    // ask (NON_INTERACTIVE_CONTEXT_BLOCK); this is the backstop for when the
    // model asks anyway, so it doesn't wait out the full response timeout.
    if (context.isInteractive === false) {
      return {
        content:
          "No interactive user is present to answer; proceeding with reasonable defaults.",
        isError: false,
      };
    }

    // Channel turns (no dynamic UI) park only when the question can reach the
    // user as a guardian-request card with tappable options: a single-question
    // batch, asked by the guardian, on a channel whose notification adapter
    // renders card actions. The prompter's promotion then delivers the card
    // through the guardian-request pipeline, and a tap / request-code reply /
    // bare-text answer resolves the parked prompt.
    //
    // Every other channel turn degrades to text: hand the model the formatted
    // question(s) and options to present in its reply — which IS what gets
    // delivered to the channel — and wait for a free-text answer. Mirrors the
    // isInteractive guard above: return immediately instead of parking on a
    // prompt the surface can't answer. (UI surface tools like ui_show are
    // instead dropped from the wire for these channels; ask_question stays
    // available because a question with options reads cleanly as text.)
    const canDeliverGuardianQuestionCard =
      questions.length === 1 &&
      context.trustClass === "guardian" &&
      context.supportsGuardianQuestionCards === true;
    if (
      context.supportsDynamicUi === false &&
      !canDeliverGuardianQuestionCard
    ) {
      return {
        content: formatQuestionsAsTextFallback(questions),
        isError: false,
      };
    }

    const prompter = new QuestionPrompter();
    const result = await prompter.prompt({
      conversationId: context.conversationId,
      questions,
      toolUseId: context.toolUseId,
      signal: context.signal,
    });

    // Format the aggregated transcript. Each line is keyed by the original
    // question text (not the daemon-assigned id) — the LLM never sees those
    // ids, and human-readable labels read better in the result content.
    const lines = result.entries.map((entry, i) => {
      const q = questions[i]!;
      const prefix = `Question "${q.question}" →`;
      if (entry.decision === "option") {
        const chosen = q.options.find((o) => o.id === entry.optionId);
        const label = chosen?.label ?? "(unknown)";
        return `${prefix} Option: ${entry.optionId} (${label})`;
      }
      if (entry.decision === "free_text") {
        return `${prefix} Free text: ${entry.text ?? ""}`;
      }
      return `${prefix} Skipped`;
    });

    switch (result.overall) {
      case "completed":
        return { content: lines.join("\n"), isError: false };
      case "closed": {
        const summary =
          "User closed the question card without answering. All questions skipped.";
        return {
          content: [summary, ...lines].join("\n"),
          isError: false,
        };
      }
      case "timed_out":
        return {
          content: "User did not respond within timeout",
          isError: true,
        };
      case "aborted":
        return {
          content: "Question aborted",
          isError: true,
        };
    }
  },
} satisfies ToolDefinition;
