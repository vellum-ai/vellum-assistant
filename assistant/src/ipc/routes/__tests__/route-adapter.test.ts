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
    policy: null,
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

describe("routeDefinitionsToIpcMethods — policy serialization", () => {
  test("routes with policy: null ship policy: null", async () => {
    // Unprotected route (e.g. health endpoint) carries policy: null
    // and the adapter passes it through unchanged.
    const routes: RouteDefinition[] = [
      defineRoute({
        operationId: "z",
        endpoint: "unprotected_endpoint",
        policy: null,
      }),
    ];
    const schema = await getSchema(routes);
    expect(schema[0].policy).toBeNull();
  });

  test("routes with declared policy ship it verbatim", async () => {
    // The adapter is now a straight pass-through: whatever policy the
    // RouteDefinition declares, the wire schema reflects.
    const routes: RouteDefinition[] = [
      defineRoute({
        operationId: "m_get",
        endpoint: "messages",
        method: "GET",
        policy: {
          requiredScopes: ["chat.read"],
          allowedPrincipalTypes: [
            "actor",
            "svc_gateway",
            "svc_daemon",
            "local",
          ],
        },
      }),
      defineRoute({
        operationId: "m_post",
        endpoint: "messages",
        method: "POST",
        policy: {
          requiredScopes: ["chat.write"],
          allowedPrincipalTypes: [
            "actor",
            "svc_gateway",
            "svc_daemon",
            "local",
          ],
        },
      }),
    ];
    const schema = await getSchema(routes);
    expect(schema[0].policy?.requiredScopes).toEqual(["chat.read"]);
    expect(schema[1].policy?.requiredScopes).toEqual(["chat.write"]);
  });

  test("schema is a structural pass-through (no derivation, no lookup)", async () => {
    // Sibling routes with the same endpoint+different policy don't
    // collide — each route's own .policy is used verbatim, exactly
    // the property-on-entity guarantee ATL-315's followup buys us.
    const routes: RouteDefinition[] = [
      defineRoute({
        operationId: "plugins_install",
        endpoint: "plugins/:name",
        method: "POST",
        policy: {
          requiredScopes: ["settings.write"],
          allowedPrincipalTypes: [
            "actor",
            "svc_gateway",
            "svc_daemon",
            "local",
          ],
        },
      }),
      defineRoute({
        operationId: "plugins_uninstall",
        endpoint: "plugins/:name",
        method: "DELETE",
        policy: {
          requiredScopes: ["settings.write"],
          allowedPrincipalTypes: [
            "actor",
            "svc_gateway",
            "svc_daemon",
            "local",
          ],
        },
      }),
    ];
    const schema = await getSchema(routes);
    expect(schema[0].policy?.requiredScopes).toEqual(["settings.write"]);
    expect(schema[1].policy?.requiredScopes).toEqual(["settings.write"]);
  });
});
