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

describe("AskQuestionTool definition", () => {
  test("exposes the expected schema shape", () => {
    const def = new AskQuestionTool().getDefinition();
    expect(def.name).toBe("ask_question");
    expect(def.description).toContain("free-text fallback is always added");
    expect(def.description).toContain("do not");
    expect(def.description).toContain("'something else'");
    expect(def.description).toContain("plain-text clarification");
    expect(def.description).toContain("obvious from context");

    const schema = def.input_schema as {
      properties: Record<
        string,
        { type?: string; minItems?: number; maxItems?: number }
      >;
      required?: string[];
    };
    // PR 2 removed top-level `required` — caller may supply either
    // `questions` or the legacy flat fields, enforced at runtime by Zod.
    // Per-shape `required` arrays still live on the legacy `options` field
    // and on the `questions[]` item schema.
    expect(schema.properties.options?.type).toBe("array");
    expect(schema.properties.options?.minItems).toBe(2);
    expect(schema.properties.options?.maxItems).toBe(4);
  });
});

describe("AskQuestionTool.execute", () => {
  test("forwards options unchanged to the prompter", async () => {
    const { tool, calls } = makeToolWithStub({
      decision: "option",
      optionId: "a",
    });

    const result = await tool.execute(validInput, makeContext());

    expect(calls).toHaveLength(1);
    expect(calls[0]?.conversationId).toBe("conv-1");
    expect(calls[0]?.question).toBe(validInput.question);
    expect(calls[0]?.description).toBe(validInput.description);
    expect(calls[0]?.options).toEqual(validInput.options);
    expect(calls[0]?.freeTextPlaceholder).toBe(validInput.freeTextPlaceholder);
    expect(calls[0]?.toolUseId).toBe("tu-1");

    expect(result.isError).toBe(false);
    expect(result.content).toBe("Option: a\nLabel: Apple");
  });

  test("formats option result with looked-up label", async () => {
    const { tool } = makeToolWithStub({
      decision: "option",
      optionId: "b",
    });
    const result = await tool.execute(validInput, makeContext());
    expect(result.content).toBe("Option: b\nLabel: Banana");
    expect(result.isError).toBe(false);
  });

  test("falls back to '(unknown)' label when optionId is not in options", async () => {
    // Defensive: prompter never returns an out-of-band id, but the handler
    // must not crash if it ever did. Verifies the lookup default branch.
    const { tool } = makeToolWithStub({
      decision: "option",
      optionId: "ghost",
    });
    const result = await tool.execute(validInput, makeContext());
    expect(result.content).toBe("Option: ghost\nLabel: (unknown)");
    expect(result.isError).toBe(false);
  });

  test("formats free-text result", async () => {
    const { tool } = makeToolWithStub({
      decision: "free_text",
      text: "Cherry",
    });
    const result = await tool.execute(validInput, makeContext());
    expect(result.content).toBe("Free text: Cherry");
    expect(result.isError).toBe(false);
  });

  test("timeout produces tool error", async () => {
    const { tool } = makeToolWithStub({ decision: "timed_out" });
    const result = await tool.execute(validInput, makeContext());
    expect(result.isError).toBe(true);
    expect(result.content).toBe("User did not respond within timeout");
  });

  test("aborted produces tool error", async () => {
    const { tool } = makeToolWithStub({ decision: "aborted" });
    const result = await tool.execute(validInput, makeContext());
    expect(result.isError).toBe(true);
    expect(result.content).toBe("Question aborted");
  });

  test("rejects input with fewer than 2 options", async () => {
    const { tool, calls } = makeToolWithStub({
      decision: "option",
      optionId: "a",
    });
    const result = await tool.execute(
      { ...validInput, options: [{ id: "a", label: "Apple" }] },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content.toLowerCase()).toContain("invalid input");
    expect(calls).toHaveLength(0);
  });

  test("rejects input with more than 4 options", async () => {
    const { tool, calls } = makeToolWithStub({
      decision: "option",
      optionId: "a",
    });
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
    const { tool, calls } = makeToolWithStub({
      decision: "option",
      optionId: "a",
    });
    const result = await tool.execute(
      { ...validInput, question: "" },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("propagates abort signal into the prompter", async () => {
    const { tool, calls } = makeToolWithStub({
      decision: "option",
      optionId: "a",
    });
    const ac = new AbortController();
    await tool.execute(validInput, makeContext({ signal: ac.signal }));
    expect(calls[0]?.signal).toBe(ac.signal);
  });
});

// ── Batched input ───────────────────────────────────────────────────
// These tests cover the input-shape contract only — the `questions[]`
// shape, the 1..5 cap, and the legacy-flat normalization. Outbound
// prompter behavior (id assignment, batched broadcasting) is covered
// in `question-prompter.test.ts`.

const singleQ = {
  question: validInput.question,
  description: validInput.description,
  options: validInput.options,
  freeTextPlaceholder: validInput.freeTextPlaceholder,
};

describe("AskQuestionTool batched input", () => {
  test("normalizes legacy flat input into a one-element batch", async () => {
    const { tool, calls } = makeToolWithStub({
      decision: "option",
      optionId: "a",
    });

    const result = await tool.execute(validInput, makeContext());

    expect(calls).toHaveLength(1);
    expect(calls[0]?.question).toBe(validInput.question);
    expect(calls[0]?.options).toEqual(validInput.options);
    expect(result.isError).toBe(false);
  });

  test("accepts a single-element `questions` batch", async () => {
    const { tool, calls } = makeToolWithStub({
      decision: "option",
      optionId: "a",
    });

    const result = await tool.execute(
      { questions: [singleQ] },
      makeContext(),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.question).toBe(singleQ.question);
    expect(calls[0]?.options).toEqual(singleQ.options);
    expect(calls[0]?.description).toBe(singleQ.description);
    expect(calls[0]?.freeTextPlaceholder).toBe(singleQ.freeTextPlaceholder);
    expect(result.isError).toBe(false);
  });

  test("accepts a multi-question batch up to 5", async () => {
    const { tool, calls } = makeToolWithStub({
      decision: "option",
      optionId: "a",
    });
    const five = [singleQ, singleQ, singleQ, singleQ, singleQ];

    const result = await tool.execute({ questions: five }, makeContext());

    // Only the head is forwarded until the prompter learns to batch.
    expect(calls).toHaveLength(1);
    expect(result.isError).toBe(false);
  });

  test("rejects batches with 6+ questions", async () => {
    const { tool, calls } = makeToolWithStub({
      decision: "option",
      optionId: "a",
    });
    const six = [singleQ, singleQ, singleQ, singleQ, singleQ, singleQ];

    const result = await tool.execute({ questions: six }, makeContext());

    expect(result.isError).toBe(true);
    expect(result.content.toLowerCase()).toContain("invalid input");
    expect(calls).toHaveLength(0);
  });

  test("rejects empty `questions` array", async () => {
    const { tool, calls } = makeToolWithStub({
      decision: "option",
      optionId: "a",
    });

    const result = await tool.execute({ questions: [] }, makeContext());

    expect(result.isError).toBe(true);
    expect(result.content.toLowerCase()).toContain("invalid input");
    expect(calls).toHaveLength(0);
  });

  test("rejects input missing both `questions` and flat fields", async () => {
    const { tool, calls } = makeToolWithStub({
      decision: "option",
      optionId: "a",
    });

    const result = await tool.execute({}, makeContext());

    expect(result.isError).toBe(true);
    expect(result.content.toLowerCase()).toContain("invalid input");
    expect(calls).toHaveLength(0);
  });

  test("rejects legacy `question` without `options`", async () => {
    const { tool, calls } = makeToolWithStub({
      decision: "option",
      optionId: "a",
    });

    const result = await tool.execute(
      { question: "Hi?" },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content.toLowerCase()).toContain("invalid input");
    expect(calls).toHaveLength(0);
  });

  test("formats free-text result for batched input", async () => {
    const { tool } = makeToolWithStub({
      decision: "free_text",
      text: "Cherry",
    });

    const result = await tool.execute(
      { questions: [singleQ] },
      makeContext(),
    );

    expect(result.content).toBe("Free text: Cherry");
    expect(result.isError).toBe(false);
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

    // Batched shape is present and capped at 5.
    const questions = schema.properties.questions;
    expect(questions?.type).toBe("array");
    expect(questions?.minItems).toBe(1);
    expect(questions?.maxItems).toBe(5);

    // Per-question item schema requires `question` and `options` but
    // explicitly does NOT include an `id` field — ids are daemon-assigned.
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

    // Legacy flat fields are still present (optional, no top-level required).
    expect(schema.properties.question?.type).toBe("string");
    expect(schema.properties.options?.type).toBe("array");
    expect(schema.properties.options?.minItems).toBe(2);
    expect(schema.properties.options?.maxItems).toBe(4);
    expect(schema.properties.freeTextPlaceholder?.type).toBe("string");

    // No top-level `required` array — the choice between batched and flat
    // is enforced at runtime by Zod.
    expect(schema.required).toBeUndefined();
  });
});
