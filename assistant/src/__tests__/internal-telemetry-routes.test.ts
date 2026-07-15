import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

import type { ConsentState } from "../platform/consent-cache.js";

// Toggle for the share_analytics consent the real store consults. The store
// module is intentionally NOT mocked here — it has its own DB-backed tests, and
// Bun's `mock.module` is process-global, so mocking it would leak into those
// tests when files share an invocation. Exercising the real store keeps every
// auth-fallback test order-independent.
let shareAnalytics: ConsentState = true;

mock.module("../platform/consent-cache.js", () => ({
  getCachedShareAnalytics: () => shareAnalytics === true,
  getRawShareAnalytics: () => shareAnalytics,
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

import * as dbConnection from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { GATEWAY_PRINCIPALS } from "../runtime/auth/route-policy.js";
import {
  RouteError,
  ServiceUnavailableError,
} from "../runtime/routes/errors.js";
import { ROUTES } from "../runtime/routes/internal-telemetry-routes.js";
import type { RouteHandlerArgs } from "../runtime/routes/types.js";
import {
  discardPendingTelemetryOutboxEvents,
  queryTelemetryOutboxBatch,
} from "../telemetry/telemetry-events-outbox.js";
import type { AuthFallbackTelemetryEvent } from "../telemetry/types.js";

await initializeDb();

function pendingAuthFallbackPayloads(): AuthFallbackTelemetryEvent[] {
  return queryTelemetryOutboxBatch("auth_fallback", 100).map(
    (r) => JSON.parse(r.payload) as AuthFallbackTelemetryEvent,
  );
}

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
    discardPendingTelemetryOutboxEvents("auth_fallback");
  });

  test("route is locked to service-token callers (GATEWAY_PRINCIPALS + internal.write)", () => {
    expect(route).toBeDefined();
    expect(route?.endpoint).toBe("internal/telemetry/auth-fallback");
    expect(route?.method).toBe("POST");
    expect(route?.policy?.allowedPrincipalTypes).toEqual(GATEWAY_PRINCIPALS);
    expect(route?.policy?.requiredScopes).toEqual(["internal.write"]);
  });

  test("valid batch is persisted to the outbox as a wire auth_fallback event", () => {
    const result = call(VALID_BODY);
    expect(result).toEqual({ recorded: 1 });

    const payloads = pendingAuthFallbackPayloads();
    expect(payloads.length).toBe(1);
    expect(payloads[0]).toMatchObject({
      type: "auth_fallback",
      guard: "edge",
      path: "/v1/messages",
      failure_kind: "missing_authorization",
      count: 5,
      window_start: 1000,
      window_end: 2000,
    });
  });

  test("returns skipped and persists nothing under a confirmed opt-out", () => {
    shareAnalytics = false;
    expect(call(VALID_BODY)).toEqual({ skipped: true });
    expect(pendingAuthFallbackPayloads().length).toBe(0);
  });

  test("records the batch while consent is unknown (a cold cache never drops data)", () => {
    shareAnalytics = "unknown";
    expect(call(VALID_BODY)).toEqual({ recorded: 1 });
    expect(pendingAuthFallbackPayloads().length).toBe(1);
  });

  test("throws 503 when consent is on but the telemetry DB is unavailable, so the gateway re-queues", () => {
    const spy = spyOn(dbConnection, "getTelemetryDb").mockReturnValue(null);
    try {
      expect(() => call(VALID_BODY)).toThrow(ServiceUnavailableError);
    } finally {
      spy.mockRestore();
    }
    expect(pendingAuthFallbackPayloads().length).toBe(0);

    // Once the DB is back the same batch records normally.
    expect(call(VALID_BODY)).toEqual({ recorded: 1 });
  });

  test("throws 503 (not skipped) when consent is unknown and the telemetry DB is unavailable", () => {
    shareAnalytics = "unknown";
    const spy = spyOn(dbConnection, "getTelemetryDb").mockReturnValue(null);
    try {
      expect(() => call(VALID_BODY)).toThrow(ServiceUnavailableError);
    } finally {
      spy.mockRestore();
    }
    expect(pendingAuthFallbackPayloads().length).toBe(0);
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
    expect(pendingAuthFallbackPayloads().length).toBe(0);
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
