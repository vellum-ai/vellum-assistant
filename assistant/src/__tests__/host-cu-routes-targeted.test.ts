/**
 * Tests for the host-cu-result route 403 guard introduced in Phase 2.
 *
 * Covers:
 *  1. Targeted + correct x-vellum-client-id header → 200 accepted
 *  2. Targeted + missing header → 400 BadRequestError
 *  3. Targeted + wrong header → 403 ForbiddenError, interaction NOT consumed
 *  4. Untargeted (no targetClientId, no header) → 200 accepted (regression)
 *
 * Resolution goes through conversation.hostCuProxy?.resolve(...). The
 * conversation store is mocked to return a controlled conversation object.
 *
 * Note: host-cu-routes.ts has a deep import chain (conversation-store →
 * conversation.ts → ces-client → service-contracts) that requires mocking
 * before the module loads. We use dynamic imports to ensure all mocks are
 * registered before the route module is evaluated.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// ── Module mocks ─────────────────────────────────────────────────────────────
// Must be registered before the host-cu-routes module is loaded.

mock.module("../config/env.js", () => ({
  isHttpAuthDisabled: () => true,
  hasUngatedHttpAuthDisabled: () => false,
  getPlatformBaseUrl: () => "https://platform.example.com",
  getGatewayInternalBaseUrl: () => "http://localhost:8080",
  getIngressPublicBaseUrl: () => undefined,
  setIngressPublicBaseUrl: () => {},
  getRuntimeHttpPort: () => 3000,
  getRuntimeHttpHost: () => "0.0.0.0",
  getSentryDsn: () => "",
  getQdrantUrlEnv: () => undefined,
  getQdrantHttpPortEnv: () => undefined,
  getQdrantReadyzTimeoutMs: () => undefined,
  getOllamaBaseUrlEnv: () => undefined,
  setPlatformBaseUrl: () => {},
  getAssistantDomain: () => "example.com",
  setPlatformAssistantId: () => {},
  getPlatformAssistantId: () => "test-assistant-id",
  setPlatformOrganizationId: () => {},
  getPlatformOrganizationId: () => "test-org-id",
  setPlatformUserId: () => {},
  getPlatformUserId: () => "test-user-id",
  getPlatformInternalApiKey: () => "test-api-key",
  validateEnv: () => {},
}));

import type { PendingInteraction } from "../runtime/pending-interactions.js";

const pendingStore = new Map<string, PendingInteraction>();
const resolvedIds: string[] = [];

mock.module("../runtime/pending-interactions.js", () => ({
  get: (requestId: string) => pendingStore.get(requestId),
  resolve: (requestId: string) => {
    const entry = pendingStore.get(requestId);
    if (entry) {
      pendingStore.delete(requestId);
      resolvedIds.push(requestId);
    }
    return entry;
  },
}));

interface CuResolveCall {
  requestId: string;
  payload: Record<string, unknown>;
}

const cuResolveSpy: CuResolveCall[] = [];

// Controlled conversation map: conversationId → conversation object
const conversationStore = new Map<
  string,
  { hostCuProxy?: { processObservation: (...args: unknown[]) => void } }
>();

mock.module("../daemon/conversation-store.js", () => ({
  findConversation: (conversationId: string) =>
    conversationStore.get(conversationId),
}));

// Controlled actor-principal map: clientId → actorPrincipalId
const actorPrincipalByClient = new Map<string, string>();

mock.module("../runtime/assistant-event-hub.js", () => ({
  assistantEventHub: {
    getActorPrincipalIdForClient: (clientId: string) =>
      actorPrincipalByClient.get(clientId),
  },
}));

// ── Real imports (after mocks) ──────────────────────────────────────────────
// Use dynamic import to ensure the mocks above are applied before loading.

import { BadRequestError, ForbiddenError } from "../runtime/routes/errors.js";

const { ROUTES } = await import("../runtime/routes/host-cu-routes.js");

afterAll(() => {
  mock.restore();
});

const handleHostCuResult = ROUTES.find(
  (r: { endpoint: string }) => r.endpoint === "host-cu-result",
)!.handler;

// ── Helpers ──────────────────────────────────────────────────────────────────

function registerPending(
  requestId: string,
  overrides: Partial<PendingInteraction> = {},
): void {
  const targetActorPrincipalId =
    overrides.targetActorPrincipalId ??
    (overrides.targetClientId
      ? actorPrincipalByClient.get(overrides.targetClientId)
      : undefined);
  const entry: PendingInteraction = {
    conversationId: "conv-cu-1",
    kind: "host_cu",
    ...overrides,
    targetActorPrincipalId,
  };
  pendingStore.set(requestId, entry);
}

function registerConversation(conversationId = "conv-cu-1"): void {
  conversationStore.set(conversationId, {
    hostCuProxy: {
      processObservation(requestId: unknown, payload: unknown) {
        // Simulate what the real processObservation does: consume the pending interaction
        pendingStore.delete(requestId as string);
        resolvedIds.push(requestId as string);
        cuResolveSpy.push({
          requestId: requestId as string,
          payload: payload as Record<string, unknown>,
        });
      },
    },
  });
}

function cuBody(requestId: string): Record<string, unknown> {
  return {
    requestId,
    axTree: "Button [1]",
    executionResult: "Clicked",
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("handleHostCuResult — Phase 2 targetClientId guard", () => {
  beforeEach(() => {
    pendingStore.clear();
    conversationStore.clear();
    actorPrincipalByClient.clear();
    resolvedIds.length = 0;
    cuResolveSpy.length = 0;
    // Default: register a conversation with a hostCuProxy
    registerConversation("conv-cu-1");
  });

  // ── 1. Targeted + correct header → 200 ────────────────────────────────────

  describe("targeted + correct x-vellum-client-id header", () => {
    test("returns { accepted: true } and resolves the interaction", async () => {
      const requestId = "req-cu-targeted-match";
      actorPrincipalByClient.set("client-A", "user-1");
      registerPending(requestId, { targetClientId: "client-A" });

      const result = await handleHostCuResult({
        body: cuBody(requestId),
        headers: {
          "x-vellum-client-id": "client-A",
          "x-vellum-actor-principal-id": "user-1",
        },
      });

      expect(result).toEqual({ accepted: true });
      expect(cuResolveSpy).toHaveLength(1);
      expect(cuResolveSpy[0].requestId).toBe(requestId);
      expect(resolvedIds).toContain(requestId);
    });

    test("trims whitespace from header before comparing", async () => {
      const requestId = "req-cu-targeted-trim";
      actorPrincipalByClient.set("client-A", "user-1");
      registerPending(requestId, { targetClientId: "client-A" });

      const result = await handleHostCuResult({
        body: cuBody(requestId),
        headers: {
          "x-vellum-client-id": "  client-A  ",
          "x-vellum-actor-principal-id": "user-1",
        },
      });

      expect(result).toEqual({ accepted: true });
    });
  });

  // ── 2. Targeted + missing header → 400 ────────────────────────────────────

  describe("targeted + missing x-vellum-client-id header", () => {
    test("throws BadRequestError (400) when header is absent", () => {
      const requestId = "req-cu-targeted-no-header";
      registerPending(requestId, { targetClientId: "client-A" });

      expect(() => handleHostCuResult({ body: cuBody(requestId) })).toThrow(
        BadRequestError,
      );
    });

    test("throws BadRequestError (400) when header is empty string", () => {
      const requestId = "req-cu-targeted-empty-header";
      registerPending(requestId, { targetClientId: "client-A" });

      expect(() =>
        handleHostCuResult({
          body: cuBody(requestId),
          headers: { "x-vellum-client-id": "   " },
        }),
      ).toThrow(BadRequestError);
    });

    test("interaction is NOT resolved on 400 (still pending)", () => {
      const requestId = "req-cu-targeted-no-header-stays";
      registerPending(requestId, { targetClientId: "client-A" });

      try {
        handleHostCuResult({ body: cuBody(requestId) });
      } catch {
        // expected
      }

      expect(resolvedIds).not.toContain(requestId);
      expect(pendingStore.has(requestId)).toBe(true);
    });
  });

  // ── 3. Targeted + wrong header → 403 ──────────────────────────────────────

  describe("targeted + wrong x-vellum-client-id header", () => {
    test("throws ForbiddenError (403) when client ID does not match", () => {
      const requestId = "req-cu-targeted-mismatch";
      registerPending(requestId, { targetClientId: "client-A" });

      expect(() =>
        handleHostCuResult({
          body: cuBody(requestId),
          headers: { "x-vellum-client-id": "client-B" },
        }),
      ).toThrow(ForbiddenError);
    });

    test("ForbiddenError message names both submitting and expected client", () => {
      const requestId = "req-cu-targeted-mismatch-msg";
      registerPending(requestId, { targetClientId: "client-A" });

      let caught: unknown;
      try {
        handleHostCuResult({
          body: cuBody(requestId),
          headers: { "x-vellum-client-id": "client-B" },
        });
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(ForbiddenError);
      const msg = (caught as ForbiddenError).message;
      expect(msg).toContain("client-B");
      expect(msg).toContain("client-A");
    });

    test("interaction is NOT consumed on 403 (pendingInteractions.get still returns it)", () => {
      const requestId = "req-cu-targeted-mismatch-stays";
      registerPending(requestId, { targetClientId: "client-A" });

      try {
        handleHostCuResult({
          body: cuBody(requestId),
          headers: { "x-vellum-client-id": "client-B" },
        });
      } catch {
        // expected
      }

      expect(resolvedIds).not.toContain(requestId);
      expect(pendingStore.has(requestId)).toBe(true);
    });
  });

  // ── 3b. Actor-principal-id (PR 7) — defense-in-depth ──────────────────────

  describe("targeted + actor-principal-id binding", () => {
    test("accepts when submitting actor matches target client's stored actor", async () => {
      const requestId = "req-cu-actor-match";
      actorPrincipalByClient.set("client-A", "user-1");
      registerPending(requestId, { targetClientId: "client-A" });

      const result = await handleHostCuResult({
        body: cuBody(requestId),
        headers: {
          "x-vellum-client-id": "client-A",
          "x-vellum-actor-principal-id": "user-1",
        },
      });

      expect(result).toEqual({ accepted: true });
      expect(cuResolveSpy).toHaveLength(1);
      expect(resolvedIds).toContain(requestId);
    });

    test("throws ForbiddenError (403) when submitting actor does not match target client's actor", () => {
      const requestId = "req-cu-actor-mismatch";
      actorPrincipalByClient.set("client-A", "user-1");
      registerPending(requestId, { targetClientId: "client-A" });

      expect(() =>
        handleHostCuResult({
          body: cuBody(requestId),
          headers: {
            "x-vellum-client-id": "client-A",
            "x-vellum-actor-principal-id": "user-2",
          },
        }),
      ).toThrow(ForbiddenError);
    });

    test("interaction NOT consumed on 403 actor mismatch", () => {
      const requestId = "req-cu-actor-mismatch-stays";
      actorPrincipalByClient.set("client-A", "user-1");
      registerPending(requestId, { targetClientId: "client-A" });

      try {
        handleHostCuResult({
          body: cuBody(requestId),
          headers: {
            "x-vellum-client-id": "client-A",
            "x-vellum-actor-principal-id": "user-2",
          },
        });
      } catch {
        // expected
      }

      expect(resolvedIds).not.toContain(requestId);
      expect(pendingStore.has(requestId)).toBe(true);
    });

    test("throws ForbiddenError (403) when submitting actor header is missing", () => {
      const requestId = "req-cu-actor-missing";
      actorPrincipalByClient.set("client-A", "user-1");
      registerPending(requestId, { targetClientId: "client-A" });

      expect(() =>
        handleHostCuResult({
          body: cuBody(requestId),
          headers: { "x-vellum-client-id": "client-A" },
        }),
      ).toThrow(ForbiddenError);
    });

    test("throws ForbiddenError (403) when target client has no stored actor principal id", () => {
      const requestId = "req-cu-target-no-actor";
      registerPending(requestId, { targetClientId: "client-A" });
      // No actorPrincipalByClient entry for client-A.

      expect(() =>
        handleHostCuResult({
          body: cuBody(requestId),
          headers: {
            "x-vellum-client-id": "client-A",
            "x-vellum-actor-principal-id": "user-1",
          },
        }),
      ).toThrow(ForbiddenError);
    });

    test("throws ForbiddenError (403) when submitting actor header is whitespace only", () => {
      const requestId = "req-cu-actor-whitespace";
      actorPrincipalByClient.set("client-A", "user-1");
      registerPending(requestId, { targetClientId: "client-A" });

      expect(() =>
        handleHostCuResult({
          body: cuBody(requestId),
          headers: {
            "x-vellum-client-id": "client-A",
            "x-vellum-actor-principal-id": "   ",
          },
        }),
      ).toThrow(ForbiddenError);
    });
  });

  // ── 4. Untargeted — regression ────────────────────────────────────────────

  describe("untargeted request (no targetClientId)", () => {
    test("accepts when no header is provided", async () => {
      const requestId = "req-cu-untargeted-no-header";
      registerPending(requestId);

      const result = await handleHostCuResult({
        body: cuBody(requestId),
      });

      expect(result).toEqual({ accepted: true });
      expect(cuResolveSpy).toHaveLength(1);
      expect(resolvedIds).toContain(requestId);
    });

    test("accepts when header is present (header ignored for untargeted)", async () => {
      const requestId = "req-cu-untargeted-with-header";
      registerPending(requestId);

      const result = await handleHostCuResult({
        body: cuBody(requestId),
        headers: { "x-vellum-client-id": "client-whatever" },
      });

      expect(result).toEqual({ accepted: true });
      expect(cuResolveSpy).toHaveLength(1);
    });
  });
});
