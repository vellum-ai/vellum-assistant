/**
 * Request-body validation for the sequence routes.
 *
 * Each handler validates with `parseBody` before opening the DB, so a malformed
 * body is rejected with a `BadRequestError` (→ 400) without any DB access. The
 * schemas are `.strict()`, so unknown keys are rejected too.
 *
 * These handlers are synchronous, so `parseBody` throws during the call — hence
 * `expect(() => …).toThrow` rather than the `.rejects` form. The route adapters
 * catch synchronous throws the same way they catch rejected promises.
 */

import { describe, expect, test } from "bun:test";

import { BadRequestError } from "../errors.js";
import { ROUTES } from "../sequence-routes.js";

const routeFor = (operationId: string) => {
  const route = ROUTES.find((r) => r.operationId === operationId);
  if (!route) {
    throw new Error(`no route: ${operationId}`);
  }
  return route;
};

describe("sequence route body validation", () => {
  test("sequence_get rejects a missing id", () => {
    expect(() =>
      routeFor("sequence_get").handler({ body: {} as Record<string, unknown> }),
    ).toThrow(BadRequestError);
  });

  test("sequence_list rejects a status outside the enum", () => {
    expect(() =>
      routeFor("sequence_list").handler({
        body: { status: "bogus" } as Record<string, unknown>,
      }),
    ).toThrow(BadRequestError);
  });

  test("sequence_guardrails_set rejects a body missing value", () => {
    expect(() =>
      routeFor("sequence_guardrails_set").handler({
        body: { key: "dailySendCap" } as Record<string, unknown>,
      }),
    ).toThrow(BadRequestError);
  });

  test("the strict schema rejects unknown keys", () => {
    expect(() =>
      routeFor("sequence_get").handler({
        body: { id: "seq_1", extra: "nope" } as Record<string, unknown>,
      }),
    ).toThrow(BadRequestError);
  });
});
