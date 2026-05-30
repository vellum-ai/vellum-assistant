import { z } from "zod";

import { QuestionPrompter } from "../../permissions/question-prompter.js";
import { RiskLevel } from "../../permissions/types.js";
import type {
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "../types.js";

// ── Input schema ────────────────────────────────────────────────────
// Runtime validation lives in Zod; the wire-level definition surfaced
// to the LLM is the hand-written JSON Schema in `input_schema` below.
// (The codebase does not currently use zod-to-json-schema for tool defs,
// so the two are kept in sync manually.)

const OptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
});

// One question in a (possibly single-element) batch. Intentionally has no
// `id` field — per-question ids are daemon-assigned (`q1`, `q2`, ...) inside
// the prompter, never supplied by the LLM. This keeps the LLM-facing schema
// smaller and removes a validation surface (no duplicate-id check, no
// length cap on ids).
const SingleQuestionSchema = z.object({
  question: z.string().min(1),
  description: z.string().optional(),
  // 2–4 LLM-supplied options. The client renders a fixed 5th "Type
  // something else" slot for free-text, so the model must keep the
  // structured set to 4 or fewer.
  options: z.array(OptionSchema).min(2).max(4),
  freeTextPlaceholder: z.string().optional(),
});

// Cap at 5 questions per batch. Past that it starts to feel like a form,
// not a clarification — the model should be implementing, not asking. Any
// input with ≥6 entries is rejected with a clear Zod error.
const MAX_QUESTIONS_PER_BATCH = 5;

// Both the new batched shape (`questions[]`) and the legacy flat shape are
// accepted. `execute()` normalizes legacy callers into a one-element
// `questions` array before forwarding to the prompter.
const InputSchema = z
  .object({
    questions: z
      .array(SingleQuestionSchema)
      .min(1)
      .max(MAX_QUESTIONS_PER_BATCH, {
        message: `At most ${MAX_QUESTIONS_PER_BATCH} questions per batch; split into multiple turns if you need more.`,
      })
      .optional(),
    // Legacy flat fields. Optional so batched callers can omit them; when
    // present and `questions` is absent, they are normalized into a
    // one-element batch in `execute()`.
    question: z.string().min(1).optional(),
    description: z.string().optional(),
    options: z.array(OptionSchema).min(2).max(4).optional(),
    freeTextPlaceholder: z.string().optional(),
  })
  .refine(
    (v) =>
      v.questions !== undefined ||
      (v.question !== undefined && v.options !== undefined),
    {
      message:
        "Provide `questions` (preferred) or the legacy flat fields (`question` + `options`).",
    },
  );

export type SingleQuestion = z.infer<typeof SingleQuestionSchema>;
export type AskQuestionInput = z.infer<typeof InputSchema>;

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

// Shared option-schema fragment used by both the batched `questions[]`
// shape and the legacy flat `options` field.
const OPTION_ITEMS_SCHEMA = {
  type: "object",
  properties: {
    id: {
      type: "string",
      description:
        "Stable identifier for this option (returned verbatim in the response).",
    },
    label: {
      type: "string",
      description: "Short human-readable label.",
    },
    description: {
      type: "string",
      description: "Optional one-line context shown beneath the label.",
    },
  },
  required: ["id", "label"],
} as const;

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
  input_schema: {
    type: "object",
    properties: {
      // ── Recommended shape ─────────────────────────────────────
      questions: {
        type: "array",
        minItems: 1,
        maxItems: MAX_QUESTIONS_PER_BATCH,
        description: `Recommended shape. 1–${MAX_QUESTIONS_PER_BATCH} clarifying questions to ask in a single turn. Use a batch when several independent ambiguities block progress; ask one at a time when they're sequentially dependent. Past ${MAX_QUESTIONS_PER_BATCH} questions you should be implementing, not asking.`,
        items: {
          type: "object",
          properties: {
            question: {
              type: "string",
              description: "The clarifying question to display.",
            },
            description: {
              type: "string",
              description:
                "Optional one-line context shown beneath the question.",
            },
            options: {
              type: "array",
              minItems: 2,
              maxItems: 4,
              description:
                "2–4 structured options. The UI always appends a free-text fallback slot, so do not include a 'something else' option here.",
              items: OPTION_ITEMS_SCHEMA,
            },
            freeTextPlaceholder: {
              type: "string",
              description:
                "Optional placeholder text shown inside the free-text fallback input.",
            },
          },
          required: ["question", "options"],
        },
      },
      // ── Legacy single-question fields ─────────────────────────
      // Kept optional so existing prompt caches and any single-question
      // callers continue to work. New callers should use `questions`.
      question: {
        type: "string",
        description:
          "Legacy: the single clarifying question. Prefer `questions[]` for new code.",
      },
      description: {
        type: "string",
        description:
          "Legacy: optional one-line context shown beneath the question. Prefer `questions[].description`.",
      },
      options: {
        type: "array",
        minItems: 2,
        maxItems: 4,
        description:
          "Legacy: 2–4 structured options. Prefer `questions[].options`. The UI always appends a free-text fallback slot, so do not include a 'something else' option here.",
        items: OPTION_ITEMS_SCHEMA,
      },
      freeTextPlaceholder: {
        type: "string",
        description:
          "Legacy: optional placeholder text for the free-text fallback input. Prefer `questions[].freeTextPlaceholder`.",
      },
    },
    // No top-level `required` — caller must supply either `questions`
    // or the legacy flat trio (`question` + `options`). Enforced in Zod.
  },

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const parsed = InputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        content: `Invalid input: ${parsed.error.message}`,
        isError: true,
      };
    }

    // Normalize legacy flat input into a one-element `questions` batch so
    // downstream code only has to deal with the batched shape. The refine
    // above guarantees `question` and `options` are present whenever
    // `questions` is absent.
    const questions: SingleQuestion[] = parsed.data.questions ?? [
      {
        question: parsed.data.question!,
        description: parsed.data.description,
        options: parsed.data.options!,
        freeTextPlaceholder: parsed.data.freeTextPlaceholder,
      },
    ];

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
