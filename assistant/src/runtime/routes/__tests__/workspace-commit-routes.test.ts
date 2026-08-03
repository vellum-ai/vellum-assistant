/**
 * Request-body validation for the workspace git admin routes.
 *
 * Each handler validates its body before touching the workspace git
 * service, so a malformed body is rejected with a `BadRequestError`
 * (→ 400) without running any git operation. The handlers are async,
 * hence the `.rejects` form.
 */

import { describe, expect, test } from "bun:test";

import { BadRequestError } from "../errors.js";
import { ROUTES } from "../workspace-commit-routes.js";

const routeFor = (operationId: string) => {
  const route = ROUTES.find((r) => r.operationId === operationId);
  if (!route) {
    throw new Error(`no route: ${operationId}`);
  }
  return route;
};

describe("workspace git route body validation", () => {
  test("workspace_commit rejects a missing message", async () => {
    await expect(
      routeFor("workspace_commit").handler({
        body: {} as Record<string, unknown>,
      }),
    ).rejects.toThrow(BadRequestError);
  });

  test("workspace_commit rejects an empty message", async () => {
    await expect(
      routeFor("workspace_commit").handler({
        body: { message: "" } as Record<string, unknown>,
      }),
    ).rejects.toThrow(BadRequestError);
  });

  test("workspace_compact_history rejects a non-boolean force", async () => {
    await expect(
      routeFor("workspace_compact_history").handler({
        body: { force: "yes" } as Record<string, unknown>,
      }),
    ).rejects.toThrow(BadRequestError);
  });

  test("workspace_compact_history rejects a non-integer retentionDays", async () => {
    await expect(
      routeFor("workspace_compact_history").handler({
        body: { retentionDays: 1.5 } as Record<string, unknown>,
      }),
    ).rejects.toThrow(BadRequestError);
  });

  test("workspace_compact_history rejects a non-positive retentionDays", async () => {
    await expect(
      routeFor("workspace_compact_history").handler({
        body: { retentionDays: 0 } as Record<string, unknown>,
      }),
    ).rejects.toThrow(BadRequestError);
  });
});
