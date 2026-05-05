/**
 * Unit tests for the /v1/host-bash-result route handler.
 *
 * Covers the client-identity validation introduced by the targeted-host-proxy
 * plan: when a pending interaction has a `targetClientId`, the submitting
 * client must supply a matching `x-vellum-client-id` header or be rejected
 * with 400 (missing) or 403 (mismatch).
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// ── Module mocks ─────────────────────────────────────────────────────

mock.module("../config/env.js", () => ({
  isHttpAuthDisabled: () => true,
  hasUngatedHttpAuthDisabled: () => false,
}));

import type { PendingInteraction } from "../runtime/pending-interactions.js";

// Stored pending interactions keyed by requestId.
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

interface ResolveCall {
  requestId: string;
  result: {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    timedOut: boolean;
  };
}

const resolveSpy: ResolveCall[] = [];

mock.module("../daemon/host-bash-proxy.js", () => ({
  HostBashProxy: {
    get instance() {
      return {
        resolveResult(
          requestId: string,
          result: {
            stdout: string;
            stderr: string;
            exitCode: number | null;
            timedOut: boolean;
          },
        ) {
          // resolveResult() internally calls pendingInteractions.resolve() in the real
          // implementation; simulate that here so resolvedIds assertions still hold.
          resolvedIds.push(requestId);
          resolveSpy.push({ requestId, result });
        },
      };
    },
  },
}));

// Stored actor-principal-id keyed by clientId, populated by tests.
const clientActorPrincipals = new Map<string, string>();

mock.module("../runtime/assistant-event-hub.js", () => ({
  assistantEventHub: {
    getActorPrincipalIdForClient: (clientId: string) =>
      clientActorPrincipals.get(clientId),
  },
}));

// ── Real imports (after mocks) ───────────────────────────────────────

import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../runtime/routes/errors.js";
import { ROUTES } from "../runtime/routes/host-bash-routes.js";

afterAll(() => {
  mock.restore();
});

const handleHostBashResult = ROUTES.find(
  (r) => r.endpoint === "host-bash-result",
)!.handler;

// ── Helpers ──────────────────────────────────────────────────────────

function registerPending(
  requestId: string,
  overrides: Partial<PendingInteraction> = {},
): void {
  // Mirror the production proxy behavior: capture the target's actor
  // principal at registration time so the result-route check compares
  // against the persisted value rather than a live hub lookup.
  const targetActorPrincipalId =
    overrides.targetActorPrincipalId ??
    (overrides.targetClientId
      ? clientActorPrincipals.get(overrides.targetClientId)
      : undefined);
  pendingStore.set(requestId, {
    conversationId: "conv-1",
    kind: "host_bash",
    ...overrides,
    targetActorPrincipalId,
  });
}

function bashBody(requestId: string): Record<string, unknown> {
  return {
    requestId,
    stdout: "hello\n",
    stderr: "",
    exitCode: 0,
    timedOut: false,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("handleHostBashResult", () => {
  beforeEach(() => {
    pendingStore.clear();
    resolvedIds.length = 0;
    resolveSpy.length = 0;
    clientActorPrincipals.clear();
  });

  // ── Happy paths ────────────────────────────────────────────────────

  describe("untargeted request (no targetClientId)", () => {
    test("accepts when header is present", async () => {
      const requestId = "req-untargeted-with-header";
      registerPending(requestId);

      const result = await handleHostBashResult({
        body: bashBody(requestId),
        headers: { "x-vellum-client-id": "client-abc" },
      });

      expect(result).toEqual({ accepted: true });
      expect(resolveSpy).toHaveLength(1);
      expect(resolvedIds).toContain(requestId);
    });

    test("accepts when header is absent", async () => {
      const requestId = "req-untargeted-no-header";
      registerPending(requestId);

      const result = await handleHostBashResult({
        body: bashBody(requestId),
      });

      expect(result).toEqual({ accepted: true });
      expect(resolveSpy).toHaveLength(1);
      expect(resolvedIds).toContain(requestId);
    });
  });

  describe("targeted request (targetClientId set)", () => {
    test("accepts when x-vellum-client-id matches targetClientId", async () => {
      const requestId = "req-targeted-match";
      clientActorPrincipals.set("client-abc", "principal-1");
      registerPending(requestId, { targetClientId: "client-abc" });

      const result = await handleHostBashResult({
        body: bashBody(requestId),
        headers: {
          "x-vellum-client-id": "client-abc",
          "x-vellum-actor-principal-id": "principal-1",
        },
      });

      expect(result).toEqual({ accepted: true });
      expect(resolveSpy).toHaveLength(1);
      expect(resolveSpy[0].requestId).toBe(requestId);
      expect(resolvedIds).toContain(requestId);
    });

    test("trims whitespace from x-vellum-client-id before comparing", async () => {
      const requestId = "req-targeted-trim";
      clientActorPrincipals.set("client-abc", "principal-1");
      registerPending(requestId, { targetClientId: "client-abc" });

      const result = await handleHostBashResult({
        body: bashBody(requestId),
        headers: {
          "x-vellum-client-id": "  client-abc  ",
          "x-vellum-actor-principal-id": "principal-1",
        },
      });

      expect(result).toEqual({ accepted: true });
    });
  });

  // ── Same-user actor binding (defense-in-depth) ─────────────────────

  describe("targeted request — actor principal binding", () => {
    test("accepts when submitting actor matches target client's actor", async () => {
      const requestId = "req-actor-match";
      clientActorPrincipals.set("client-abc", "principal-shared");
      registerPending(requestId, { targetClientId: "client-abc" });

      const result = await handleHostBashResult({
        body: bashBody(requestId),
        headers: {
          "x-vellum-client-id": "client-abc",
          "x-vellum-actor-principal-id": "principal-shared",
        },
      });

      expect(result).toEqual({ accepted: true });
      expect(resolveSpy).toHaveLength(1);
      expect(resolvedIds).toContain(requestId);
    });

    test("throws ForbiddenError (403) when submitting actor does not match target client's actor", () => {
      const requestId = "req-actor-mismatch";
      clientActorPrincipals.set("client-abc", "principal-victim");
      registerPending(requestId, { targetClientId: "client-abc" });

      expect(() =>
        handleHostBashResult({
          body: bashBody(requestId),
          headers: {
            "x-vellum-client-id": "client-abc",
            "x-vellum-actor-principal-id": "principal-attacker",
          },
        }),
      ).toThrow(ForbiddenError);
    });

    test("interaction is NOT resolved on cross-actor 403 (still pending)", () => {
      const requestId = "req-actor-mismatch-stays";
      clientActorPrincipals.set("client-abc", "principal-victim");
      registerPending(requestId, { targetClientId: "client-abc" });

      try {
        handleHostBashResult({
          body: bashBody(requestId),
          headers: {
            "x-vellum-client-id": "client-abc",
            "x-vellum-actor-principal-id": "principal-attacker",
          },
        });
      } catch {
        // expected
      }

      expect(resolvedIds).not.toContain(requestId);
      expect(pendingStore.has(requestId)).toBe(true);
    });

    test("throws ForbiddenError (403) when x-vellum-actor-principal-id header is missing entirely", () => {
      const requestId = "req-actor-missing";
      clientActorPrincipals.set("client-abc", "principal-victim");
      registerPending(requestId, { targetClientId: "client-abc" });

      expect(() =>
        handleHostBashResult({
          body: bashBody(requestId),
          headers: { "x-vellum-client-id": "client-abc" },
        }),
      ).toThrow(ForbiddenError);
    });

    test("interaction is NOT resolved when submitting actor is missing (still pending)", () => {
      const requestId = "req-actor-missing-stays";
      clientActorPrincipals.set("client-abc", "principal-victim");
      registerPending(requestId, { targetClientId: "client-abc" });

      try {
        handleHostBashResult({
          body: bashBody(requestId),
          headers: { "x-vellum-client-id": "client-abc" },
        });
      } catch {
        // expected
      }

      expect(resolvedIds).not.toContain(requestId);
      expect(pendingStore.has(requestId)).toBe(true);
    });

    test("throws ForbiddenError (403) when target client has no stored actor principal", () => {
      // Target client connected without a verified principal (e.g. legacy
      // service token) — refuse the submission rather than silently allow
      // any actor through.
      const requestId = "req-actor-target-missing";
      registerPending(requestId, { targetClientId: "client-abc" });
      // Note: no entry in clientActorPrincipals for "client-abc".

      expect(() =>
        handleHostBashResult({
          body: bashBody(requestId),
          headers: {
            "x-vellum-client-id": "client-abc",
            "x-vellum-actor-principal-id": "principal-1",
          },
        }),
      ).toThrow(ForbiddenError);
    });
  });

  // ── Untargeted-request behavior (regression for new check) ─────────

  describe("untargeted request — actor principal check is skipped", () => {
    test("accepts even when submitting actor is absent and no target client is set", async () => {
      const requestId = "req-untargeted-no-actor";
      registerPending(requestId);

      const result = await handleHostBashResult({
        body: bashBody(requestId),
        headers: {},
      });

      expect(result).toEqual({ accepted: true });
      expect(resolveSpy).toHaveLength(1);
      expect(resolvedIds).toContain(requestId);
    });
  });

  // ── Error: missing header on targeted request ──────────────────────

  describe("targeted request — missing x-vellum-client-id header", () => {
    test("throws BadRequestError (400) when header is absent", () => {
      const requestId = "req-targeted-no-header";
      registerPending(requestId, { targetClientId: "client-abc" });

      expect(() => handleHostBashResult({ body: bashBody(requestId) })).toThrow(
        BadRequestError,
      );
    });

    test("throws BadRequestError (400) when header is empty string", () => {
      const requestId = "req-targeted-empty-header";
      registerPending(requestId, { targetClientId: "client-abc" });

      expect(() =>
        handleHostBashResult({
          body: bashBody(requestId),
          headers: { "x-vellum-client-id": "   " },
        }),
      ).toThrow(BadRequestError);
    });

    test("interaction is NOT resolved on 400 (still pending)", () => {
      const requestId = "req-targeted-no-header-stays";
      registerPending(requestId, { targetClientId: "client-abc" });

      try {
        handleHostBashResult({ body: bashBody(requestId) });
      } catch {
        // expected
      }

      expect(resolvedIds).not.toContain(requestId);
      expect(pendingStore.has(requestId)).toBe(true);
    });
  });

  // ── Error: wrong client ────────────────────────────────────────────

  describe("targeted request — mismatched x-vellum-client-id", () => {
    test("throws ForbiddenError (403) when client ID does not match", () => {
      const requestId = "req-targeted-mismatch";
      registerPending(requestId, { targetClientId: "client-abc" });

      expect(() =>
        handleHostBashResult({
          body: bashBody(requestId),
          headers: { "x-vellum-client-id": "client-xyz" },
        }),
      ).toThrow(ForbiddenError);
    });

    test("ForbiddenError message names both the submitting and expected client", () => {
      const requestId = "req-targeted-mismatch-msg";
      registerPending(requestId, { targetClientId: "client-abc" });

      let caught: unknown;
      try {
        handleHostBashResult({
          body: bashBody(requestId),
          headers: { "x-vellum-client-id": "client-xyz" },
        });
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(ForbiddenError);
      const msg = (caught as ForbiddenError).message;
      expect(msg).toContain("client-xyz");
      expect(msg).toContain("client-abc");
    });

    test("interaction is NOT resolved on 403 (still pending)", () => {
      const requestId = "req-targeted-mismatch-stays";
      registerPending(requestId, { targetClientId: "client-abc" });

      try {
        handleHostBashResult({
          body: bashBody(requestId),
          headers: { "x-vellum-client-id": "client-xyz" },
        });
      } catch {
        // expected
      }

      expect(resolvedIds).not.toContain(requestId);
      expect(pendingStore.has(requestId)).toBe(true);
    });
  });

  // ── Other existing validations (regression) ────────────────────────

  test("throws BadRequestError when body is missing", () => {
    expect(() => handleHostBashResult({})).toThrow(BadRequestError);
  });

  test("throws BadRequestError when requestId is missing", () => {
    expect(() => handleHostBashResult({ body: { stdout: "x" } })).toThrow(
      BadRequestError,
    );
  });

  test("throws NotFoundError for unknown requestId", () => {
    expect(() =>
      handleHostBashResult({
        body: bashBody("unknown-req-id"),
      }),
    ).toThrow(NotFoundError);
  });

  test("throws ConflictError when pending interaction is not host_bash kind", () => {
    const requestId = "req-wrong-kind";
    pendingStore.set(requestId, {
      conversationId: "conv-1",
      kind: "confirmation",
    });

    expect(() => handleHostBashResult({ body: bashBody(requestId) })).toThrow(
      ConflictError,
    );
  });
});
