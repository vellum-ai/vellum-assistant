import { beforeEach, describe, expect, mock, test } from "bun:test";

// Toggle for the share_analytics opt-out the real store consults. The store
// module is intentionally NOT mocked here — it has its own DB-backed tests, and
// Bun's `mock.module` is process-global, so mocking it would leak into those
// tests when files share an invocation. Exercising the real store keeps every
// auth-fallback test order-independent.
let shareAnalytics = true;

mock.module("../platform/consent-cache.js", () => ({
  getCachedShareAnalytics: () => shareAnalytics,
}));

// The watchdog relay must go through the direct (unbuffered) emit; capture the
// forwarded arguments instead of POSTing to the platform.
const emitCalls: {
  checkName: string;
  detail: Record<string, unknown> | null;
  value: number | null;
}[] = [];
mock.module("../telemetry/watchdog-direct-emit.js", () => ({
  emitWatchdogEventDirect: async (
    checkName: string,
    detail: Record<string, unknown> | null,
    value: number | null = null,
  ) => {
    emitCalls.push({ checkName, detail, value });
  },
}));

import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { authFallbackEvents } from "../persistence/schema/index.js";
import { GATEWAY_PRINCIPALS } from "../runtime/auth/route-policy.js";
import { RouteError } from "../runtime/routes/errors.js";
import { ROUTES } from "../runtime/routes/internal-telemetry-routes.js";
import type { RouteHandlerArgs } from "../runtime/routes/types.js";
import { queryUnreportedAuthFallbackEvents } from "../security/auth-fallback-events-store.js";

await initializeDb();

const route = ROUTES.find(
  (r) => r.operationId === "internal_telemetry_auth_fallback",
);

function call(body: unknown) {
  if (!route) throw new Error("route not found");
  return route.handler({ body } as RouteHandlerArgs);
}

const VALID_BODY = {
  window_start: 1000,
  window_end: 2000,
  counts: [
    {
      guard: "edge",
      path: "/v1/messages",
      failure_kind: "missing_authorization",
      count: 5,
    },
  ],
};

describe("internal-telemetry-routes: auth-fallback", () => {
  beforeEach(() => {
    shareAnalytics = true;
    getDb().delete(authFallbackEvents).run();
  });

  test("route is locked to service-token callers (GATEWAY_PRINCIPALS + internal.write)", () => {
    expect(route).toBeDefined();
    expect(route?.endpoint).toBe("internal/telemetry/auth-fallback");
    expect(route?.method).toBe("POST");
    expect(route?.policy?.allowedPrincipalTypes).toEqual(GATEWAY_PRINCIPALS);
    expect(route?.policy?.requiredScopes).toEqual(["internal.write"]);
  });

  test("valid batch is persisted with snake_case → camelCase mapping", () => {
    const result = call(VALID_BODY);
    expect(result).toEqual({ recorded: 1 });

    const rows = queryUnreportedAuthFallbackEvents(0, undefined, 100);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      guard: "edge",
      path: "/v1/messages",
      failureKind: "missing_authorization",
      count: 5,
      windowStart: 1000,
      windowEnd: 2000,
    });
  });

  test("returns skipped and persists nothing under the opt-out", () => {
    shareAnalytics = false;
    expect(call(VALID_BODY)).toEqual({ skipped: true });
    expect(queryUnreportedAuthFallbackEvents(0, undefined, 100).length).toBe(0);
  });

  test("rejects a malformed body without persisting", () => {
    expect(() => call({ window_start: 1000 })).toThrow(RouteError);
    expect(() => call({ ...VALID_BODY, counts: [] })).toThrow(RouteError);
    expect(() =>
      call({
        ...VALID_BODY,
        counts: [{ guard: "edge", path: "/x", failure_kind: "y", count: 0 }],
      }),
    ).toThrow(RouteError);
    expect(queryUnreportedAuthFallbackEvents(0, undefined, 100).length).toBe(0);
  });
});

describe("internal-telemetry-routes: watchdog relay", () => {
  const watchdogRoute = ROUTES.find(
    (r) => r.operationId === "internal_telemetry_watchdog",
  );

  function callWatchdog(body: unknown) {
    if (!watchdogRoute) {
      throw new Error("route not found");
    }
    return watchdogRoute.handler({ body } as RouteHandlerArgs);
  }

  beforeEach(() => {
    emitCalls.length = 0;
  });

  test("route is locked to service-token callers (GATEWAY_PRINCIPALS + internal.write)", () => {
    expect(watchdogRoute).toBeDefined();
    expect(watchdogRoute?.endpoint).toBe("internal/telemetry/watchdog");
    expect(watchdogRoute?.method).toBe("POST");
    expect(watchdogRoute?.policy?.allowedPrincipalTypes).toEqual(
      GATEWAY_PRINCIPALS,
    );
    expect(watchdogRoute?.policy?.requiredScopes).toEqual(["internal.write"]);
  });

  test("valid event is forwarded to the direct emit", async () => {
    const result = await callWatchdog({
      check_name: "gateway_guardian_missing",
      detail: { has_contacts: true, has_actor_tokens: false },
    });
    expect(result).toEqual({ ok: true });
    expect(emitCalls).toEqual([
      {
        checkName: "gateway_guardian_missing",
        detail: { has_contacts: true, has_actor_tokens: false },
        value: null,
      },
    ]);
  });

  test("detail and value are optional", async () => {
    await callWatchdog({ check_name: "some_check" });
    expect(emitCalls).toEqual([
      { checkName: "some_check", detail: null, value: null },
    ]);
  });

  test("rejects a malformed body without emitting", async () => {
    await expect(callWatchdog({})).rejects.toThrow(RouteError);
    await expect(callWatchdog({ check_name: "" })).rejects.toThrow(RouteError);
    expect(emitCalls.length).toBe(0);
  });
});
