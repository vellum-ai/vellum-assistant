import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

const mockRecordAuthFallbackCounts = mock<
  (windowStart: number, windowEnd: number, counts: unknown[]) => number
>(() => 0);

mock.module("../memory/auth-fallback-events-store.js", () => ({
  recordAuthFallbackCounts: mockRecordAuthFallbackCounts,
}));

import { GATEWAY_PRINCIPALS } from "../runtime/auth/route-policy.js";
import { RouteError } from "../runtime/routes/errors.js";
import { ROUTES } from "../runtime/routes/internal-telemetry-routes.js";
import type { RouteHandlerArgs } from "../runtime/routes/types.js";

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
    mockRecordAuthFallbackCounts.mockReset();
    mockRecordAuthFallbackCounts.mockReturnValue(1);
  });

  test("route is locked to service-token callers (GATEWAY_PRINCIPALS + internal.write)", () => {
    expect(route).toBeDefined();
    expect(route?.endpoint).toBe("internal/telemetry/auth-fallback");
    expect(route?.method).toBe("POST");
    expect(route?.policy?.allowedPrincipalTypes).toEqual(GATEWAY_PRINCIPALS);
    expect(route?.policy?.requiredScopes).toEqual(["internal.write"]);
  });

  test("valid batch is recorded with snake_case → camelCase mapping", () => {
    mockRecordAuthFallbackCounts.mockReturnValue(1);
    const result = call(VALID_BODY);
    expect(result).toEqual({ recorded: 1 });
    expect(mockRecordAuthFallbackCounts).toHaveBeenCalledTimes(1);
    const [windowStart, windowEnd, counts] =
      mockRecordAuthFallbackCounts.mock.calls[0];
    expect(windowStart).toBe(1000);
    expect(windowEnd).toBe(2000);
    expect(counts).toEqual([
      {
        guard: "edge",
        path: "/v1/messages",
        failureKind: "missing_authorization",
        count: 5,
      },
    ]);
  });

  test("returns skipped when the store drops counts (opt-out)", () => {
    mockRecordAuthFallbackCounts.mockReturnValue(0);
    expect(call(VALID_BODY)).toEqual({ skipped: true });
  });

  test("rejects a malformed body", () => {
    expect(() => call({ window_start: 1000 })).toThrow(RouteError);
    expect(() => call({ ...VALID_BODY, counts: [] })).toThrow(RouteError);
    expect(() =>
      call({
        ...VALID_BODY,
        counts: [{ guard: "edge", path: "/x", failure_kind: "y", count: 0 }],
      }),
    ).toThrow(RouteError);
    expect(mockRecordAuthFallbackCounts).not.toHaveBeenCalled();
  });
});
