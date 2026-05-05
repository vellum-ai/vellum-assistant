import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Module mocks (must precede imports) ───────────────────────────────────────

type OrchestrateOptions = {
  service: string;
  clientId: string;
  clientSecret?: string;
  callbackTransport?: string;
  requestedScopes?: string[];
  isInteractive: boolean;
  onDeferredComplete?: (r: {
    success: boolean;
    service: string;
    accountInfo?: string;
    grantedScopes?: string[];
    error?: string;
  }) => void;
};

let capturedOnDeferredComplete: OrchestrateOptions["onDeferredComplete"] | undefined;
let mockOrchestrateResult: Record<string, unknown> = {
  success: true,
  deferred: true,
  authorizeUrl: "https://accounts.google.com/o/oauth2/auth?client_id=test",
  state: "test-state-uuid-abc123",
  service: "google",
};

mock.module("../oauth/connect-orchestrator.js", () => ({
  orchestrateOAuthConnect: async (opts: OrchestrateOptions) => {
    capturedOnDeferredComplete = opts.onDeferredComplete;
    return mockOrchestrateResult;
  },
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// NOTE: Do NOT mock oauth-connect-state — use the real module so we can
// verify state transitions via getOAuthConnectState.

// ── Import SUT after mocks ─────────────────────────────────────────────────────

const { ROUTES } = await import("../runtime/routes/oauth-connect-routes.js");
const { BadRequestError, InternalError, NotFoundError } = await import(
  "../runtime/routes/errors.js"
);
const { _clearAllOAuthConnectStates, getOAuthConnectState } = await import(
  "../oauth/oauth-connect-state.js"
);

// ── Helpers ────────────────────────────────────────────────────────────────────

function findRoute(operationId: string) {
  const route = ROUTES.find((r) => r.operationId === operationId);
  if (!route) throw new Error(`Route ${operationId} not found`);
  return route;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("oauth-connect-routes", () => {
  describe("POST internal/oauth/connect/start", () => {
    beforeEach(() => {
      capturedOnDeferredComplete = undefined;
      mockOrchestrateResult = {
        success: true,
        deferred: true,
        authorizeUrl: "https://accounts.google.com/o/oauth2/auth?client_id=test",
        state: "test-state-uuid-abc123",
        service: "google",
      };
      _clearAllOAuthConnectStates();
    });

    test("happy path returns auth_url and state, sets pending in state map", async () => {
      const result = await findRoute("internal_oauth_connect_start").handler({
        body: {
          service: "google",
          clientId: "my-client-id",
          callbackTransport: "gateway",
        },
      });
      expect(result).toEqual({
        auth_url: "https://accounts.google.com/o/oauth2/auth?client_id=test",
        state: "test-state-uuid-abc123",
      });
      // State map should have pending entry
      expect(getOAuthConnectState("test-state-uuid-abc123")).toMatchObject({
        status: "pending",
        service: "google",
      });
    });

    test("invalid callbackTransport throws BadRequestError", async () => {
      await expect(
        findRoute("internal_oauth_connect_start").handler({
          body: {
            service: "google",
            clientId: "my-client-id",
            callbackTransport: "ftp",
          },
        }),
      ).rejects.toBeInstanceOf(BadRequestError);
    });

    test("missing clientId throws BadRequestError", async () => {
      await expect(
        findRoute("internal_oauth_connect_start").handler({
          body: {
            service: "google",
            callbackTransport: "gateway",
          },
        }),
      ).rejects.toBeInstanceOf(BadRequestError);
    });

    test("missing service throws BadRequestError", async () => {
      await expect(
        findRoute("internal_oauth_connect_start").handler({
          body: {
            clientId: "my-client-id",
            callbackTransport: "gateway",
          },
        }),
      ).rejects.toBeInstanceOf(BadRequestError);
    });

    test("orchestrator returns success:false throws InternalError", async () => {
      mockOrchestrateResult = {
        success: false,
        error: "provider configuration error",
        deferred: false,
      };
      await expect(
        findRoute("internal_oauth_connect_start").handler({
          body: {
            service: "google",
            clientId: "my-client-id",
            callbackTransport: "gateway",
          },
        }),
      ).rejects.toBeInstanceOf(InternalError);
    });

    test("loopback callbackTransport is also accepted", async () => {
      const result = await findRoute("internal_oauth_connect_start").handler({
        body: {
          service: "google",
          clientId: "my-client-id",
          callbackTransport: "loopback",
        },
      });
      expect(result).toMatchObject({
        auth_url: "https://accounts.google.com/o/oauth2/auth?client_id=test",
        state: "test-state-uuid-abc123",
      });
    });

    test("success:true, deferred:false throws InternalError (synchronous completion not supported via daemon route)", async () => {
      // The daemon-owned route requires a deferred flow so the CLI can poll for status.
      // When the orchestrator returns { success: true, deferred: false } (e.g., already
      // authenticated), the handler has no auth_url or state to return and throws an
      // InternalError rather than silently returning a malformed response.
      mockOrchestrateResult = {
        success: true,
        deferred: false,
        service: "google",
        grantedScopes: [],
      };
      await expect(
        findRoute("internal_oauth_connect_start").handler({
          body: {
            service: "google",
            clientId: "my-client-id",
            callbackTransport: "gateway",
          },
        }),
      ).rejects.toBeInstanceOf(InternalError);
    });
  });

  describe("GET internal/oauth/connect/status/:state", () => {
    beforeEach(() => {
      _clearAllOAuthConnectStates();
      capturedOnDeferredComplete = undefined;
      mockOrchestrateResult = {
        success: true,
        deferred: true,
        authorizeUrl: "https://accounts.google.com/o/oauth2/auth?client_id=test",
        state: "test-state-uuid-abc123",
        service: "google",
      };
    });

    test("returns pending after start", async () => {
      await findRoute("internal_oauth_connect_start").handler({
        body: {
          service: "google",
          clientId: "my-client-id",
          callbackTransport: "gateway",
        },
      });
      const result = findRoute("internal_oauth_connect_status").handler({
        pathParams: { state: "test-state-uuid-abc123" },
      });
      expect(result).toMatchObject({ status: "pending", service: "google" });
    });

    test("returns complete after onDeferredComplete fires with success", async () => {
      await findRoute("internal_oauth_connect_start").handler({
        body: {
          service: "google",
          clientId: "my-client-id",
          callbackTransport: "gateway",
        },
      });
      // Fire the onDeferredComplete callback manually
      capturedOnDeferredComplete?.({
        success: true,
        service: "google",
        accountInfo: "user@example.com",
      });
      const result = findRoute("internal_oauth_connect_status").handler({
        pathParams: { state: "test-state-uuid-abc123" },
      });
      expect(result).toMatchObject({
        status: "complete",
        service: "google",
        account_info: "user@example.com",
      });
    });

    test("returns error after onDeferredComplete fires with failure", async () => {
      await findRoute("internal_oauth_connect_start").handler({
        body: {
          service: "google",
          clientId: "my-client-id",
          callbackTransport: "gateway",
        },
      });
      capturedOnDeferredComplete?.({
        success: false,
        service: "google",
        error: "exchange failed",
      });
      const result = findRoute("internal_oauth_connect_status").handler({
        pathParams: { state: "test-state-uuid-abc123" },
      });
      expect(result).toMatchObject({
        status: "error",
        service: "google",
        error: "exchange failed",
      });
    });

    test("throws NotFoundError for unknown state", () => {
      expect(() =>
        findRoute("internal_oauth_connect_status").handler({
          pathParams: { state: "nonexistent-state" },
        }),
      ).toThrow(NotFoundError);
    });

    test("returns complete with granted_scopes after onDeferredComplete fires with grantedScopes", async () => {
      await findRoute("internal_oauth_connect_start").handler({
        body: {
          service: "google",
          clientId: "my-client-id",
          callbackTransport: "gateway",
        },
      });
      // Fire the onDeferredComplete callback with grantedScopes
      capturedOnDeferredComplete?.({
        success: true,
        service: "google",
        accountInfo: "user@example.com",
        grantedScopes: ["https://www.googleapis.com/auth/calendar", "https://www.googleapis.com/auth/gmail.readonly"],
      });
      const result = findRoute("internal_oauth_connect_status").handler({
        pathParams: { state: "test-state-uuid-abc123" },
      }) as Record<string, unknown>;
      expect(result).toMatchObject({
        status: "complete",
        service: "google",
        account_info: "user@example.com",
        granted_scopes: ["https://www.googleapis.com/auth/calendar", "https://www.googleapis.com/auth/gmail.readonly"],
      });
    });

    test("complete without accountInfo does not include account_info field", async () => {
      await findRoute("internal_oauth_connect_start").handler({
        body: {
          service: "google",
          clientId: "my-client-id",
          callbackTransport: "gateway",
        },
      });
      capturedOnDeferredComplete?.({
        success: true,
        service: "google",
        // No accountInfo
      });
      const result = findRoute("internal_oauth_connect_status").handler({
        pathParams: { state: "test-state-uuid-abc123" },
      }) as Record<string, unknown>;
      expect(result.status).toBe("complete");
      expect(result.account_info).toBeUndefined();
    });
  });
});
