/**
 * Tests for the `/v1/question-response` route in `question-routes.ts`.
 *
 * Covers:
 *   - 200 OK + rpcResolve invoked with `{ decision: "option", optionId }`
 *     on valid option body with a registered "question" interaction.
 *   - 200 OK + rpcResolve invoked with `{ decision: "free_text", text }`
 *     on valid free-text body.
 *   - 404 when no pending interaction exists for the requestId.
 *   - 400 when the request body fails zod validation.
 *   - Cross-talk safety: a registered "confirmation" requestId returns 404
 *     rather than being mis-resolved.
 *   - The pending interaction is removed after a successful resolve.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

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
  test("resolves a pending question with an option selection", async () => {
    const resolved: unknown[] = [];
    pendingInteractions.register("req-1", {
      conversationId: "conv-1",
      kind: "question",
      rpcResolve: (value) => resolved.push(value),
    });

    const result = await call({
      body: { requestId: "req-1", kind: "option", optionId: "yes" },
    });

    expect(result).toEqual({ success: true });
    expect(resolved).toEqual([{ decision: "option", optionId: "yes" }]);
    // Interaction deregistered after resolve.
    expect(pendingInteractions.get("req-1")).toBeUndefined();
  });

  test("resolves a pending question with a free-text response", async () => {
    const resolved: unknown[] = [];
    pendingInteractions.register("req-2", {
      conversationId: "conv-1",
      kind: "question",
      rpcResolve: (value) => resolved.push(value),
    });

    const result = await call({
      body: { requestId: "req-2", kind: "free_text", text: "maybe" },
    });

    expect(result).toEqual({ success: true });
    expect(resolved).toEqual([{ decision: "free_text", text: "maybe" }]);
    expect(pendingInteractions.get("req-2")).toBeUndefined();
  });

  test("returns 404 when no pending interaction exists for the requestId", async () => {
    let thrown: unknown;
    try {
      await call({
        body: { requestId: "missing", kind: "option", optionId: "a" },
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(NotFoundError);
    expect((thrown as NotFoundError).statusCode).toBe(404);
  });

  test("returns 400 when the request body fails validation", async () => {
    // Missing optionId for kind: "option".
    let thrown: unknown;
    try {
      await call({ body: { requestId: "req-3", kind: "option" } });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(BadRequestError);
    expect((thrown as BadRequestError).statusCode).toBe(400);
  });

  test("returns 400 when kind is an unknown discriminator value", async () => {
    let thrown: unknown;
    try {
      await call({
        body: { requestId: "req-4", kind: "bogus", optionId: "x" },
      });
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

  test("cross-talk safe: confirmation requestId returns 404 instead of mis-resolving", async () => {
    const resolved: unknown[] = [];
    pendingInteractions.register("req-confirm", {
      conversationId: "conv-1",
      kind: "confirmation",
      rpcResolve: (value) => resolved.push(value),
    });

    let thrown: unknown;
    try {
      await call({
        body: { requestId: "req-confirm", kind: "option", optionId: "yes" },
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(NotFoundError);
    // The confirmation interaction was not touched.
    expect(resolved).toEqual([]);
    expect(pendingInteractions.get("req-confirm")?.kind).toBe("confirmation");
  });
});
