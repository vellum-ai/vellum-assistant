/**
 * Unit tests for the gateway_logs_tail IPC route handler.
 *
 * Covers:
 * - Happy path: all params → correct URL with querystring
 * - All params absent → URL with no querystring
 * - Only n provided → querystring has only n
 * - Gateway returns 500 with error body → Error thrown with error message
 * - level: "INVALID" → ZodError (no gateway call)
 * - n: 0 → ZodError (min 1 violation)
 * - n: 1001 → ZodError (max 1000 violation)
 * - module: "" → accepted (empty string passes zod string validation)
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { ZodError } from "zod";

// ---------------------------------------------------------------------------
// Mocks — must be defined before importing the module under test
// ---------------------------------------------------------------------------

mock.module("../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../../../config/env.js", () => ({
  getGatewayInternalBaseUrl: () => "http://localhost:9999",
}));

// ---------------------------------------------------------------------------
// Import the module under test AFTER mocks are set up
// ---------------------------------------------------------------------------

import { ROUTES } from "../gateway-log-routes.js";

const gatewayLogsTailRoute = ROUTES.find(
  (r) => r.operationId === "gateway_logs_tail",
)!;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFetchMock(
  status: number,
  body: unknown,
): ReturnType<typeof mock> {
  return mock(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("gateway_logs_tail route", () => {
  beforeEach(() => {
    // Reset global fetch to avoid cross-test contamination
    globalThis.fetch = undefined as unknown as typeof fetch;
  });

  test("route is registered with correct operationId, method, and endpoint", () => {
    expect(gatewayLogsTailRoute).toBeDefined();
    expect(gatewayLogsTailRoute.operationId).toBe("gateway_logs_tail");
    expect(gatewayLogsTailRoute.method).toBe("GET");
    expect(gatewayLogsTailRoute.endpoint).toBe("gateway/logs/tail");
  });

  describe("happy path — all params provided via body", () => {
    test("calls gateway with correct URL including all query params", async () => {
      const mockFetch = makeFetchMock(200, { entries: [] });
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      await gatewayLogsTailRoute.handler({
        body: { n: 5, level: "warn", module: "mcp" },
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const calledUrl = (mockFetch.mock.calls[0] as [string])[0];
      expect(calledUrl).toBe(
        "http://localhost:9999/v1/logs/tail?n=5&level=warn&module=mcp",
      );
    });

    test("returns the parsed response body", async () => {
      const responseBody = { entries: [{ msg: "hello", level: 40 }] };
      globalThis.fetch = makeFetchMock(200, responseBody) as unknown as typeof fetch;

      const result = await gatewayLogsTailRoute.handler({
        body: { n: 5, level: "warn", module: "mcp" },
      });

      expect(result).toEqual(responseBody);
    });
  });

  describe("all params absent", () => {
    test("calls gateway URL with no querystring when body is empty", async () => {
      const mockFetch = makeFetchMock(200, { entries: [] });
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      await gatewayLogsTailRoute.handler({ body: {} });

      const calledUrl = (mockFetch.mock.calls[0] as [string])[0];
      expect(calledUrl).toBe("http://localhost:9999/v1/logs/tail");
    });

    test("calls gateway URL with no querystring when no args provided", async () => {
      const mockFetch = makeFetchMock(200, { entries: [] });
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      await gatewayLogsTailRoute.handler({});

      const calledUrl = (mockFetch.mock.calls[0] as [string])[0];
      expect(calledUrl).toBe("http://localhost:9999/v1/logs/tail");
    });
  });

  describe("only n provided", () => {
    test("querystring contains only n — no spurious level or module keys", async () => {
      const mockFetch = makeFetchMock(200, { entries: [] });
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      await gatewayLogsTailRoute.handler({ body: { n: 5 } });

      const calledUrl = (mockFetch.mock.calls[0] as [string])[0];
      expect(calledUrl).toBe("http://localhost:9999/v1/logs/tail?n=5");
      expect(calledUrl).not.toContain("level");
      expect(calledUrl).not.toContain("module");
    });
  });

  describe("gateway error handling", () => {
    test("gateway 500 with { error: 'disk error' } throws Error with that message", async () => {
      globalThis.fetch = makeFetchMock(500, {
        error: "disk error",
      }) as unknown as typeof fetch;

      await expect(
        gatewayLogsTailRoute.handler({ body: {} }),
      ).rejects.toThrow("disk error");
    });

    test("gateway 500 with non-string error falls back to generic message", async () => {
      globalThis.fetch = makeFetchMock(500, {
        error: { nested: true },
      }) as unknown as typeof fetch;

      await expect(
        gatewayLogsTailRoute.handler({ body: {} }),
      ).rejects.toThrow("Gateway request failed (500)");
    });

    test("gateway 500 with unparseable JSON falls back to generic message", async () => {
      globalThis.fetch = mock(async () => ({
        ok: false,
        status: 500,
        json: async () => {
          throw new SyntaxError("Unexpected token");
        },
      })) as unknown as typeof fetch;

      await expect(
        gatewayLogsTailRoute.handler({ body: {} }),
      ).rejects.toThrow("Gateway request failed (500)");
    });
  });

  describe("zod validation", () => {
    test("level: 'INVALID' is rejected with ZodError before calling gateway", async () => {
      const mockFetch = makeFetchMock(200, {});
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      await expect(
        gatewayLogsTailRoute.handler({
          body: { level: "INVALID" },
        }),
      ).rejects.toBeInstanceOf(ZodError);

      expect(mockFetch).not.toHaveBeenCalled();
    });

    test("n: 0 is rejected with ZodError (min 1 violation)", async () => {
      const mockFetch = makeFetchMock(200, {});
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      await expect(
        gatewayLogsTailRoute.handler({ body: { n: 0 } }),
      ).rejects.toBeInstanceOf(ZodError);

      expect(mockFetch).not.toHaveBeenCalled();
    });

    test("n: 1001 is rejected with ZodError (max 1000 violation)", async () => {
      const mockFetch = makeFetchMock(200, {});
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      await expect(
        gatewayLogsTailRoute.handler({ body: { n: 1001 } }),
      ).rejects.toBeInstanceOf(ZodError);

      expect(mockFetch).not.toHaveBeenCalled();
    });

    test("module: '' is accepted (empty string passes zod string validation)", async () => {
      const mockFetch = makeFetchMock(200, { entries: [] });
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      await expect(
        gatewayLogsTailRoute.handler({ body: { module: "" } }),
      ).resolves.toBeDefined();

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("queryParams source (HTTP GET path)", () => {
    test("uses queryParams when provided (HTTP GET path) — string params", async () => {
      const mockFetch = makeFetchMock(200, { entries: [] });
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      // When queryParams has values, those take precedence over body.
      // Only string-valued params (level, module) are valid from the HTTP layer;
      // n is numeric and must come via IPC body.
      await gatewayLogsTailRoute.handler({
        queryParams: { level: "info", module: "cors" },
        body: {},
      });

      const calledUrl = (mockFetch.mock.calls[0] as [string])[0];
      expect(calledUrl).toContain("level=info");
      expect(calledUrl).toContain("module=cors");
    });
  });
});
