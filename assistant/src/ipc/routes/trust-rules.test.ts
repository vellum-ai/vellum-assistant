/**
 * Unit tests for the trust rule IPC proxy routes.
 *
 * Covers:
 * - trust_rules_list: no params, tool filter, include_all, origin filter
 * - trust_rules_create: correct POST URL and JSON body
 * - trust_rules_update: PATCH URL, partial body, throws when id missing
 * - trust_rules_remove: DELETE URL, throws when id missing
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

  describe("trust_rules_create", () => {
    test("POSTs to /v1/trust-rules with correct JSON body", async () => {
      mockFetchResponse = {
        ok: true,
        status: 201,
        json: async () => ({ rule: { id: "rule-1" } }),
      };

      const route = findRoute("trust_rules_create");
      await route.handler({ body: {
        tool: "bash",
        pattern: "rm -rf *",
        risk: "high",
        description: "Dangerous remove",
      } });

      expect(capturedFetchCalls).toHaveLength(1);
      const call = capturedFetchCalls[0];
      expect(call.url).toBe("http://localhost:7822/v1/trust-rules");
      expect(call.init?.method).toBe("POST");
      expect((call.init?.headers as Record<string, string>)["Content-Type"]).toBe(
        "application/json",
      );
      const body = JSON.parse(call.init?.body as string) as Record<
        string,
        unknown
      >;
      expect(body).toEqual({
        tool: "bash",
        pattern: "rm -rf *",
        risk: "high",
        description: "Dangerous remove",
      });
    });
  });

  describe("trust_rules_update", () => {
    test("PATCHes /v1/trust-rules/abc-123", async () => {
      const route = findRoute("trust_rules_update");
      await route.handler({ body: { id: "abc-123", risk: "low", description: "Safe" } });

      expect(capturedFetchCalls).toHaveLength(1);
      const call = capturedFetchCalls[0];
      expect(call.url).toBe("http://localhost:7822/v1/trust-rules/abc-123");
      expect(call.init?.method).toBe("PATCH");
    });

    test("body contains only fields present in params (partial update)", async () => {
      const route = findRoute("trust_rules_update");
      await route.handler({ body: { id: "abc-123", risk: "low" } });

      const body = JSON.parse(
        capturedFetchCalls[0].init?.body as string,
      ) as Record<string, unknown>;
      expect(body.risk).toBe("low");
      expect("description" in body).toBe(false);
    });

    test("throws when id is missing", async () => {
      const route = findRoute("trust_rules_update");
      await expect(
        route.handler({ body: { risk: "low" } }),
      ).rejects.toThrow("id is required");
    });

    test("throws when id is empty string", async () => {
      const route = findRoute("trust_rules_update");
      await expect(
        route.handler({ body: { id: "", risk: "low" } }),
      ).rejects.toThrow("id is required");
    });
  });

  describe("trust_rules_remove", () => {
    test("DELETEs /v1/trust-rules/abc-123", async () => {
      const route = findRoute("trust_rules_remove");
      await route.handler({ body: { id: "abc-123" } });

      expect(capturedFetchCalls).toHaveLength(1);
      const call = capturedFetchCalls[0];
      expect(call.url).toBe("http://localhost:7822/v1/trust-rules/abc-123");
      expect(call.init?.method).toBe("DELETE");
    });

    test("throws when id is missing", async () => {
      const route = findRoute("trust_rules_remove");
      await expect(
        route.handler({ body: {} }),
      ).rejects.toThrow("id is required");
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
