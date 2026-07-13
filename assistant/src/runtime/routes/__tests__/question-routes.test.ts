/**
 * Tests for the `/v1/question-response` route in `question-routes.ts`.
 *
 * Covers:
 *   - kind: "submit" — single-entry happy path (option + free_text).
 *   - kind: "submit" — multi-entry batch resolves with the full result.
 *   - kind: "close" — every entry reported as skipped, overall="closed".
 *   - Validation: missing questionId from the batch → 400.
 *   - Validation: unknown questionId → 400.
 *   - Validation: option submission with unknown optionId → 400.
 *   - Cross-talk safety: a registered "confirmation" requestId returns 404.
 *   - Legacy single-question shim: works against a one-element batch,
 *     400s against a multi-element batch.
 *   - The pending interaction is removed after a successful resolve.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { QuestionPromptResult } from "../../../permissions/question-prompter.js";
import * as pendingInteractions from "../../pending-interactions.js";
import { BadRequestError, NotFoundError } from "../errors.js";
import { ROUTES as QUESTION_ROUTES } from "../question-routes.js";
import type { RouteDefinition, RouteHandlerArgs } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findHandler(operationId: string): RouteDefinition["handler"] {
  const route = QUESTION_ROUTES.find((r) => r.operationId === operationId);
  if (!route) throw new Error(`Route ${operationId} not found`);
  return route.handler;
}

const handler = findHandler("question_response");

async function call(args: RouteHandlerArgs): Promise<unknown> {
  return await handler(args);
}

/**
 * Register a pending "question" interaction with the metadata the route
 * needs to validate batched submissions. Mirrors what
 * QuestionPrompter.prompt() does internally.
 */
function registerQuestion(
  requestId: string,
  questions: Array<{ id: string; options: string[] }>,
  rpcResolve: (value: unknown) => void = () => {},
): void {
  const optionsById: Record<string, string[]> = {};
  for (const q of questions) optionsById[q.id] = q.options;
  pendingInteractions.register(requestId, {
    conversationId: "conv-1",
    kind: "question",
    rpcResolve,
    metadata: {
      orderedIds: questions.map((q) => q.id),
      optionsById,
    },
  });
}

beforeEach(() => {
  pendingInteractions.clear();
});

afterEach(() => {
  pendingInteractions.clear();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /v1/question-response", () => {
  test("submit: resolves a one-question batch with an option entry", async () => {
    const resolved: QuestionPromptResult[] = [];
    registerQuestion("req-1", [{ id: "q1", options: ["yes", "no"] }], (v) =>
      resolved.push(v as QuestionPromptResult),
    );

    const result = await call({
      body: {
        requestId: "req-1",
        kind: "submit",
        responses: [{ questionId: "q1", kind: "option", optionId: "yes" }],
      },
    });

    expect(result).toEqual({ success: true });
    expect(resolved).toEqual([
      {
        entries: [{ questionId: "q1", decision: "option", optionId: "yes" }],
        overall: "completed",
      },
    ]);
    expect(pendingInteractions.get("req-1")).toBeUndefined();
  });

  test("submit: three-question batch with two options + one free-text", async () => {
    const resolved: QuestionPromptResult[] = [];
    registerQuestion(
      "req-3",
      [
        { id: "q1", options: ["alice_work", "alice_personal"] },
        { id: "q2", options: ["yes", "no"] },
        { id: "q3", options: ["noon", "1pm"] },
      ],
      (v) => resolved.push(v as QuestionPromptResult),
    );

    const result = await call({
      body: {
        requestId: "req-3",
        kind: "submit",
        responses: [
          { questionId: "q1", kind: "option", optionId: "alice_work" },
          { questionId: "q3", kind: "free_text", text: "noon-ish" },
          { questionId: "q2", kind: "option", optionId: "yes" },
        ],
      },
    });

    expect(result).toEqual({ success: true });
    expect(resolved[0]?.overall).toBe("completed");
    // Entries are ordered to match the original questions array.
    expect(resolved[0]?.entries).toEqual([
      { questionId: "q1", decision: "option", optionId: "alice_work" },
      { questionId: "q2", decision: "option", optionId: "yes" },
      { questionId: "q3", decision: "free_text", text: "noon-ish" },
    ]);
  });

  test("submit: all-skip resolves with completed + skipped entries", async () => {
    const resolved: QuestionPromptResult[] = [];
    registerQuestion(
      "req-skip-all",
      [
        { id: "q1", options: ["a", "b"] },
        { id: "q2", options: ["x", "y"] },
      ],
      (v) => resolved.push(v as QuestionPromptResult),
    );

    await call({
      body: {
        requestId: "req-skip-all",
        kind: "submit",
        responses: [
          { questionId: "q1", kind: "skip" },
          { questionId: "q2", kind: "skip" },
        ],
      },
    });

    expect(resolved[0]).toEqual({
      entries: [
        { questionId: "q1", decision: "skipped" },
        { questionId: "q2", decision: "skipped" },
      ],
      overall: "completed",
    });
  });

  test("close: every entry reported as skipped with overall=closed", async () => {
    const resolved: QuestionPromptResult[] = [];
    registerQuestion(
      "req-close",
      [
        { id: "q1", options: ["a", "b"] },
        { id: "q2", options: ["x", "y"] },
      ],
      (v) => resolved.push(v as QuestionPromptResult),
    );

    const result = await call({
      body: { requestId: "req-close", kind: "close" },
    });

    expect(result).toEqual({ success: true });
    expect(resolved[0]).toEqual({
      entries: [
        { questionId: "q1", decision: "skipped" },
        { questionId: "q2", decision: "skipped" },
      ],
      overall: "closed",
    });
    expect(pendingInteractions.get("req-close")).toBeUndefined();
  });

  test("returns 404 when no pending interaction exists for the requestId", async () => {
    let thrown: unknown;
    try {
      await call({
        body: {
          requestId: "missing",
          kind: "submit",
          responses: [{ questionId: "q1", kind: "option", optionId: "a" }],
        },
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(NotFoundError);
    expect((thrown as NotFoundError).statusCode).toBe(404);
  });

  test("returns 400 when the request body fails schema validation", async () => {
    registerQuestion("req-bad", [{ id: "q1", options: ["a", "b"] }]);
    let thrown: unknown;
    try {
      // Missing `responses` for kind: "submit".
      await call({ body: { requestId: "req-bad", kind: "submit" } });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(BadRequestError);
    expect((thrown as BadRequestError).statusCode).toBe(400);
  });

  test("returns 400 when kind is unknown", async () => {
    let thrown: unknown;
    try {
      await call({ body: { requestId: "req-1", kind: "bogus" } });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(BadRequestError);
  });

  test("returns 400 when body is missing entirely", async () => {
    let thrown: unknown;
    try {
      await call({});
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(BadRequestError);
  });

  test("validation: batch missing a questionId from the original set → 400", async () => {
    const resolved: unknown[] = [];
    registerQuestion(
      "req-miss",
      [
        { id: "q1", options: ["a", "b"] },
        { id: "q2", options: ["x", "y"] },
      ],
      (v) => resolved.push(v),
    );

    let thrown: unknown;
    try {
      await call({
        body: {
          requestId: "req-miss",
          kind: "submit",
          responses: [{ questionId: "q1", kind: "option", optionId: "a" }],
        },
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(BadRequestError);
    // Pending interaction left in place so the user can retry.
    expect(pendingInteractions.get("req-miss")).toBeDefined();
    expect(resolved).toEqual([]);
  });

  test("validation: unknown questionId → 400", async () => {
    registerQuestion("req-uq", [{ id: "q1", options: ["a", "b"] }]);

    let thrown: unknown;
    try {
      await call({
        body: {
          requestId: "req-uq",
          kind: "submit",
          responses: [
            { questionId: "q1", kind: "option", optionId: "a" },
            { questionId: "qX", kind: "skip" },
          ],
        },
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(BadRequestError);
  });

  test("validation: unknown optionId → 400", async () => {
    registerQuestion("req-uo", [{ id: "q1", options: ["a", "b"] }]);

    let thrown: unknown;
    try {
      await call({
        body: {
          requestId: "req-uo",
          kind: "submit",
          responses: [{ questionId: "q1", kind: "option", optionId: "nope" }],
        },
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(BadRequestError);
  });

  test("cross-talk safe: confirmation requestId returns 404", async () => {
    const resolved: unknown[] = [];
    pendingInteractions.register("req-confirm", {
      conversationId: "conv-1",
      kind: "confirmation",
      rpcResolve: (value) => resolved.push(value),
    });

    let thrown: unknown;
    try {
      await call({
        body: {
          requestId: "req-confirm",
          kind: "submit",
          responses: [{ questionId: "q1", kind: "option", optionId: "yes" }],
        },
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(NotFoundError);
    expect(resolved).toEqual([]);
    expect(pendingInteractions.get("req-confirm")?.kind).toBe("confirmation");
  });

  test("legacy single-question shim: resolves against a one-element batch", async () => {
    const resolved: QuestionPromptResult[] = [];
    registerQuestion(
      "req-legacy",
      [{ id: "q1", options: ["yes", "no"] }],
      (v) => resolved.push(v as QuestionPromptResult),
    );

    const result = await call({
      body: { requestId: "req-legacy", kind: "option", optionId: "yes" },
    });

    expect(result).toEqual({ success: true });
    expect(resolved[0]).toEqual({
      entries: [{ questionId: "q1", decision: "option", optionId: "yes" }],
      overall: "completed",
    });
  });

  test("legacy single-question shim: free-text resolves against a one-element batch", async () => {
    const resolved: QuestionPromptResult[] = [];
    registerQuestion(
      "req-legacy-ft",
      [{ id: "q1", options: ["yes", "no"] }],
      (v) => resolved.push(v as QuestionPromptResult),
    );

    await call({
      body: { requestId: "req-legacy-ft", kind: "free_text", text: "maybe" },
    });

    expect(resolved[0]).toEqual({
      entries: [{ questionId: "q1", decision: "free_text", text: "maybe" }],
      overall: "completed",
    });
  });

  test("legacy single-question shim: rejects against a multi-element batch", async () => {
    registerQuestion("req-legacy-multi", [
      { id: "q1", options: ["a", "b"] },
      { id: "q2", options: ["x", "y"] },
    ]);

    let thrown: unknown;
    try {
      await call({
        body: { requestId: "req-legacy-multi", kind: "option", optionId: "a" },
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(BadRequestError);
    expect((thrown as BadRequestError).message.toLowerCase()).toContain(
      "multi-question",
    );
    // Pending interaction left in place.
    expect(pendingInteractions.get("req-legacy-multi")).toBeDefined();
  });
});
