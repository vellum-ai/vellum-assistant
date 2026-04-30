/**
 * Unit tests for the trust rule IPC proxy routes.
 *
 * Covers:
 * - trust_rules_list: no params, tool filter, include_all, origin filter
 * - error path: non-OK gateway response surfaces body .error message
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — must be defined before importing the module under test
// ---------------------------------------------------------------------------

mock.module("../../config/env.js", () => ({
  getGatewayInternalBaseUrl: () => "http://localhost:7822",
}));

type MockResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

let mockFetchResponse: MockResponse = {
  ok: true,
  status: 200,
  json: async () => ({ rules: [] }),
};

let capturedFetchCalls: Array<{ url: string; init?: RequestInit }> = [];

const mockFetch = mock(async (url: string, init?: RequestInit) => {
  capturedFetchCalls.push({ url, init });
  return mockFetchResponse;
});

global.fetch = mockFetch as unknown as typeof fetch;

// ---------------------------------------------------------------------------
// Import module under test AFTER mocks are set up
// ---------------------------------------------------------------------------

import { ROUTES as trustRuleRoutes } from "../../runtime/routes/trust-rules-routes.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findRoute(method: string) {
  const route = trustRuleRoutes.find((r) => r.operationId === method);
  if (!route) throw new Error(`Route not found: ${method}`);
  return route;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("trustRuleRoutes", () => {
  beforeEach(() => {
    capturedFetchCalls = [];
    mockFetchResponse = {
      ok: true,
      status: 200,
      json: async () => ({ rules: [] }),
    };
    mockFetch.mockClear();
  });

  describe("trust_rules_list", () => {
    test("no params → GET /v1/trust-rules (no query string)", async () => {
      const route = findRoute("trust_rules_list");
      await route.handler({ body: {} });

      expect(capturedFetchCalls).toHaveLength(1);
      expect(capturedFetchCalls[0].url).toBe(
        "http://localhost:7822/v1/trust-rules",
      );
      expect(capturedFetchCalls[0].init).toBeUndefined();
    });

    test("{ tool: 'bash' } → appends ?tool=bash", async () => {
      const route = findRoute("trust_rules_list");
      await route.handler({ body: { tool: "bash" } });

      expect(capturedFetchCalls[0].url).toBe(
        "http://localhost:7822/v1/trust-rules?tool=bash",
      );
    });

    test("{ include_all: true } → appends ?include_all=true", async () => {
      const route = findRoute("trust_rules_list");
      await route.handler({ body: { include_all: true } });

      expect(capturedFetchCalls[0].url).toBe(
        "http://localhost:7822/v1/trust-rules?include_all=true",
      );
    });

    test("{ origin: 'user_defined' } → appends ?origin=user_defined", async () => {
      const route = findRoute("trust_rules_list");
      await route.handler({ body: { origin: "user_defined" } });

      expect(capturedFetchCalls[0].url).toBe(
        "http://localhost:7822/v1/trust-rules?origin=user_defined",
      );
    });
  });

  describe("error path", () => {
    test("non-OK response surfaces body .error message", async () => {
      mockFetchResponse = {
        ok: false,
        status: 404,
        json: async () => ({ error: "Not found" }),
      };

      const route = findRoute("trust_rules_list");
      await expect(route.handler({ body: {} })).rejects.toThrow("Not found");
    });
  });
});
