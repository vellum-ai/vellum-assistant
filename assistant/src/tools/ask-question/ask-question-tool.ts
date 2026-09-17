import { z } from "zod";

import type {
  AnsweredQuestion,
  AnsweredQuestionResponse,
} from "../../api/events/question-answered.js";
import {
  QuestionPrompter,
  type QuestionPromptOutcome,
  type QuestionPromptParamsEntry,
} from "../../permissions/question-prompter.js";
import { RiskLevel } from "../../permissions/types.js";
import { DESKTOP_HELP_GUIDANCE } from "../../util/browser-human-verification.js";
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
export const askQuestionInputSchema = z
  .looseObject({
    desktopHelp: z
      .object({
        message: z
          .string()
          .min(1)
          .describe(
            "Use one short sentence to explain the needed human action, in the user's language.",
          ),
        doneLabel: z
          .string()
          .min(1)
          .describe("The label for Done in the user's language."),
        skipLabel: z
          .string()
          .min(1)
          .describe("The label for Skip in the user's language."),
      })
      .describe(
        "Immediately request human interaction for any CAPTCHA or bot-detection challenge, including sliders and press-and-hold checks. Also use for native dialogs requiring user interaction. For logins, use saved credentials or securely prompt for missing credentials first. Explain what the user should do. Shows a live preview with Step In, Done and Skip. Pass this instead of questions.",
      )
      .optional(),
    questions: z
      .array(SingleQuestionSchema)
      .min(1)
      .max(MAX_QUESTIONS_PER_BATCH, {
        message: `At most ${MAX_QUESTIONS_PER_BATCH} questions per batch; split into multiple turns if you need more.`,
      })
      .describe(
        `1–${MAX_QUESTIONS_PER_BATCH} clarifying questions to ask in a single turn. Use a batch when several independent ambiguities block progress; ask one at a time when they're sequentially dependent. Past ${MAX_QUESTIONS_PER_BATCH} questions you should be implementing, not asking.`,
      )
      .optional(),
  })
  .refine((input) => Boolean(input.questions) !== Boolean(input.desktopHelp), {
    message: "Provide either questions or desktopHelp, not both.",
  });

export type SingleQuestion = z.infer<typeof SingleQuestionSchema>;
export type AskQuestionInput = z.infer<typeof askQuestionInputSchema>;

// ── Tool description ────────────────────────────────────────────────

const DESCRIPTION = [
  DESKTOP_HELP_GUIDANCE,
  "For logins, use saved credentials first. Securely collect missing credentials",
  "with assistant credentials prompt, then fill the login form yourself.",
  "",
  "Every call passes exactly one of `questions` or `desktopHelp`.",
  "",
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

/**
 * Project a settled prompt into the durable answered-question record the
 * daemon persists on the tool call. Returns undefined for outcomes that carry
 * no user decision (timeout, abort), which have nothing to show in history.
 */
export function toAnsweredQuestion(
  outcome: QuestionPromptOutcome,
): AnsweredQuestion | undefined {
  if (outcome.overall !== "completed" && outcome.overall !== "closed") {
    return undefined;
  }
  const responses: AnsweredQuestionResponse[] = [];
  for (const entry of outcome.entries) {
    if (entry.decision === "option") {
      responses.push({
        questionId: entry.questionId,
        decision: "option",
        optionId: entry.optionId,
      });
    } else if (entry.decision === "free_text") {
      responses.push({
        questionId: entry.questionId,
        decision: "free_text",
        text: entry.text,
      });
    } else {
      // A `completed` batch can still carry per-question skips, and a `closed`
      // card reports every question as skipped. `timed_out` / `aborted` cannot
      // reach here: they only ever appear on a batch-wide outcome of the same
      // name, which is filtered above.
      responses.push({ questionId: entry.questionId, decision: "skipped" });
    }
  }
  return {
    requestId: outcome.requestId,
    questions: outcome.questions,
    responses,
    overall: outcome.overall,
  };
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
  // Anthropic rejects `oneOf` / `anyOf` / `allOf` at the root of a tool
  // schema, so the either/or rule between `questions` and `desktopHelp` lives
  // in the description and the Zod refine, not in the wire schema.
  input_schema: toToolInputSchema(askQuestionInputSchema),

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const parsed = askQuestionInputSchema.safeParse(input);
    if (!parsed.success) {
      return invalidToolInputResult("ask_question", parsed.error);
    }

    const { desktopHelp } = parsed.data;
    const questions: QuestionPromptParamsEntry[] = desktopHelp
      ? [
          {
            question: desktopHelp.message,
            options: [
              { id: "done", label: desktopHelp.doneLabel },
              { id: "skip", label: desktopHelp.skipLabel },
            ],
            presentation: "virtual_desktop",
          },
        ]
      : parsed.data.questions!;

    // No interactive user is present to answer (scheduled/headless/background
    // turn). Don't park the turn on a prompt no one can resolve — proceed with
    // defaults immediately. Non-interactive turns are already instructed not to
    // ask (NON_INTERACTIVE_CONTEXT_BLOCK); this is the backstop for when the
    // model asks anyway, so it doesn't wait out the full response timeout.
    if (context.isInteractive === false) {
      return {
        content: desktopHelp
          ? "No interactive user is present to help in the virtual desktop. The obstacle remains unresolved."
          : "No interactive user is present to answer; proceeding with reasonable defaults.",
        isError: false,
      };
    }

    if (desktopHelp && context.supportsDynamicUi === false) {
      return {
        content:
          "This channel cannot show the virtual desktop preview or Step In. Ask the user to continue in the Vellum app to complete this step. The obstacle remains unresolved.",
        isError: true,
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

    let finishDesktopHelp: ((resume: boolean) => Promise<void>) | undefined;
    if (desktopHelp) {
      const { prepareDesktopHelp } =
        await import("../../desktop/desktop-help.js");
      const prepared = await prepareDesktopHelp(context);
      if (typeof prepared !== "function") {
        return prepared;
      }
      finishDesktopHelp = prepared;
    }

    const prompter = new QuestionPrompter();
    let result: QuestionPromptOutcome;
    let resumeDesktop = false;
    try {
      result = await prompter.prompt({
        conversationId: context.conversationId,
        questions,
        toolUseId: context.toolUseId,
        signal: context.signal,
      });
      const answer = result.entries[0];
      resumeDesktop =
        result.overall === "completed" &&
        (answer?.decision === "free_text" ||
          (answer?.decision === "option" && answer.optionId === "done"));
    } finally {
      await finishDesktopHelp?.(resumeDesktop);
    }

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

    // The user's decision belongs in the transcript, not just in the string
    // handed to the model: the daemon persists this on the tool call so the
    // answered card survives a conversation switch, reload, or history reopen.
    const answeredQuestion = toAnsweredQuestion(result);

    switch (result.overall) {
      case "completed": {
        let content = lines.join("\n");
        if (desktopHelp) {
          const entry = result.entries[0];
          if (entry?.decision === "free_text") {
            content +=
              "\nTake a fresh browser snapshot before continuing; do not assume the obstacle was resolved.";
          } else if (
            entry?.decision === "option" &&
            entry.optionId === "done"
          ) {
            content =
              "The user finished interacting with the virtual desktop. Take a fresh browser snapshot and verify the result before continuing.";
          } else {
            content =
              "The user skipped helping in the virtual desktop. The obstacle may still be present. Use another approach or explain what remains blocked.";
          }
        }
        return { content, isError: false, answeredQuestion };
      }
      case "closed": {
        const summary =
          "User closed the question card without answering. All questions skipped.";
        return {
          content: [summary, ...lines].join("\n"),
          isError: false,
          answeredQuestion,
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
