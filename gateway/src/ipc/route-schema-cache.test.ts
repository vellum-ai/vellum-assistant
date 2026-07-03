/**
 * Tests for the route schema cache — focused on the policy-shape
 * validation that makes ATL-315's fix structural.
 *
 * The cache is the gateway's only source of policy on the IPC proxy
 * path now. If a daemon ships a schema missing the `policy` field, the
 * cache must refuse to load it (rather than silently allow open IPC
 * proxying).
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import "../__tests__/test-preload.js";

// ---------------------------------------------------------------------------
// Mock IPC client — controls what `get_route_schema` returns per test.
// ---------------------------------------------------------------------------

let nextSchema: unknown = [];

const ipcCallAssistantMock = mock(
  (method: string, _params?: Record<string, unknown>): Promise<unknown> => {
    if (method === "get_route_schema") return Promise.resolve(nextSchema);
    return Promise.resolve({ ok: true });
  },
);

// Spread the actual module so the real IpcHandlerError/IpcTransportError
// classes (and untouched exports like ipcSuggestTrustRule) stay importable by
// later-loaded files when suites share a bun process.
const actualAssistantClient = await import("./assistant-client.js");
mock.module("./assistant-client.js", () => ({
  ...actualAssistantClient,
  ipcCallAssistant: ipcCallAssistantMock,
}));

const {
  refreshRouteSchema,
  matchRoute,
  getCachedRoutePolicy,
  getCachedRouteCount,
} = await import("./route-schema-cache.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setSchema(schema: unknown) {
  nextSchema = schema;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("refreshRouteSchema — happy path", () => {
  beforeEach(() => {
    ipcCallAssistantMock.mockClear();
  });

  test("loads a valid schema with policy: null and policy: {...} entries", async () => {
    setSchema([
      {
        operationId: "health",
        endpoint: "health",
        method: "GET",
        policy: null,
      },
      {
        operationId: "settings_get",
        endpoint: "settings",
        method: "GET",
        policy: {
          requiredScopes: ["settings.read"],
          allowedPrincipalTypes: ["actor", "svc_gateway"],
        },
      },
    ]);

    const ok = await refreshRouteSchema();
    expect(ok).toBe(true);
    expect(getCachedRouteCount()).toBe(2);
    expect(matchRoute("GET", "health")).toBeDefined();
    expect(matchRoute("GET", "settings")).toBeDefined();
  });
});

describe("refreshRouteSchema — validation fails closed", () => {
  beforeEach(() => {
    ipcCallAssistantMock.mockClear();
  });

  test("rejects a schema entry missing the `policy` field (old daemon)", async () => {
    // Prime cache with a valid entry first so we can detect that the
    // bad refresh didn't clobber it.
    setSchema([
      {
        operationId: "health",
        endpoint: "health",
        method: "GET",
        policy: null,
      },
    ]);
    expect(await refreshRouteSchema()).toBe(true);
    expect(getCachedRouteCount()).toBe(1);

    // Now ship a schema that omits `policy` — that's what an old daemon
    // would produce before this PR. The cache must refuse to swap.
    setSchema([
      { operationId: "settings_get", endpoint: "settings", method: "GET" },
    ]);
    const ok = await refreshRouteSchema();
    expect(ok).toBe(false);
    // Cache retains the previous (valid) state — does NOT silently drop
    // to the bad schema.
    expect(getCachedRouteCount()).toBe(1);
    expect(matchRoute("GET", "settings")).toBeUndefined();
  });

  test("rejects entries with wrong-typed `policy` fields", async () => {
    setSchema([
      {
        operationId: "settings_get",
        endpoint: "settings",
        method: "GET",
        // requiredScopes should be an array; pass a non-array to trigger
        // Zod validation failure.
        policy: { requiredScopes: "settings.read", allowedPrincipalTypes: [] },
      },
    ]);
    const ok = await refreshRouteSchema();
    expect(ok).toBe(false);
  });

  test("rejects a non-array top-level payload", async () => {
    setSchema({ not: "an array" });
    const ok = await refreshRouteSchema();
    expect(ok).toBe(false);
  });
});

describe("getCachedRoutePolicy", () => {
  beforeEach(() => {
    ipcCallAssistantMock.mockClear();
  });

  test("returns the policy object for protected routes", async () => {
    setSchema([
      {
        operationId: "settings_get",
        endpoint: "settings",
        method: "GET",
        policy: {
          requiredScopes: ["settings.read"],
          allowedPrincipalTypes: ["actor"],
        },
      },
    ]);
    expect(await refreshRouteSchema()).toBe(true);

    const policy = getCachedRoutePolicy("settings_get");
    expect(policy).not.toBeNull();
    expect(policy).not.toBeUndefined();
    expect(policy!.requiredScopes).toEqual(["settings.read"]);
    expect(policy!.allowedPrincipalTypes).toEqual(["actor"]);
  });

  test("returns null for routes the daemon declared as unprotected", async () => {
    setSchema([
      {
        operationId: "health",
        endpoint: "health",
        method: "GET",
        policy: null,
      },
    ]);
    expect(await refreshRouteSchema()).toBe(true);

    // `null` here is meaningful — daemon explicitly opted out of
    // enforcement; the proxy should proceed without policy checks.
    expect(getCachedRoutePolicy("health")).toBeNull();
  });

  test("returns undefined for unknown operationIds (defensive — should never happen post-matchRoute)", async () => {
    setSchema([
      {
        operationId: "health",
        endpoint: "health",
        method: "GET",
        policy: null,
      },
    ]);
    expect(await refreshRouteSchema()).toBe(true);

    // Distinguishing `undefined` from `null` is intentional: callers
    // treat `undefined` as "schema doesn't know this op" → fail-closed,
    // and `null` as "schema says open" → proceed.
    expect(getCachedRoutePolicy("nonexistent")).toBeUndefined();
  });
});
