/**
 * Request-body validation for the defer routes.
 *
 * Each handler validates with `parseBody`, so a malformed body is rejected
 * with a `BadRequestError` (→ 400) instead of the raw `ZodError` a bare
 * `.parse()` surfaces — which neither adapter maps, so it becomes a 500.
 * Validation runs before the schedule store is touched.
 *
 * These handlers are `async`, so the rejection surfaces as a rejected promise.
 */

import { describe, expect, test } from "bun:test";

import { ROUTES } from "../defer-routes.js";
import { BadRequestError } from "../errors.js";

const routeFor = (operationId: string) => {
  const route = ROUTES.find((r) => r.operationId === operationId);
  if (!route) {
    throw new Error(`no route: ${operationId}`);
  }
  return route;
};

describe("defer route body validation", () => {
  test("defer_create rejects a body missing conversationId", async () => {
    await expect(
      routeFor("defer_create").handler({ body: {} as Record<string, unknown> }),
    ).rejects.toThrow(BadRequestError);
  });

  test("defer_list rejects a non-string conversationId", async () => {
    await expect(
      routeFor("defer_list").handler({
        body: { conversationId: 123 } as unknown as Record<string, unknown>,
      }),
    ).rejects.toThrow(BadRequestError);
  });
});
