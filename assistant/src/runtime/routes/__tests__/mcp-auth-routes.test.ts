/**
 * Request-body validation for the internal MCP management routes.
 *
 * Each handler validates with `parseBody` before it loads config or touches
 * the credential store, so a malformed body is rejected with a
 * `BadRequestError` (→ 400) without any side effects.
 *
 * These handlers are `async`, so `parseBody` throwing surfaces as a rejected
 * promise — hence the `.rejects` form rather than `expect(() => …).toThrow`.
 * The route adapters map that `BadRequestError` to a 400 the same way.
 */

import { describe, expect, test } from "bun:test";

import { BadRequestError } from "../errors.js";
import { ROUTES } from "../mcp-auth-routes.js";

const routeFor = (operationId: string) => {
  const route = ROUTES.find((r) => r.operationId === operationId);
  if (!route) {
    throw new Error(`no route: ${operationId}`);
  }
  return route;
};

describe("mcp-auth route body validation", () => {
  test("internal_mcp_auth_start rejects a missing serverId", async () => {
    await expect(
      routeFor("internal_mcp_auth_start").handler({
        body: {} as Record<string, unknown>,
      }),
    ).rejects.toThrow(BadRequestError);
  });

  test("internal_mcp_auth_revoke rejects a non-string serverId", async () => {
    await expect(
      routeFor("internal_mcp_auth_revoke").handler({
        body: { serverId: 42 } as unknown as Record<string, unknown>,
      }),
    ).rejects.toThrow(BadRequestError);
  });

  test("internal_mcp_update rejects a non-numeric maxTools", async () => {
    await expect(
      routeFor("internal_mcp_update").handler({
        body: { name: "srv", maxTools: "lots" } as unknown as Record<
          string,
          unknown
        >,
      }),
    ).rejects.toThrow(BadRequestError);
  });

  test("internal_mcp_add rejects a body missing transportType", async () => {
    await expect(
      routeFor("internal_mcp_add").handler({
        body: { name: "srv" } as Record<string, unknown>,
      }),
    ).rejects.toThrow(BadRequestError);
  });

  test("internal_mcp_remove rejects a missing name", async () => {
    await expect(
      routeFor("internal_mcp_remove").handler({
        body: {} as Record<string, unknown>,
      }),
    ).rejects.toThrow(BadRequestError);
  });
});
