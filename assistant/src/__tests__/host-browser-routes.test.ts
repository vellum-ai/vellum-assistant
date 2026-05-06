/**
 * Unit tests for the /v1/host-browser-result route handler.
 *
 * Resolution goes through HostBrowserProxy.instance (singleton). The
 * mock below spies on resolveResult; the real pendingInteractions
 * module provides the guard check for unknown request IDs.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// ── Module mocks ─────────────────────────────────────────────────────

mock.module("../config/env.js", () => ({
  isHttpAuthDisabled: () => true,
  hasUngatedHttpAuthDisabled: () => false,
}));

// local-actor-identity reads the contacts table; stub it to a passthrough so
// the resolver returns whatever header value the test provides.
mock.module("../runtime/local-actor-identity.js", () => ({
  resolveActorPrincipalIdForLocalGuardian: (raw: string | undefined) => raw,
}));

interface ResolveCall {
  requestId: string;
  response: { content: string; isError: boolean };
}

const resolveSpy: ResolveCall[] = [];

mock.module("../daemon/host-browser-proxy.js", () => ({
  HostBrowserProxy: {
    get instance() {
      return {
        resolveResult(
          requestId: string,
          response: { content: string; isError: boolean },
        ) {
          resolveSpy.push({ requestId, response });
        },
      };
    },
  },
}));

// Use the real pending-interactions module for the guard check.
const pendingInteractions = await import("../runtime/pending-interactions.js");

// ── Real imports (after mocks) ───────────────────────────────────────

import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../runtime/routes/errors.js";
import { ROUTES } from "../runtime/routes/host-browser-routes.js";

afterAll(() => {
  mock.restore();
});

const handleHostBrowserResult = ROUTES.find(
  (r) => r.endpoint === "host-browser-result",
)!.handler;

// ── Tests ────────────────────────────────────────────────────────────

describe("handleHostBrowserResult", () => {
  beforeEach(() => {
    pendingInteractions.clear();
    resolveSpy.length = 0;
  });

  test("happy path: resolves a pending host_browser request via singleton", async () => {
    const requestId = "browser-req-happy";
    pendingInteractions.register(requestId, {
      conversationId: "conv-1",
      kind: "host_browser",
    });

    const result = await handleHostBrowserResult({
      body: { requestId, content: "ok", isError: false },
    });

    expect(result).toEqual({ accepted: true });
    expect(resolveSpy).toHaveLength(1);
    expect(resolveSpy[0].requestId).toBe(requestId);
    expect(resolveSpy[0].response).toEqual({ content: "ok", isError: false });
  });

  test("missing body: throws BadRequestError", () => {
    expect(() => handleHostBrowserResult({})).toThrow(BadRequestError);
  });

  test("missing requestId: throws BadRequestError", () => {
    expect(() => handleHostBrowserResult({ body: { content: "x" } })).toThrow(
      BadRequestError,
    );
  });

  test("unknown requestId: throws NotFoundError", () => {
    expect(() =>
      handleHostBrowserResult({
        body: {
          requestId: "00000000-0000-0000-0000-000000000000",
          content: "x",
          isError: false,
        },
      }),
    ).toThrow(NotFoundError);
  });

  test("kind mismatch: throws ConflictError when pending interaction is not host_browser", () => {
    const requestId = "bash-req-kind-mismatch";
    pendingInteractions.register(requestId, {
      conversationId: "conv-1",
      kind: "host_bash", // wrong kind
    });

    expect(() =>
      handleHostBrowserResult({
        body: { requestId, content: "x", isError: false },
      }),
    ).toThrow(ConflictError);

    // Interaction must NOT have been consumed — the bash proxy can still resolve it
    expect(pendingInteractions.get(requestId)).toBeDefined();
    // resolveResult should never have been called
    expect(resolveSpy).toHaveLength(0);
  });

  test("defaults: missing content/isError default to '' and false", async () => {
    const requestId = "browser-req-defaults";
    pendingInteractions.register(requestId, {
      conversationId: "conv-1",
      kind: "host_browser",
    });

    const result = await handleHostBrowserResult({ body: { requestId } });

    expect(result).toEqual({ accepted: true });
    expect(resolveSpy).toHaveLength(1);
    expect(resolveSpy[0].requestId).toBe(requestId);
    expect(resolveSpy[0].response).toEqual({ content: "", isError: false });
  });
});

// ── Same-actor guard ───────────────────────────────────────────────────

describe("handleHostBrowserResult — same-actor guard", () => {
  beforeEach(() => {
    pendingInteractions.clear();
    resolveSpy.length = 0;
  });

  // ── Targeted + correct headers → 200 ─────────────────────────────────

  describe("targeted + correct x-vellum-client-id + actor-principal", () => {
    test("returns { accepted: true } and resolves the interaction", async () => {
      const requestId = "browser-req-targeted-match";
      pendingInteractions.register(requestId, {
        conversationId: "conv-1",
        kind: "host_browser",
        targetClientId: "client-A",
        targetActorPrincipalId: "user-1",
      });

      const result = await handleHostBrowserResult({
        body: { requestId, content: "ok", isError: false },
        headers: {
          "x-vellum-client-id": "client-A",
          "x-vellum-actor-principal-id": "user-1",
        },
      });

      expect(result).toEqual({ accepted: true });
      expect(resolveSpy).toHaveLength(1);
      expect(resolveSpy[0].requestId).toBe(requestId);
    });

    test("trims whitespace from x-vellum-client-id before comparing", async () => {
      const requestId = "browser-req-targeted-trim";
      pendingInteractions.register(requestId, {
        conversationId: "conv-1",
        kind: "host_browser",
        targetClientId: "client-A",
        targetActorPrincipalId: "user-1",
      });

      const result = await handleHostBrowserResult({
        body: { requestId, content: "ok", isError: false },
        headers: {
          "x-vellum-client-id": "  client-A  ",
          "x-vellum-actor-principal-id": "user-1",
        },
      });

      expect(result).toEqual({ accepted: true });
    });
  });

  // ── Targeted + missing x-vellum-client-id → 400 ──────────────────────

  describe("targeted + missing x-vellum-client-id", () => {
    test("throws BadRequestError when header is absent", () => {
      const requestId = "browser-req-targeted-no-header";
      pendingInteractions.register(requestId, {
        conversationId: "conv-1",
        kind: "host_browser",
        targetClientId: "client-A",
        targetActorPrincipalId: "user-1",
      });

      expect(() =>
        handleHostBrowserResult({
          body: { requestId, content: "ok", isError: false },
        }),
      ).toThrow(BadRequestError);
    });

    test("throws BadRequestError when header is whitespace only", () => {
      const requestId = "browser-req-targeted-empty-header";
      pendingInteractions.register(requestId, {
        conversationId: "conv-1",
        kind: "host_browser",
        targetClientId: "client-A",
        targetActorPrincipalId: "user-1",
      });

      expect(() =>
        handleHostBrowserResult({
          body: { requestId, content: "ok", isError: false },
          headers: { "x-vellum-client-id": "   " },
        }),
      ).toThrow(BadRequestError);
    });

    test("interaction is NOT consumed on 400 (still pending)", () => {
      const requestId = "browser-req-targeted-no-header-stays";
      pendingInteractions.register(requestId, {
        conversationId: "conv-1",
        kind: "host_browser",
        targetClientId: "client-A",
        targetActorPrincipalId: "user-1",
      });

      try {
        handleHostBrowserResult({
          body: { requestId, content: "ok", isError: false },
        });
      } catch {
        // expected
      }

      expect(pendingInteractions.get(requestId)).toBeDefined();
      expect(resolveSpy).toHaveLength(0);
    });
  });

  // ── Targeted + wrong x-vellum-client-id → 403 ────────────────────────

  describe("targeted + wrong x-vellum-client-id", () => {
    test("throws ForbiddenError when client id does not match target", () => {
      const requestId = "browser-req-targeted-client-mismatch";
      pendingInteractions.register(requestId, {
        conversationId: "conv-1",
        kind: "host_browser",
        targetClientId: "client-A",
        targetActorPrincipalId: "user-1",
      });

      expect(() =>
        handleHostBrowserResult({
          body: { requestId, content: "ok", isError: false },
          headers: {
            "x-vellum-client-id": "client-B",
            "x-vellum-actor-principal-id": "user-1",
          },
        }),
      ).toThrow(ForbiddenError);
    });

    test("ForbiddenError message names both submitting and expected client", () => {
      const requestId = "browser-req-targeted-mismatch-msg";
      pendingInteractions.register(requestId, {
        conversationId: "conv-1",
        kind: "host_browser",
        targetClientId: "client-A",
        targetActorPrincipalId: "user-1",
      });

      let caught: unknown;
      try {
        handleHostBrowserResult({
          body: { requestId, content: "ok", isError: false },
          headers: {
            "x-vellum-client-id": "client-B",
            "x-vellum-actor-principal-id": "user-1",
          },
        });
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(ForbiddenError);
      const msg = (caught as ForbiddenError).message;
      expect(msg).toContain("client-A");
      expect(msg).toContain("client-B");
    });

    test("interaction is NOT consumed on 403 (still pending)", () => {
      const requestId = "browser-req-targeted-mismatch-stays";
      pendingInteractions.register(requestId, {
        conversationId: "conv-1",
        kind: "host_browser",
        targetClientId: "client-A",
        targetActorPrincipalId: "user-1",
      });

      try {
        handleHostBrowserResult({
          body: { requestId, content: "ok", isError: false },
          headers: {
            "x-vellum-client-id": "client-B",
            "x-vellum-actor-principal-id": "user-1",
          },
        });
      } catch {
        // expected
      }

      expect(pendingInteractions.get(requestId)).toBeDefined();
      expect(resolveSpy).toHaveLength(0);
    });
  });

  // ── Targeted + actor-principal binding (defense-in-depth) ────────────

  describe("targeted + actor-principal binding", () => {
    test("throws ForbiddenError when submitting actor does not match target's actor", () => {
      const requestId = "browser-req-actor-mismatch";
      pendingInteractions.register(requestId, {
        conversationId: "conv-1",
        kind: "host_browser",
        targetClientId: "client-A",
        targetActorPrincipalId: "user-1",
      });

      expect(() =>
        handleHostBrowserResult({
          body: { requestId, content: "ok", isError: false },
          headers: {
            "x-vellum-client-id": "client-A",
            "x-vellum-actor-principal-id": "user-2",
          },
        }),
      ).toThrow(ForbiddenError);
    });

    test("throws ForbiddenError when submitting actor header is missing", () => {
      const requestId = "browser-req-actor-missing";
      pendingInteractions.register(requestId, {
        conversationId: "conv-1",
        kind: "host_browser",
        targetClientId: "client-A",
        targetActorPrincipalId: "user-1",
      });

      expect(() =>
        handleHostBrowserResult({
          body: { requestId, content: "ok", isError: false },
          headers: { "x-vellum-client-id": "client-A" },
        }),
      ).toThrow(ForbiddenError);
    });

    test("throws ForbiddenError when target has no captured actor principal", () => {
      const requestId = "browser-req-actor-no-target";
      pendingInteractions.register(requestId, {
        conversationId: "conv-1",
        kind: "host_browser",
        targetClientId: "client-A",
        // targetActorPrincipalId intentionally omitted
      });

      expect(() =>
        handleHostBrowserResult({
          body: { requestId, content: "ok", isError: false },
          headers: {
            "x-vellum-client-id": "client-A",
            "x-vellum-actor-principal-id": "user-1",
          },
        }),
      ).toThrow(ForbiddenError);
    });

    test("interaction NOT consumed on actor-mismatch 403", () => {
      const requestId = "browser-req-actor-mismatch-stays";
      pendingInteractions.register(requestId, {
        conversationId: "conv-1",
        kind: "host_browser",
        targetClientId: "client-A",
        targetActorPrincipalId: "user-1",
      });

      try {
        handleHostBrowserResult({
          body: { requestId, content: "ok", isError: false },
          headers: {
            "x-vellum-client-id": "client-A",
            "x-vellum-actor-principal-id": "user-2",
          },
        });
      } catch {
        // expected
      }

      expect(pendingInteractions.get(requestId)).toBeDefined();
      expect(resolveSpy).toHaveLength(0);
    });
  });

  // ── Untargeted (no targetClientId) — regression ───────────────────────

  describe("untargeted (no targetClientId)", () => {
    test("accepts when no headers are provided", async () => {
      const requestId = "browser-req-untargeted-no-header";
      pendingInteractions.register(requestId, {
        conversationId: "conv-1",
        kind: "host_browser",
      });

      const result = await handleHostBrowserResult({
        body: { requestId, content: "ok", isError: false },
      });

      expect(result).toEqual({ accepted: true });
      expect(resolveSpy).toHaveLength(1);
    });

    test("accepts when header is present (header ignored when untargeted)", async () => {
      const requestId = "browser-req-untargeted-with-header";
      pendingInteractions.register(requestId, {
        conversationId: "conv-1",
        kind: "host_browser",
      });

      const result = await handleHostBrowserResult({
        body: { requestId, content: "ok", isError: false },
        headers: { "x-vellum-client-id": "anything" },
      });

      expect(result).toEqual({ accepted: true });
      expect(resolveSpy).toHaveLength(1);
    });
  });
});
