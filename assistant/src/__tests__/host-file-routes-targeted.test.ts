/**
 * Tests for the host-file-result route 403 guard.
 *
 * Covers:
 *  1. Targeted + correct x-vellum-client-id header (and matching actor) → 200
 *  2. Targeted + missing client-id header → 400 BadRequestError
 *  3. Targeted + wrong client-id header → 403 ForbiddenError, interaction NOT consumed
 *  4. Untargeted (no targetClientId, no header) → 200 accepted (regression)
 *  5. Targeted + matching client-id but mismatched actor principal → 403, NOT consumed
 *  6. Targeted + matching client-id but missing actor principal header → 403, NOT consumed
 *  7. Targeted + matching client-id but target client has no stored actor → 403, NOT consumed
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// ── Module mocks ────────────────────────────────────────────────────────────

mock.module("../config/env.js", () => ({
  isHttpAuthDisabled: () => true,
  hasUngatedHttpAuthDisabled: () => false,
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

interface FileResolveCall {
  requestId: string;
  result: { content: string; isError: boolean; imageData?: string };
}

const resolveSpy: FileResolveCall[] = [];

mock.module("../daemon/host-file-proxy.js", () => ({
  HostFileProxy: {
    get instance() {
      return {
        resolve(
          requestId: string,
          result: { content: string; isError: boolean; imageData?: string },
        ) {
          // Simulate the real resolve: consume the pending interaction
          const entry = pendingStore.get(requestId);
          if (entry) {
            pendingStore.delete(requestId);
            resolvedIds.push(requestId);
          }
          resolveSpy.push({ requestId, result });
        },
      };
    },
  },
}));

// Stub event hub so tests control what actorPrincipalId is associated with
// each connected client.
const clientActors = new Map<string, string>();

mock.module("../runtime/assistant-event-hub.js", () => ({
  assistantEventHub: {
    getActorPrincipalIdForClient: (clientId: string) =>
      clientActors.get(clientId),
  },
}));

// ── Real imports (after mocks) ──────────────────────────────────────────────

import { BadRequestError, ForbiddenError } from "../runtime/routes/errors.js";
import { ROUTES } from "../runtime/routes/host-file-routes.js";

afterAll(() => {
  mock.restore();
});

const handleHostFileResult = ROUTES.find(
  (r) => r.endpoint === "host-file-result",
)!.handler;

// ── Helpers ─────────────────────────────────────────────────────────────────

function registerPending(
  requestId: string,
  overrides: Partial<PendingInteraction> = {},
): void {
  const targetActorPrincipalId =
    overrides.targetActorPrincipalId ??
    (overrides.targetClientId
      ? clientActors.get(overrides.targetClientId)
      : undefined);
  pendingStore.set(requestId, {
    conversationId: "conv-1",
    kind: "host_file",
    ...overrides,
    targetActorPrincipalId,
  });
}

function fileBody(requestId: string): Record<string, unknown> {
  return {
    requestId,
    content: "file content",
    isError: false,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("handleHostFileResult — targetClientId guard", () => {
  beforeEach(() => {
    pendingStore.clear();
    resolvedIds.length = 0;
    resolveSpy.length = 0;
    clientActors.clear();
  });

  // ── 1. Targeted + correct headers (client + actor) → 200 ──────────────────

  describe("targeted + correct x-vellum-client-id header", () => {
    test("returns { accepted: true } and resolves the interaction", async () => {
      const requestId = "req-file-targeted-match";
      clientActors.set("client-A", "actor-1");
      registerPending(requestId, { targetClientId: "client-A" });

      const result = await handleHostFileResult({
        body: fileBody(requestId),
        headers: {
          "x-vellum-client-id": "client-A",
          "x-vellum-actor-principal-id": "actor-1",
        },
      });

      expect(result).toEqual({ accepted: true });
      expect(resolveSpy).toHaveLength(1);
      expect(resolveSpy[0].requestId).toBe(requestId);
      expect(resolvedIds).toContain(requestId);
    });

    test("trims whitespace from header before comparing", async () => {
      const requestId = "req-file-targeted-trim";
      clientActors.set("client-A", "actor-1");
      registerPending(requestId, { targetClientId: "client-A" });

      const result = await handleHostFileResult({
        body: fileBody(requestId),
        headers: {
          "x-vellum-client-id": "  client-A  ",
          "x-vellum-actor-principal-id": "  actor-1  ",
        },
      });

      expect(result).toEqual({ accepted: true });
    });
  });

  // ── 2. Targeted + missing client-id header → 400 ──────────────────────────

  describe("targeted + missing x-vellum-client-id header", () => {
    test("throws BadRequestError (400) when header is absent", () => {
      const requestId = "req-file-targeted-no-header";
      registerPending(requestId, { targetClientId: "client-A" });

      expect(() => handleHostFileResult({ body: fileBody(requestId) })).toThrow(
        BadRequestError,
      );
    });

    test("throws BadRequestError (400) when header is empty string", () => {
      const requestId = "req-file-targeted-empty-header";
      registerPending(requestId, { targetClientId: "client-A" });

      expect(() =>
        handleHostFileResult({
          body: fileBody(requestId),
          headers: { "x-vellum-client-id": "   " },
        }),
      ).toThrow(BadRequestError);
    });

    test("interaction is NOT resolved on 400 (still pending)", () => {
      const requestId = "req-file-targeted-no-header-stays";
      registerPending(requestId, { targetClientId: "client-A" });

      try {
        handleHostFileResult({ body: fileBody(requestId) });
      } catch {
        // expected
      }

      expect(resolvedIds).not.toContain(requestId);
      expect(pendingStore.has(requestId)).toBe(true);
    });
  });

  // ── 3. Targeted + wrong client-id header → 403 ────────────────────────────

  describe("targeted + wrong x-vellum-client-id header", () => {
    test("throws ForbiddenError (403) when client ID does not match", () => {
      const requestId = "req-file-targeted-mismatch";
      registerPending(requestId, { targetClientId: "client-A" });

      expect(() =>
        handleHostFileResult({
          body: fileBody(requestId),
          headers: { "x-vellum-client-id": "client-B" },
        }),
      ).toThrow(ForbiddenError);
    });

    test("ForbiddenError message names both submitting and expected client", () => {
      const requestId = "req-file-targeted-mismatch-msg";
      registerPending(requestId, { targetClientId: "client-A" });

      let caught: unknown;
      try {
        handleHostFileResult({
          body: fileBody(requestId),
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
      const requestId = "req-file-targeted-mismatch-stays";
      registerPending(requestId, { targetClientId: "client-A" });

      try {
        handleHostFileResult({
          body: fileBody(requestId),
          headers: { "x-vellum-client-id": "client-B" },
        });
      } catch {
        // expected
      }

      expect(resolvedIds).not.toContain(requestId);
      expect(pendingStore.has(requestId)).toBe(true);
    });
  });

  // ── 4. Untargeted — regression ────────────────────────────────────────────

  describe("untargeted request (no targetClientId)", () => {
    test("accepts when no header is provided", async () => {
      const requestId = "req-file-untargeted-no-header";
      registerPending(requestId);

      const result = await handleHostFileResult({
        body: fileBody(requestId),
      });

      expect(result).toEqual({ accepted: true });
      expect(resolveSpy).toHaveLength(1);
      expect(resolvedIds).toContain(requestId);
    });

    test("accepts when header is present (header ignored for untargeted)", async () => {
      const requestId = "req-file-untargeted-with-header";
      registerPending(requestId);

      const result = await handleHostFileResult({
        body: fileBody(requestId),
        headers: { "x-vellum-client-id": "client-whatever" },
      });

      expect(result).toEqual({ accepted: true });
      expect(resolveSpy).toHaveLength(1);
    });
  });

  // ── 5. Targeted + matching client but mismatched actor → 403 ──────────────

  describe("targeted + actor principal mismatch", () => {
    test("throws ForbiddenError (403) when submitting actor does not match target client's actor", () => {
      const requestId = "req-file-actor-mismatch";
      clientActors.set("client-A", "actor-1");
      registerPending(requestId, { targetClientId: "client-A" });

      expect(() =>
        handleHostFileResult({
          body: fileBody(requestId),
          headers: {
            "x-vellum-client-id": "client-A",
            "x-vellum-actor-principal-id": "actor-2",
          },
        }),
      ).toThrow(ForbiddenError);
    });

    test("interaction is NOT consumed on actor-mismatch 403", () => {
      const requestId = "req-file-actor-mismatch-stays";
      clientActors.set("client-A", "actor-1");
      registerPending(requestId, { targetClientId: "client-A" });

      try {
        handleHostFileResult({
          body: fileBody(requestId),
          headers: {
            "x-vellum-client-id": "client-A",
            "x-vellum-actor-principal-id": "actor-2",
          },
        });
      } catch {
        // expected
      }

      expect(resolvedIds).not.toContain(requestId);
      expect(pendingStore.has(requestId)).toBe(true);
    });
  });

  // ── 6. Targeted + matching client but missing actor header → 403 ──────────

  describe("targeted + missing x-vellum-actor-principal-id header", () => {
    test("throws ForbiddenError (403) when submitting actor header is absent", () => {
      const requestId = "req-file-actor-missing";
      clientActors.set("client-A", "actor-1");
      registerPending(requestId, { targetClientId: "client-A" });

      expect(() =>
        handleHostFileResult({
          body: fileBody(requestId),
          headers: { "x-vellum-client-id": "client-A" },
        }),
      ).toThrow(ForbiddenError);
    });

    test("throws ForbiddenError (403) when submitting actor header is empty string", () => {
      const requestId = "req-file-actor-empty";
      clientActors.set("client-A", "actor-1");
      registerPending(requestId, { targetClientId: "client-A" });

      expect(() =>
        handleHostFileResult({
          body: fileBody(requestId),
          headers: {
            "x-vellum-client-id": "client-A",
            "x-vellum-actor-principal-id": "   ",
          },
        }),
      ).toThrow(ForbiddenError);
    });

    test("interaction is NOT consumed when submitting actor is missing", () => {
      const requestId = "req-file-actor-missing-stays";
      clientActors.set("client-A", "actor-1");
      registerPending(requestId, { targetClientId: "client-A" });

      try {
        handleHostFileResult({
          body: fileBody(requestId),
          headers: { "x-vellum-client-id": "client-A" },
        });
      } catch {
        // expected
      }

      expect(resolvedIds).not.toContain(requestId);
      expect(pendingStore.has(requestId)).toBe(true);
    });
  });

  // ── 7. Targeted + target client has no stored actor → 403 ─────────────────

  describe("targeted + target client has no stored actor", () => {
    test("throws ForbiddenError (403) when target client has no actorPrincipalId on record", () => {
      const requestId = "req-file-target-no-actor";
      registerPending(requestId, { targetClientId: "client-A" });
      // intentionally do not set clientActors entry for client-A

      expect(() =>
        handleHostFileResult({
          body: fileBody(requestId),
          headers: {
            "x-vellum-client-id": "client-A",
            "x-vellum-actor-principal-id": "actor-1",
          },
        }),
      ).toThrow(ForbiddenError);
    });

    test("interaction is NOT consumed when target client has no stored actor", () => {
      const requestId = "req-file-target-no-actor-stays";
      registerPending(requestId, { targetClientId: "client-A" });

      try {
        handleHostFileResult({
          body: fileBody(requestId),
          headers: {
            "x-vellum-client-id": "client-A",
            "x-vellum-actor-principal-id": "actor-1",
          },
        });
      } catch {
        // expected
      }

      expect(resolvedIds).not.toContain(requestId);
      expect(pendingStore.has(requestId)).toBe(true);
    });
  });
});
