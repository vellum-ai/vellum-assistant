import { describe, expect, test } from "bun:test";

import type { QuestionPromptResult } from "../../permissions/question-prompter.js";
import type { ToolContext } from "../types.js";
import { AskQuestionTool } from "./ask-question-tool.js";

type PromptParams = Parameters<
  import("../../permissions/question-prompter.js").QuestionPrompter["prompt"]
>[0];

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDir: "/tmp",
    conversationId: "conv-1",
    trustClass: "guardian",
    toolUseId: "tu-1",
    ...overrides,
  };
}

function makeToolWithStub(result: QuestionPromptResult): {
  tool: AskQuestionTool;
  calls: PromptParams[];
} {
  const calls: PromptParams[] = [];
  const tool = new AskQuestionTool(() => ({
    async prompt(params: PromptParams) {
      calls.push(params);
      return result;
    },
  }));
  return { tool, calls };
}

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

describe("AskQuestionTool definition", () => {
  test("exposes the expected schema shape and description language", () => {
    const def = new AskQuestionTool().getDefinition();
    expect(def.name).toBe("ask_question");
    expect(def.description).toContain("free-text fallback is always added");
    expect(def.description).toContain("do not");
    expect(def.description).toContain("'something else'");
    expect(def.description).toContain("plain-text clarification");
    expect(def.description).toContain("obvious from context");
    expect(def.description).toContain("Use this tool whenever");
    expect(def.description).toContain("When in doubt");
    expect(def.description).toContain("skips a question");
    expect(def.description).toContain("skip every question in the batch");
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
    const { tool, calls } = makeToolWithStub(
      singleCompleted({ decision: "option", optionId: "a" }),
    );

    const result = await tool.execute(validInput, makeContext());

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
    const { tool } = makeToolWithStub(
      singleCompleted({ decision: "option", optionId: "b" }),
    );
    const result = await tool.execute(validInput, makeContext());
    expect(result.content).toBe(
      `Question "${validInput.question}" → Option: b (Banana)`,
    );
    expect(result.isError).toBe(false);
  });

  test("falls back to '(unknown)' label when optionId is not in options", async () => {
    const { tool } = makeToolWithStub(
      singleCompleted({ decision: "option", optionId: "ghost" }),
    );
    const result = await tool.execute(validInput, makeContext());
    expect(result.content).toBe(
      `Question "${validInput.question}" → Option: ghost ((unknown))`,
    );
    expect(result.isError).toBe(false);
  });

  test("formats free-text result", async () => {
    const { tool } = makeToolWithStub(
      singleCompleted({ decision: "free_text", text: "Cherry" }),
    );
    const result = await tool.execute(validInput, makeContext());
    expect(result.content).toBe(
      `Question "${validInput.question}" → Free text: Cherry`,
    );
    expect(result.isError).toBe(false);
  });

  test("formats skipped result", async () => {
    const { tool } = makeToolWithStub(singleCompleted({ decision: "skipped" }));
    const result = await tool.execute(validInput, makeContext());
    expect(result.content).toBe(`Question "${validInput.question}" → Skipped`);
    expect(result.isError).toBe(false);
  });

  test("timeout produces tool error", async () => {
    const { tool } = makeToolWithStub({
      entries: [{ questionId: "q1", decision: "timed_out" }],
      overall: "timed_out",
    });
    const result = await tool.execute(validInput, makeContext());
    expect(result.isError).toBe(true);
    expect(result.content).toBe("User did not respond within timeout");
  });

  test("aborted produces tool error", async () => {
    const { tool } = makeToolWithStub({
      entries: [{ questionId: "q1", decision: "skipped" }],
      overall: "aborted",
    });
    const result = await tool.execute(validInput, makeContext());
    expect(result.isError).toBe(true);
    expect(result.content).toBe("Question aborted");
  });

  test("rejects input with fewer than 2 options", async () => {
    const { tool, calls } = makeToolWithStub(
      singleCompleted({ decision: "option", optionId: "a" }),
    );
    const result = await tool.execute(
      { ...validInput, options: [{ id: "a", label: "Apple" }] },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content.toLowerCase()).toContain("invalid input");
    expect(calls).toHaveLength(0);
  });

  test("rejects input with more than 4 options", async () => {
    const { tool, calls } = makeToolWithStub(
      singleCompleted({ decision: "option", optionId: "a" }),
    );
    const result = await tool.execute(
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
    const { tool, calls } = makeToolWithStub(
      singleCompleted({ decision: "option", optionId: "a" }),
    );
    const result = await tool.execute(
      { ...validInput, question: "" },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("propagates abort signal into the prompter", async () => {
    const { tool, calls } = makeToolWithStub(
      singleCompleted({ decision: "option", optionId: "a" }),
    );
    const ac = new AbortController();
    await tool.execute(validInput, makeContext({ signal: ac.signal }));
    expect(calls[0]?.signal).toBe(ac.signal);
  });
});

// ── Batched input ───────────────────────────────────────────────────

describe("AskQuestionTool batched input", () => {
  test("normalizes legacy flat input into a one-element batch forwarded to the prompter", async () => {
    const { tool, calls } = makeToolWithStub(
      singleCompleted({ decision: "option", optionId: "a" }),
    );

    const result = await tool.execute(validInput, makeContext());

    expect(calls).toHaveLength(1);
    expect(calls[0]?.questions).toHaveLength(1);
    expect(calls[0]?.questions[0]?.question).toBe(validInput.question);
    expect(calls[0]?.questions[0]?.options).toEqual(validInput.options);
    expect(result.isError).toBe(false);
  });

  test("accepts a single-element `questions` batch", async () => {
    const { tool, calls } = makeToolWithStub(
      singleCompleted({ decision: "option", optionId: "a" }),
    );

    const result = await tool.execute(
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

    const { tool, calls } = makeToolWithStub({
      entries: [
        { questionId: "q1", decision: "option", optionId: "a" },
        { questionId: "q2", decision: "free_text", text: "noon-ish" },
        { questionId: "q3", decision: "option", optionId: "yes" },
      ],
      overall: "completed",
    });

    const result = await tool.execute(
      { questions: [singleQ, q2, q3] },
      makeContext(),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.questions).toHaveLength(3);
    expect(calls[0]?.questions.map((q) => q.question)).toEqual([
      singleQ.question,
      q2.question,
      q3.question,
    ]);

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
    const { tool } = makeToolWithStub({
      entries: [
        { questionId: "q1", decision: "skipped" },
        { questionId: "q2", decision: "skipped" },
        { questionId: "q3", decision: "skipped" },
      ],
      overall: "completed",
    });

    const result = await tool.execute(
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
    const { tool } = makeToolWithStub({
      entries: [
        { questionId: "q1", decision: "skipped" },
        { questionId: "q2", decision: "skipped" },
      ],
      overall: "closed",
    });

    const result = await tool.execute(
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
    const { tool, calls } = makeToolWithStub({
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

    const result = await tool.execute({ questions: five }, makeContext());

    expect(result.isError).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.questions).toHaveLength(5);
  });

  test("rejects batches with 6+ questions", async () => {
    const { tool, calls } = makeToolWithStub(
      singleCompleted({ decision: "option", optionId: "a" }),
    );
    const six = [singleQ, singleQ, singleQ, singleQ, singleQ, singleQ];

    const result = await tool.execute({ questions: six }, makeContext());

    expect(result.isError).toBe(true);
    expect(result.content.toLowerCase()).toContain("invalid input");
    expect(calls).toHaveLength(0);
  });

  test("rejects empty `questions` array", async () => {
    const { tool, calls } = makeToolWithStub(
      singleCompleted({ decision: "option", optionId: "a" }),
    );

    const result = await tool.execute({ questions: [] }, makeContext());

    expect(result.isError).toBe(true);
    expect(result.content.toLowerCase()).toContain("invalid input");
    expect(calls).toHaveLength(0);
  });

  test("rejects input missing both `questions` and flat fields", async () => {
    const { tool, calls } = makeToolWithStub(
      singleCompleted({ decision: "option", optionId: "a" }),
    );

    const result = await tool.execute({}, makeContext());

    expect(result.isError).toBe(true);
    expect(result.content.toLowerCase()).toContain("invalid input");
    expect(calls).toHaveLength(0);
  });

  test("rejects legacy `question` without `options`", async () => {
    const { tool, calls } = makeToolWithStub(
      singleCompleted({ decision: "option", optionId: "a" }),
    );

    const result = await tool.execute(
      { question: "Hi?" },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content.toLowerCase()).toContain("invalid input");
    expect(calls).toHaveLength(0);
  });
});

describe("AskQuestionTool definition (batched schema)", () => {
  test("exposes `questions[]` shape, keeps legacy fields, omits per-question id", () => {
    const def = new AskQuestionTool().getDefinition();
    const schema = def.input_schema as {
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
    expect(Object.keys(itemProps)).not.toContain("id");
    expect(questions?.items?.required).toEqual(["question", "options"]);

    expect(schema.properties.question?.type).toBe("string");
    expect(schema.properties.options?.type).toBe("array");
    expect(schema.properties.options?.minItems).toBe(2);
    expect(schema.properties.options?.maxItems).toBe(4);
    expect(schema.properties.freeTextPlaceholder?.type).toBe("string");

    expect(schema.required).toBeUndefined();
  });
});
