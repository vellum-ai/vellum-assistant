/**
 * Unit tests for the trust rule IPC proxy routes.
 *
 * Covers:
 * - trust_rules_list: no params, tool filter, include_all, origin filter
 * - trust_rules_create: POSTs body to /v1/trust-rules
 * - trust_rules_update: PATCH /v1/trust-rules/:id with body, id encoded
 * - trust_rules_delete: DELETE /v1/trust-rules/:id, id encoded
 * - trust_rules_reset: POST /v1/trust-rules/:id/reset
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
    test("POST /v1/trust-rules with body forwarded as JSON", async () => {
      mockFetchResponse = {
        ok: true,
        status: 201,
        json: async () => ({ rule: { id: "r1" } }),
      };

      const route = findRoute("trust_rules_create");
      await route.handler({
        body: {
          tool: "bash",
          pattern: "ls",
          risk: "low",
          description: "list files",
        },
      });

      expect(capturedFetchCalls).toHaveLength(1);
      expect(capturedFetchCalls[0].url).toBe(
        "http://localhost:7822/v1/trust-rules",
      );
      expect(capturedFetchCalls[0].init?.method).toBe("POST");
      expect(capturedFetchCalls[0].init?.headers).toEqual({
        "Content-Type": "application/json",
      });
      expect(capturedFetchCalls[0].init?.body).toBe(
        JSON.stringify({
          tool: "bash",
          pattern: "ls",
          risk: "low",
          description: "list files",
        }),
      );
    });

    test("forwards extra fields (e.g. scope) untouched", async () => {
      mockFetchResponse = {
        ok: true,
        status: 201,
        json: async () => ({ rule: {} }),
      };

      const route = findRoute("trust_rules_create");
      await route.handler({
        body: { tool: "bash", pattern: "ls", scope: "everywhere" },
      });

      const sent = JSON.parse(
        capturedFetchCalls[0].init?.body as string,
      );
      expect(sent.scope).toBe("everywhere");
    });
  });

  describe("trust_rules_update", () => {
    test("PATCH /v1/trust-rules/:id with body forwarded", async () => {
      mockFetchResponse = {
        ok: true,
        status: 200,
        json: async () => ({ rule: { id: "r1" } }),
      };

      const route = findRoute("trust_rules_update");
      await route.handler({
        pathParams: { id: "rule-123" },
        body: { risk: "medium" },
      });

      expect(capturedFetchCalls[0].url).toBe(
        "http://localhost:7822/v1/trust-rules/rule-123",
      );
      expect(capturedFetchCalls[0].init?.method).toBe("PATCH");
      expect(capturedFetchCalls[0].init?.body).toBe(
        JSON.stringify({ risk: "medium" }),
      );
    });

    test("URL-encodes id with reserved characters", async () => {
      mockFetchResponse = {
        ok: true,
        status: 200,
        json: async () => ({ rule: {} }),
      };

      const route = findRoute("trust_rules_update");
      await route.handler({
        pathParams: { id: "weird/id with space" },
        body: {},
      });

      expect(capturedFetchCalls[0].url).toBe(
        "http://localhost:7822/v1/trust-rules/weird%2Fid%20with%20space",
      );
    });

    test("missing id throws", async () => {
      const route = findRoute("trust_rules_update");
      await expect(
        route.handler({ pathParams: {}, body: {} }),
      ).rejects.toThrow("Missing rule id");
    });
  });

  describe("trust_rules_delete", () => {
    test("DELETE /v1/trust-rules/:id, no body", async () => {
      mockFetchResponse = {
        ok: true,
        status: 200,
        json: async () => ({ success: true }),
      };

      const route = findRoute("trust_rules_delete");
      await route.handler({ pathParams: { id: "rule-xyz" } });

      expect(capturedFetchCalls[0].url).toBe(
        "http://localhost:7822/v1/trust-rules/rule-xyz",
      );
      expect(capturedFetchCalls[0].init?.method).toBe("DELETE");
      expect(capturedFetchCalls[0].init?.body).toBeUndefined();
    });

    test("missing id throws", async () => {
      const route = findRoute("trust_rules_delete");
      await expect(route.handler({ pathParams: {} })).rejects.toThrow(
        "Missing rule id",
      );
    });
  });

  describe("trust_rules_reset", () => {
    test("POST /v1/trust-rules/:id/reset, no body", async () => {
      mockFetchResponse = {
        ok: true,
        status: 200,
        json: async () => ({ rule: {} }),
      };

      const route = findRoute("trust_rules_reset");
      await route.handler({ pathParams: { id: "default-ls" } });

      expect(capturedFetchCalls[0].url).toBe(
        "http://localhost:7822/v1/trust-rules/default-ls/reset",
      );
      expect(capturedFetchCalls[0].init?.method).toBe("POST");
      expect(capturedFetchCalls[0].init?.body).toBeUndefined();
    });

    test("uses shared 'trust-rules' policy key (not 'trust-rules/reset')", () => {
      const route = findRoute("trust_rules_reset");
      expect(route.policyKey).toBe("trust-rules");
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

    test("non-OK on create surfaces gateway error", async () => {
      mockFetchResponse = {
        ok: false,
        status: 400,
        json: async () => ({ error: '"risk" must be one of: low, medium, high' }),
      };

      const route = findRoute("trust_rules_create");
      await expect(
        route.handler({
          body: { tool: "bash", pattern: "ls", risk: "extreme" },
        }),
      ).rejects.toThrow('"risk" must be one of: low, medium, high');
    });
  });
});
