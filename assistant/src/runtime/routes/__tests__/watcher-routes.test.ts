/**
 * Request-body validation for the watcher routes.
 *
 * Each handler validates with `parseBody`, so a malformed body is rejected
 * with a `BadRequestError` (→ 400) instead of the raw `ZodError` a bare
 * `.parse()` surfaces — which neither adapter maps, so it becomes a 500.
 * Validation runs before the watcher store is touched.
 *
 * These handlers are synchronous, so `parseBody` throws during the call —
 * hence `expect(() => …).toThrow` rather than the `.rejects` form.
 */

import { describe, expect, test } from "bun:test";

import { BadRequestError } from "../errors.js";
import { ROUTES } from "../watcher-routes.js";

const routeFor = (operationId: string) => {
  const route = ROUTES.find((r) => r.operationId === operationId);
  if (!route) {
    throw new Error(`no route: ${operationId}`);
  }
  return route;
};

describe("watcher route body validation", () => {
  test("watcher_create rejects a body missing required fields", () => {
    expect(() =>
      routeFor("watcher_create").handler({
        body: {} as Record<string, unknown>,
      }),
    ).toThrow(BadRequestError);
  });

  test("watcher_update rejects a body missing watcher_id", () => {
    expect(() =>
      routeFor("watcher_update").handler({
        body: { name: "renamed" } as Record<string, unknown>,
      }),
    ).toThrow(BadRequestError);
  });
});
