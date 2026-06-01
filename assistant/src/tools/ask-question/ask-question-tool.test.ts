import { beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  QuestionPromptParams,
  QuestionPromptResult,
} from "../../permissions/question-prompter.js";
import type { ToolContext } from "../types.js";

// Stub the prompter at the module level. The tool instantiates
// `new QuestionPrompter(...)` inside `execute()`, so every call goes
// through this constructor — we record `prompt()` calls into a shared
// `calls` array and rotate `nextResult` per test via `setNextResult`.
//
// `mock.module` is hoisted by bun before any static import of the tool
// runs, so the import below sees the stubbed prompter even though
// `askQuestionTool` captures the symbol at module-eval time.
const calls: QuestionPromptParams[] = [];
let nextResult: QuestionPromptResult = {
  entries: [{ questionId: "q1", decision: "skipped" }],
  overall: "completed",
};
function setNextResult(result: QuestionPromptResult): void {
  nextResult = result;
}

mock.module("../../permissions/question-prompter.js", () => ({
  QuestionPrompter: class {
    async prompt(params: QuestionPromptParams): Promise<QuestionPromptResult> {
      calls.push(params);
      return nextResult;
    }
  },
}));

// Import after the mock so the tool's `import { QuestionPrompter }` binds
// to the stub class above.
const { askQuestionTool } = await import("./ask-question-tool.js");

type PromptParams = QuestionPromptParams;

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDir: "/tmp",
    conversationId: "conv-1",
    trustClass: "guardian",
    toolUseId: "tu-1",
    ...overrides,
  };
}

// Reset call log + default result between tests so individual cases stay
// hermetic. Each test that needs a non-default result calls
// `setNextResult()` before invoking `askQuestionTool.execute(...)`.
beforeEach(() => {
  calls.length = 0;
  nextResult = {
    entries: [{ questionId: "q1", decision: "skipped" }],
    overall: "completed",
  };
});

const validInput = {
  question: "Which fruit?",
  description: "Pick one to add to the smoothie.",
  options: [
    { id: "a", label: "Apple" },
    { id: "b", label: "Banana", description: "Ripe" },
  ],
  freeTextPlaceholder: "Type a fruit",
};

const singleQ = {
  question: validInput.question,
  description: validInput.description,
  options: validInput.options,
  freeTextPlaceholder: validInput.freeTextPlaceholder,
};

describe("askQuestionTool definition", () => {
  test("exposes the expected schema shape and description language", () => {
    const def = askQuestionTool;
    expect(def.name).toBe("ask_question");
    expect(def.description).toContain("free-text fallback is always added");
    expect(def.description).toContain("do not");
    expect(def.description).toContain("'something else'");
    expect(def.description).toContain("plain-text clarification");
    expect(def.description).toContain("obvious from context");
    expect(def.description).toContain("Use this tool whenever");
    expect(def.description).toContain("When in doubt");
    expect(def.description).toContain("plausible interpretations");
    expect(def.description).toContain("remove guessing");
    expect(def.description).toContain("a question is skipped");
    expect(def.description).toContain("every question in the batch is skipped");
    // Batching language is back now that the prompter handles batches.
    expect(def.description).toContain("Batch related clarifications");
    expect(def.description).toContain("up to 5");
    expect(def.description).toContain("Skip button");

    const schema = def.input_schema as {
      properties: Record<
        string,
        { type?: string; minItems?: number; maxItems?: number }
      >;
      required?: string[];
    };
    expect(schema.properties.options?.type).toBe("array");
    expect(schema.properties.options?.minItems).toBe(2);
    expect(schema.properties.options?.maxItems).toBe(4);
  });
});

// Build a single-question completed result for tests that just need to
// exercise the formatter on a one-element batch.
function singleCompleted(
  entry:
    | { decision: "option"; optionId: string }
    | { decision: "free_text"; text: string }
    | { decision: "skipped" },
): QuestionPromptResult {
  return {
    entries: [{ questionId: "q1", ...entry }],
    overall: "completed",
  };
}

describe("AskQuestionTool.execute", () => {
  test("forwards questions array unchanged to the prompter", async () => {
    setNextResult(singleCompleted({ decision: "option", optionId: "a" }));

    const result = await askQuestionTool.execute(validInput, makeContext());

    expect(calls).toHaveLength(1);
    expect(calls[0]?.conversationId).toBe("conv-1");
    expect(calls[0]?.questions).toHaveLength(1);
    expect(calls[0]?.questions[0]?.question).toBe(validInput.question);
    expect(calls[0]?.questions[0]?.description).toBe(validInput.description);
    expect(calls[0]?.questions[0]?.options).toEqual(validInput.options);
    expect(calls[0]?.questions[0]?.freeTextPlaceholder).toBe(
      validInput.freeTextPlaceholder,
    );
    expect(calls[0]?.toolUseId).toBe("tu-1");

    expect(result.isError).toBe(false);
    expect(result.content).toBe(
      `Question "${validInput.question}" → Option: a (Apple)`,
    );
  });

  test("formats option result with looked-up label", async () => {
    setNextResult(singleCompleted({ decision: "option", optionId: "b" }));
    const result = await askQuestionTool.execute(validInput, makeContext());
    expect(result.content).toBe(
      `Question "${validInput.question}" → Option: b (Banana)`,
    );
    expect(result.isError).toBe(false);
  });

  test("falls back to '(unknown)' label when optionId is not in options", async () => {
    setNextResult(singleCompleted({ decision: "option", optionId: "ghost" }));
    const result = await askQuestionTool.execute(validInput, makeContext());
    expect(result.content).toBe(
      `Question "${validInput.question}" → Option: ghost ((unknown))`,
    );
    expect(result.isError).toBe(false);
  });

  test("formats free-text result", async () => {
    setNextResult(singleCompleted({ decision: "free_text", text: "Cherry" }));
    const result = await askQuestionTool.execute(validInput, makeContext());
    expect(result.content).toBe(
      `Question "${validInput.question}" → Free text: Cherry`,
    );
    expect(result.isError).toBe(false);
  });

  test("formats skipped result", async () => {
    setNextResult(singleCompleted({ decision: "skipped" }));
    const result = await askQuestionTool.execute(validInput, makeContext());
    expect(result.content).toBe(`Question "${validInput.question}" → Skipped`);
    expect(result.isError).toBe(false);
  });

  test("timeout produces tool error", async () => {
    setNextResult({
      entries: [{ questionId: "q1", decision: "timed_out" }],
      overall: "timed_out",
    });
    const result = await askQuestionTool.execute(validInput, makeContext());
    expect(result.isError).toBe(true);
    expect(result.content).toBe("User did not respond within timeout");
  });

  test("aborted produces tool error", async () => {
    setNextResult({
      entries: [{ questionId: "q1", decision: "skipped" }],
      overall: "aborted",
    });
    const result = await askQuestionTool.execute(validInput, makeContext());
    expect(result.isError).toBe(true);
    expect(result.content).toBe("Question aborted");
  });

  test("rejects input with fewer than 2 options", async () => {
    setNextResult(singleCompleted({ decision: "option", optionId: "a" }));
    const result = await askQuestionTool.execute(
      { ...validInput, options: [{ id: "a", label: "Apple" }] },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content.toLowerCase()).toContain("invalid input");
    expect(calls).toHaveLength(0);
  });

  test("rejects input with more than 4 options", async () => {
    setNextResult(singleCompleted({ decision: "option", optionId: "a" }));
    const result = await askQuestionTool.execute(
      {
        ...validInput,
        options: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
          { id: "c", label: "C" },
          { id: "d", label: "D" },
          { id: "e", label: "E" },
        ],
      },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("rejects input with empty question", async () => {
    setNextResult(singleCompleted({ decision: "option", optionId: "a" }));
    const result = await askQuestionTool.execute(
      { ...validInput, question: "" },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("propagates abort signal into the prompter", async () => {
    setNextResult(singleCompleted({ decision: "option", optionId: "a" }));
    const ac = new AbortController();
    await askQuestionTool.execute(
      validInput,
      makeContext({ signal: ac.signal }),
    );
    expect(calls[0]?.signal).toBe(ac.signal);
  });
});

// ── Batched input ───────────────────────────────────────────────────

describe("AskQuestionTool batched input", () => {
  test("normalizes legacy flat input into a one-element batch forwarded to the prompter", async () => {
    setNextResult(singleCompleted({ decision: "option", optionId: "a" }));

    const result = await askQuestionTool.execute(validInput, makeContext());

    expect(calls).toHaveLength(1);
    expect(calls[0]?.questions).toHaveLength(1);
    expect(calls[0]?.questions[0]?.question).toBe(validInput.question);
    expect(calls[0]?.questions[0]?.options).toEqual(validInput.options);
    expect(result.isError).toBe(false);
  });

  test("accepts a single-element `questions` batch", async () => {
    setNextResult(singleCompleted({ decision: "option", optionId: "a" }));

    const result = await askQuestionTool.execute(
      { questions: [singleQ] },
      makeContext(),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.questions).toHaveLength(1);
    expect(calls[0]?.questions[0]?.question).toBe(singleQ.question);
    expect(calls[0]?.questions[0]?.options).toEqual(singleQ.options);
    expect(calls[0]?.questions[0]?.description).toBe(singleQ.description);
    expect(calls[0]?.questions[0]?.freeTextPlaceholder).toBe(
      singleQ.freeTextPlaceholder,
    );
    expect(result.isError).toBe(false);
  });

  test("forwards the full questions array for a multi-question batch", async () => {
    const q2 = {
      question: "Preferred time?",
      options: [
        { id: "morning", label: "Morning" },
        { id: "afternoon", label: "Afternoon" },
      ],
      freeTextPlaceholder: "or specify",
    };
    const q3 = {
      question: "Send invite?",
      options: [
        { id: "yes", label: "Yes" },
        { id: "no", label: "No" },
      ],
    };

    setNextResult({
      entries: [
        { questionId: "q1", decision: "option", optionId: "a" },
        { questionId: "q2", decision: "free_text", text: "noon-ish" },
        { questionId: "q3", decision: "option", optionId: "yes" },
      ],
      overall: "completed",
    });

    const result = await askQuestionTool.execute(
      { questions: [singleQ, q2, q3] },
      makeContext(),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.questions).toHaveLength(3);
    expect(
      calls[0]?.questions.map(
        (q: PromptParams["questions"][number]) => q.question,
      ),
    ).toEqual([singleQ.question, q2.question, q3.question]);

    expect(result.isError).toBe(false);
    expect(result.content).toBe(
      [
        `Question "${singleQ.question}" → Option: a (Apple)`,
        `Question "${q2.question}" → Free text: noon-ish`,
        `Question "${q3.question}" → Option: yes (Yes)`,
      ].join("\n"),
    );
  });

  test("formats all-skipped batch as a non-error transcript", async () => {
    const q2 = {
      question: "Preferred time?",
      options: [
        { id: "morning", label: "Morning" },
        { id: "afternoon", label: "Afternoon" },
      ],
    };
    const q3 = {
      question: "Send invite?",
      options: [
        { id: "yes", label: "Yes" },
        { id: "no", label: "No" },
      ],
    };
    setNextResult({
      entries: [
        { questionId: "q1", decision: "skipped" },
        { questionId: "q2", decision: "skipped" },
        { questionId: "q3", decision: "skipped" },
      ],
      overall: "completed",
    });

    const result = await askQuestionTool.execute(
      { questions: [singleQ, q2, q3] },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(result.content).toBe(
      [
        `Question "${singleQ.question}" → Skipped`,
        `Question "${q2.question}" → Skipped`,
        `Question "${q3.question}" → Skipped`,
      ].join("\n"),
    );
  });

  test("closed batch prepends a summary line and remains non-error", async () => {
    const q2 = {
      question: "Preferred time?",
      options: [
        { id: "morning", label: "Morning" },
        { id: "afternoon", label: "Afternoon" },
      ],
    };
    setNextResult({
      entries: [
        { questionId: "q1", decision: "skipped" },
        { questionId: "q2", decision: "skipped" },
      ],
      overall: "closed",
    });

    const result = await askQuestionTool.execute(
      { questions: [singleQ, q2] },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(result.content).toBe(
      [
        "User closed the question card without answering. All questions skipped.",
        `Question "${singleQ.question}" → Skipped`,
        `Question "${q2.question}" → Skipped`,
      ].join("\n"),
    );
  });

  test("accepts a 5-entry batch (max allowed)", async () => {
    setNextResult({
      entries: [
        { questionId: "q1", decision: "skipped" },
        { questionId: "q2", decision: "skipped" },
        { questionId: "q3", decision: "skipped" },
        { questionId: "q4", decision: "skipped" },
        { questionId: "q5", decision: "skipped" },
      ],
      overall: "completed",
    });
    const five = [singleQ, singleQ, singleQ, singleQ, singleQ];

    const result = await askQuestionTool.execute(
      { questions: five },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.questions).toHaveLength(5);
  });

  test("rejects batches with 6+ questions", async () => {
    setNextResult(singleCompleted({ decision: "option", optionId: "a" }));
    const six = [singleQ, singleQ, singleQ, singleQ, singleQ, singleQ];

    const result = await askQuestionTool.execute(
      { questions: six },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content.toLowerCase()).toContain("invalid input");
    expect(calls).toHaveLength(0);
  });

  test("rejects empty `questions` array", async () => {
    setNextResult(singleCompleted({ decision: "option", optionId: "a" }));

    const result = await askQuestionTool.execute(
      { questions: [] },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content.toLowerCase()).toContain("invalid input");
    expect(calls).toHaveLength(0);
  });

  test("rejects input missing both `questions` and flat fields", async () => {
    setNextResult(singleCompleted({ decision: "option", optionId: "a" }));

    const result = await askQuestionTool.execute({}, makeContext());

    expect(result.isError).toBe(true);
    expect(result.content.toLowerCase()).toContain("invalid input");
    expect(calls).toHaveLength(0);
  });

  test("rejects legacy `question` without `options`", async () => {
    setNextResult(singleCompleted({ decision: "option", optionId: "a" }));

    const result = await askQuestionTool.execute(
      { question: "Hi?" },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content.toLowerCase()).toContain("invalid input");
    expect(calls).toHaveLength(0);
  });
});

describe("askQuestionTool definition (batched schema)", () => {
  test("exposes `questions[]` shape, keeps legacy fields, omits per-question id", () => {
    const def = askQuestionTool;
    const schema = def.input_schema as unknown as {
      properties: Record<
        string,
        {
          type?: string;
          minItems?: number;
          maxItems?: number;
          items?: {
            type?: string;
            properties?: Record<string, unknown>;
            required?: string[];
          };
        }
      >;
      required?: string[];
    };

    const questions = schema.properties.questions;
    expect(questions?.type).toBe("array");
    expect(questions?.minItems).toBe(1);
    expect(questions?.maxItems).toBe(5);

    const itemProps = questions?.items?.properties ?? {};
    expect(Object.keys(itemProps)).toEqual(
      expect.arrayContaining([
        "question",
        "description",
        "options",
        "freeTextPlaceholder",
      ]),
    );
    // No per-question `id` field — daemon-assigned only.
    expect(Object.keys(itemProps)).not.toContain("id");

    expect(questions?.items?.required).toEqual(["question", "options"]);

    // Legacy fields still present.
    expect(schema.properties.question).toBeDefined();
    expect(schema.properties.options).toBeDefined();
  });
});
