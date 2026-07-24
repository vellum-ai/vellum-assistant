/**
 * Request-body validation for the emit_event route.
 *
 * The handler validates with `parseBody`, so a malformed body is rejected with
 * a `BadRequestError` (→ 400) instead of the raw `ZodError` a bare `.parse()`
 * surfaces — which neither adapter maps, so it becomes a 500 — before any
 * event is emitted.
 *
 * The handler is synchronous, so `parseBody` throws during the call — hence
 * `expect(() => …).toThrow` rather than the `.rejects` form.
 */

import { describe, expect, test } from "bun:test";

import { BadRequestError } from "../errors.js";
import { ROUTES } from "../events-routes.js";

const routeFor = (operationId: string) => {
  const route = ROUTES.find((r) => r.operationId === operationId);
  if (!route) {
    throw new Error(`no route: ${operationId}`);
  }
  return route;
};

describe("emit_event body validation", () => {
  test("rejects an out-of-enum kind with BadRequestError", () => {
    expect(() =>
      routeFor("emit_event").handler({
        body: { kind: "bogus" } as Record<string, unknown>,
      }),
    ).toThrow(BadRequestError);
  });

  test("rejects a body missing kind with BadRequestError", () => {
    expect(() =>
      routeFor("emit_event").handler({ body: {} as Record<string, unknown> }),
    ).toThrow(BadRequestError);
  });
});
