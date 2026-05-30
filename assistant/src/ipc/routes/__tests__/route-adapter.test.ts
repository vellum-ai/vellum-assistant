/**
 * Tests for `routeDefinitionsToIpcMethods`: filtering eligibility,
 * meta-route emission, and — critically — policy serialization.
 *
 * Policy serialization is what the gateway IPC proxy depends on to
 * enforce scope/principal checks without maintaining its own table
 * (ATL-315). If the daemon's resolution drifts from what the HTTP path
 * actually enforces, IPC and HTTP diverge silently.
 */

import { describe, expect, test } from "bun:test";

import { z } from "zod";

import type { RouteDefinition } from "../../../runtime/routes/types.js";
import { routeDefinitionsToIpcMethods } from "../route-adapter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function noopHandler() {
  return {};
}

function defineRoute(overrides: Partial<RouteDefinition>): RouteDefinition {
  return {
    operationId: "test_route",
    endpoint: "test",
    method: "GET",
    handler: noopHandler,
    ...overrides,
  };
}

interface SchemaEntry {
  operationId: string;
  endpoint: string;
  method: string;
  policy: {
    requiredScopes: string[];
    allowedPrincipalTypes: string[];
  } | null;
}

async function getSchema(routes: RouteDefinition[]): Promise<SchemaEntry[]> {
  const ipcMethods = routeDefinitionsToIpcMethods(routes);
  const meta = ipcMethods.find((r) => r.operationId === "get_route_schema");
  expect(meta).toBeDefined();
  const result = await meta!.handler({});
  return result as SchemaEntry[];
}

// ---------------------------------------------------------------------------
// Eligibility filter
// ---------------------------------------------------------------------------

describe("routeDefinitionsToIpcMethods — eligibility", () => {
  test("excludes routes that requireGuardian", () => {
    const routes: RouteDefinition[] = [
      defineRoute({ operationId: "ok", endpoint: "ok" }),
      defineRoute({
        operationId: "guarded",
        endpoint: "guarded",
        requireGuardian: true,
      }),
    ];
    const result = routeDefinitionsToIpcMethods(routes);
    const ids = result
      .map((r) => r.operationId)
      .filter((id) => id !== "get_route_schema");
    expect(ids).toEqual(["ok"]);
  });

  test("excludes routes that are public", () => {
    const routes: RouteDefinition[] = [
      defineRoute({ operationId: "ok", endpoint: "ok" }),
      defineRoute({
        operationId: "pub",
        endpoint: "pub",
        isPublic: true,
      }),
    ];
    const result = routeDefinitionsToIpcMethods(routes);
    const ids = result
      .map((r) => r.operationId)
      .filter((id) => id !== "get_route_schema");
    expect(ids).toEqual(["ok"]);
  });

  test("appends the get_route_schema meta-route", () => {
    const routes: RouteDefinition[] = [defineRoute({})];
    const result = routeDefinitionsToIpcMethods(routes);
    expect(
      result.find((r) => r.operationId === "get_route_schema"),
    ).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Schema serialization
// ---------------------------------------------------------------------------

describe("routeDefinitionsToIpcMethods — schema shape", () => {
  test("schema entry has operationId / endpoint / method / policy fields", async () => {
    const routes: RouteDefinition[] = [
      defineRoute({ operationId: "a", endpoint: "a", method: "POST" }),
    ];
    const schema = await getSchema(routes);
    expect(schema).toHaveLength(1);
    expect(schema[0]).toEqual({
      operationId: "a",
      endpoint: "a",
      method: "POST",
      policy: null,
    });
  });

  test("schema validates against the wire-shape Zod schema (gateway contract)", async () => {
    // The gateway's `route-schema-cache.ts` parses the schema with this
    // exact shape (Zod). If the daemon ever drifts (e.g. drops `policy`),
    // this test fails — preventing the silent fail-open class of bug
    // ATL-315 set out to fix.
    const entrySchema = z.object({
      operationId: z.string(),
      endpoint: z.string(),
      method: z.string(),
      policy: z
        .object({
          requiredScopes: z.array(z.string()),
          allowedPrincipalTypes: z.array(z.string()),
        })
        .nullable(),
    });

    const routes: RouteDefinition[] = [
      defineRoute({ operationId: "a", endpoint: "a/:id" }),
      defineRoute({ operationId: "b", endpoint: "b", method: "POST" }),
    ];
    const schema = await getSchema(routes);
    for (const entry of schema) {
      const parsed = entrySchema.safeParse(entry);
      expect(parsed.success).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Policy resolution — the load-bearing piece
// ---------------------------------------------------------------------------

describe("routeDefinitionsToIpcMethods — policy resolution", () => {
  test("routes with no registered policy ship policy: null", async () => {
    // `random_unregistered_endpoint` has no `registerPolicy(...)` entry.
    const routes: RouteDefinition[] = [
      defineRoute({
        operationId: "z",
        endpoint: "random_unregistered_endpoint",
      }),
    ];
    const schema = await getSchema(routes);
    expect(schema[0].policy).toBeNull();
  });

  test("routes with a registered method-specific policy resolve to it", async () => {
    // `messages` is registered as `messages:GET` + `messages:POST` in
    // runtime/auth/route-policy.ts.
    const routes: RouteDefinition[] = [
      defineRoute({
        operationId: "m_get",
        endpoint: "messages",
        method: "GET",
      }),
      defineRoute({
        operationId: "m_post",
        endpoint: "messages",
        method: "POST",
      }),
    ];
    const schema = await getSchema(routes);
    expect(schema[0].policy?.requiredScopes).toEqual(["chat.read"]);
    expect(schema[1].policy?.requiredScopes).toEqual(["chat.write"]);
  });

  test("policy lookup respects explicit policyKey override", async () => {
    // The `plugins` policyKey is shared across plugins:GET / plugins:DELETE.
    // The route adapter should use the explicit policyKey, not the
    // derived `plugins/:name` → `plugins` form.
    const routes: RouteDefinition[] = [
      defineRoute({
        operationId: "plugins_uninstall",
        endpoint: "plugins/:name",
        method: "DELETE",
        policyKey: "plugins",
      }),
    ];
    const schema = await getSchema(routes);
    expect(schema[0].policy).not.toBeNull();
    expect(schema[0].policy?.requiredScopes).toEqual(["settings.write"]);
  });
});
