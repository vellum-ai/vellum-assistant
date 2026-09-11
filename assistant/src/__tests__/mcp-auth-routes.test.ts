import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Module mocks (must precede imports) ───────────────────────────────────────

const mockReloadMcpServers = mock(async () => ({ success: true }));

mock.module("../daemon/mcp-reload-service.js", () => ({
  reloadMcpServers: () => mockReloadMcpServers(),
}));

const mockOrchestrateConnect = mock(
  async (_args: { serverId: string; transport: unknown }) => ({
    auth_url: "https://provider.example.com/authorize?state=abc",
    attempt_id: "test-attempt",
  }),
);

mock.module("../mcp/mcp-auth-orchestrator.js", () => ({
  orchestrateMcpOAuthConnect: mockOrchestrateConnect,
}));

const mockGetMcpAuthState = mock((_serverId: string) => null as unknown);

mock.module("../mcp/mcp-auth-state.js", () => ({
  cancelCurrentMcpAuth: () => {},
  getMcpAuthState: mockGetMcpAuthState,
}));

import { setConfig } from "./helpers/set-config.js";

// Seed the MCP server the routes look up via `loadRawConfig()` into the
// workspace config for real.
setConfig("mcp", {
  servers: {
    "my-server": {
      transport: { type: "sse", url: "https://mcp.example.com" },
    },
  },
});

// ── Import SUT after mocks ─────────────────────────────────────────────────────

const { ROUTES } = await import("../runtime/routes/mcp-auth-routes.js");

// ── Helpers ────────────────────────────────────────────────────────────────────

function findRoute(operationId: string) {
  const route = ROUTES.find((r) => r.operationId === operationId);
  if (!route) {
    throw new Error(`Route ${operationId} not found`);
  }
  return route;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("mcp-auth-routes", () => {
  beforeEach(() => {
    mockOrchestrateConnect.mockClear();
    mockGetMcpAuthState.mockClear();
    mockGetMcpAuthState.mockImplementation(() => null);
    mockReloadMcpServers.mockClear(); // ← add this line
  });

  describe("POST internal/mcp/auth/start", () => {
    test("happy path returns { auth_url, state }", async () => {
      const startRoute = findRoute("internal_mcp_auth_start");
      const result = await startRoute.handler({
        body: { serverId: "my-server" },
      });

      expect(result).toEqual({
        auth_url: "https://provider.example.com/authorize?state=abc",
        attempt_id: "test-attempt",
        state: "my-server",
      });
    });

    test("rejects unknown serverId with BadRequestError", async () => {
      const startRoute = findRoute("internal_mcp_auth_start");

      await expect(
        startRoute.handler({ body: { serverId: "unknown-server" } }),
      ).rejects.toMatchObject({
        name: "BadRequestError",
        message: expect.stringContaining("not configured"),
      });
    });

    test("wraps orchestrator error in InternalError", async () => {
      mockOrchestrateConnect.mockImplementationOnce(async () => {
        throw new Error("orchestrator blew up");
      });

      const startRoute = findRoute("internal_mcp_auth_start");

      await expect(
        startRoute.handler({ body: { serverId: "my-server" } }),
      ).rejects.toMatchObject({
        name: "InternalError",
        message: "orchestrator blew up",
      });
    });
  });

  describe("GET internal/mcp/auth/status/:serverId", () => {
    test("returns pending state", async () => {
      mockGetMcpAuthState.mockImplementation(() => ({
        status: "pending",
        authUrl: "https://auth.example.com",
        attemptId: "test-attempt",
        expiresAt: Date.now() + 300_000,
      }));

      const statusRoute = findRoute("internal_mcp_auth_status");
      const result = await statusRoute.handler({
        pathParams: { serverId: "my-server" },
      });

      expect(result).toEqual({
        status: "pending",
        auth_url: "https://auth.example.com",
        attempt_id: "test-attempt",
      });
    });

    test("returns complete state", async () => {
      mockGetMcpAuthState.mockImplementation(() => ({
        status: "complete",
        attemptId: "test-attempt",
        serverId: "my-server",
        completedAt: Date.now(),
      }));

      const statusRoute = findRoute("internal_mcp_auth_status");
      const result = await statusRoute.handler({
        pathParams: { serverId: "my-server" },
      });

      expect(result).toEqual({
        status: "complete",
        attempt_id: "test-attempt",
      });
    });

    test("returns error state", async () => {
      mockGetMcpAuthState.mockImplementation(() => ({
        status: "error",
        attemptId: "test-attempt",
        error: "access_denied",
        failedAt: Date.now(),
      }));

      const statusRoute = findRoute("internal_mcp_auth_status");
      const result = await statusRoute.handler({
        pathParams: { serverId: "my-server" },
      });

      expect(result).toEqual({
        status: "error",
        attempt_id: "test-attempt",
        error: "access_denied",
      });
    });

    test("throws NotFoundError for unknown serverId", async () => {
      // mockGetMcpAuthState returns null by default (set in beforeEach)

      const statusRoute = findRoute("internal_mcp_auth_status");

      expect(() =>
        statusRoute.handler({ pathParams: { serverId: "unknown-server" } }),
      ).toThrow(
        expect.objectContaining({
          name: "NotFoundError",
        }),
      );
    });
  });

  describe("POST internal/mcp/reload", () => {
    test("happy path returns { ok: true } and kicks off reload", async () => {
      const reloadRoute = findRoute("internal_mcp_reload");
      const result = await reloadRoute.handler({ body: {} });

      expect(result).toEqual({ ok: true });
      // Flush the micro-task queue so the void promise runs
      await new Promise((r) => setTimeout(r, 0));
      expect(mockReloadMcpServers).toHaveBeenCalledTimes(1);
    });

    test("reload-throws-async still returns { ok: true } (fire-and-forget)", async () => {
      mockReloadMcpServers.mockImplementationOnce(async () => {
        throw new Error("reload failed");
      });

      const reloadRoute = findRoute("internal_mcp_reload");
      // Must not throw even though the reload promise rejects
      const result = await reloadRoute.handler({ body: {} });

      expect(result).toEqual({ ok: true });
    });
  });
});
