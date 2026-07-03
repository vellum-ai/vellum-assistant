/**
 * Unit tests for the /v1/host-app-control-result route handler.
 *
 * Resolution flows through `pendingInteractions.get/resolve` → `findConversation`
 * → `conversation.hostAppControlProxy.resolve`. Late delivery (no pending
 * interaction or no conversation) returns 200 without crashing.
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

interface PendingEntry {
  conversationId: string;
  kind: string;
  targetClientId?: string;
  targetActorPrincipalId?: string;
}

const pending = new Map<string, PendingEntry>();

mock.module("../runtime/pending-interactions.js", () => ({
  get: (requestId: string) => pending.get(requestId),
  resolve: (requestId: string) => {
    const entry = pending.get(requestId);
    if (entry) pending.delete(requestId);
    return entry;
  },
}));

interface FakeConversation {
  conversationId: string;
  hostAppControlProxy?: {
    resolve: (requestId: string, payload: unknown) => void;
  };
}

const conversations = new Map<string, FakeConversation>();

mock.module("../daemon/conversation-registry.js", () => ({
  findConversation: (id: string) => conversations.get(id),
}));

// ── Real imports (after mocks) ───────────────────────────────────────

import { BadRequestError, ForbiddenError } from "../runtime/routes/errors.js";
import { ROUTES } from "../runtime/routes/host-app-control-routes.js";

afterAll(() => {
  mock.restore();
});

const handleHostAppControlResult = ROUTES.find(
  (r) => r.endpoint === "host-app-control-result",
)!.handler as (args: Record<string, unknown>) => Promise<unknown>;

// ── Tests ────────────────────────────────────────────────────────────

describe("handleHostAppControlResult", () => {
  beforeEach(() => {
    pending.clear();
    conversations.clear();
  });

  test("happy path: forwards payload to conversation.hostAppControlProxy.resolve", async () => {
    const requestId = "ac-req-happy";
    const conversationId = "conv-1";
    pending.set(requestId, { conversationId, kind: "host_app_control" });

    const resolveCalls: Array<{ requestId: string; payload: unknown }> = [];
    conversations.set(conversationId, {
      conversationId,
      hostAppControlProxy: {
        resolve(rid, payload) {
          resolveCalls.push({ requestId: rid, payload });
        },
      },
    });

    const result = await handleHostAppControlResult({
      body: {
        requestId,
        state: "running",
        pngBase64: "AAAA",
        windowBounds: { x: 1, y: 2, width: 800, height: 600 },
        executionResult: "ok",
      },
    });

    expect(result).toEqual({ accepted: true });
    expect(resolveCalls).toHaveLength(1);
    expect(resolveCalls[0].requestId).toBe(requestId);
    expect(resolveCalls[0].payload).toEqual({
      requestId,
      state: "running",
      pngBase64: "AAAA",
      windowBounds: { x: 1, y: 2, width: 800, height: 600 },
      executionResult: "ok",
    });

    // Pending interaction was consumed.
    expect(pending.has(requestId)).toBe(false);
  });

  test("happy path: end-to-end resolves the awaiting proxy promise with the payload", async () => {
    const requestId = "ac-req-await";
    const conversationId = "conv-await";
    pending.set(requestId, { conversationId, kind: "host_app_control" });

    // Wire a real awaiter — this mirrors the proxy's pending map behavior
    // without coupling the route test to HostProxyBase internals.
    let resolved: unknown;
    const awaitable = new Promise<unknown>((resolveFn) => {
      conversations.set(conversationId, {
        conversationId,
        hostAppControlProxy: {
          resolve(rid, payload) {
            if (rid === requestId) resolveFn(payload);
          },
        },
      });
    }).then((p) => {
      resolved = p;
      return p;
    });

    await handleHostAppControlResult({
      body: { requestId, state: "running", executionResult: "done" },
    });
    await awaitable;

    expect(resolved).toEqual({
      requestId,
      state: "running",
      executionResult: "done",
    });
  });

  test("late delivery (no pending interaction): returns 200, no crash", async () => {
    const result = await handleHostAppControlResult({
      body: {
        requestId: "no-such-request",
        state: "running",
      },
    });
    expect(result).toEqual({ accepted: true });
  });

  test("late delivery (conversation gone): returns 200, no crash", async () => {
    const requestId = "ac-req-orphan";
    pending.set(requestId, {
      conversationId: "conv-gone",
      kind: "host_app_control",
    });
    // No conversation registered for "conv-gone".

    const result = await handleHostAppControlResult({
      body: { requestId, state: "running" },
    });
    expect(result).toEqual({ accepted: true });
    // Pending interaction was still consumed so it cannot leak.
    expect(pending.has(requestId)).toBe(false);
  });

  test("late delivery (proxy missing on conversation): returns 200, no crash", async () => {
    const requestId = "ac-req-noproxy";
    const conversationId = "conv-no-proxy";
    pending.set(requestId, { conversationId, kind: "host_app_control" });
    conversations.set(conversationId, { conversationId }); // hostAppControlProxy undefined

    const result = await handleHostAppControlResult({
      body: { requestId, state: "running" },
    });
    expect(result).toEqual({ accepted: true });
    expect(pending.has(requestId)).toBe(false);
  });

  test("wrong pending kind: returns 200 without forwarding (treated as late delivery)", async () => {
    const requestId = "ac-req-wrong-kind";
    pending.set(requestId, { conversationId: "conv-1", kind: "host_cu" });

    const resolveCalls: unknown[] = [];
    conversations.set("conv-1", {
      conversationId: "conv-1",
      hostAppControlProxy: {
        resolve: () => resolveCalls.push("called"),
      },
    });

    const result = await handleHostAppControlResult({
      body: { requestId, state: "running" },
    });

    expect(result).toEqual({ accepted: true });
    expect(resolveCalls).toHaveLength(0);
    // Wrong-kind interaction is not consumed.
    expect(pending.has(requestId)).toBe(true);
  });

  test("malformed body (missing): throws BadRequestError", () => {
    expect(() => handleHostAppControlResult({})).toThrow(BadRequestError);
  });

  test("malformed body (non-object): throws BadRequestError", () => {
    expect(() =>
      handleHostAppControlResult({
        body: "not an object" as unknown as Record<string, unknown>,
      }),
    ).toThrow(BadRequestError);
  });

  test("malformed body (missing requestId): throws BadRequestError", () => {
    expect(() =>
      handleHostAppControlResult({ body: { state: "running" } }),
    ).toThrow(BadRequestError);
  });

  test("malformed body (missing state): throws BadRequestError", () => {
    expect(() =>
      handleHostAppControlResult({ body: { requestId: "abc" } }),
    ).toThrow(BadRequestError);
  });

  test("malformed body (invalid state): throws BadRequestError", () => {
    expect(() =>
      handleHostAppControlResult({
        body: { requestId: "abc", state: "exploded" },
      }),
    ).toThrow(BadRequestError);
  });

  test("payload omits undefined optional fields (no leaking undefined keys)", async () => {
    const requestId = "ac-req-min";
    const conversationId = "conv-min";
    pending.set(requestId, { conversationId, kind: "host_app_control" });

    const resolveCalls: Array<{ payload: unknown }> = [];
    conversations.set(conversationId, {
      conversationId,
      hostAppControlProxy: {
        resolve(_rid, payload) {
          resolveCalls.push({ payload });
        },
      },
    });

    await handleHostAppControlResult({
      body: { requestId, state: "minimized" },
    });

    expect(resolveCalls).toHaveLength(1);
    const payload = resolveCalls[0].payload as Record<string, unknown>;
    expect(payload).toEqual({ requestId, state: "minimized" });
    expect(Object.prototype.hasOwnProperty.call(payload, "pngBase64")).toBe(
      false,
    );
    expect(Object.prototype.hasOwnProperty.call(payload, "windowBounds")).toBe(
      false,
    );
  });
});

// ── Same-actor guard ───────────────────────────────────────────────────

describe("handleHostAppControlResult — same-actor guard", () => {
  beforeEach(() => {
    pending.clear();
    conversations.clear();
  });

  function setupConversation(
    conversationId: string,
    resolveCalls: Array<{ requestId: string; payload: unknown }>,
  ) {
    conversations.set(conversationId, {
      conversationId,
      hostAppControlProxy: {
        resolve(rid, payload) {
          resolveCalls.push({ requestId: rid, payload });
        },
      },
    });
  }

  // ── Non-targeted (backward compat) → 200 ──────────────────────────────

  test("non-targeted (no targetClientId): resolves normally without header check", async () => {
    const requestId = "ac-req-untargeted";
    const conversationId = "conv-untargeted";
    pending.set(requestId, { conversationId, kind: "host_app_control" });
    const resolveCalls: Array<{ requestId: string; payload: unknown }> = [];
    setupConversation(conversationId, resolveCalls);

    const result = await handleHostAppControlResult({
      body: { requestId, state: "running" },
    });

    expect(result).toEqual({ accepted: true });
    expect(resolveCalls).toHaveLength(1);
  });

  // ── Targeted + correct headers → 200 ─────────────────────────────────

  test("targeted + matching client id and actor principal: returns 200", async () => {
    const requestId = "ac-req-targeted-match";
    const conversationId = "conv-targeted";
    pending.set(requestId, {
      conversationId,
      kind: "host_app_control",
      targetClientId: "client-A",
      targetActorPrincipalId: "user-1",
    });
    const resolveCalls: Array<{ requestId: string; payload: unknown }> = [];
    setupConversation(conversationId, resolveCalls);

    const result = await handleHostAppControlResult({
      body: { requestId, state: "running" },
      headers: {
        "x-vellum-client-id": "client-A",
        "x-vellum-actor-principal-id": "user-1",
      },
    });

    expect(result).toEqual({ accepted: true });
    expect(resolveCalls).toHaveLength(1);
    expect(resolveCalls[0].requestId).toBe(requestId);
  });

  test("targeted + correct headers: trims whitespace from client-id before comparing", async () => {
    const requestId = "ac-req-targeted-trim";
    const conversationId = "conv-trim";
    pending.set(requestId, {
      conversationId,
      kind: "host_app_control",
      targetClientId: "client-A",
      targetActorPrincipalId: "user-1",
    });
    const resolveCalls: Array<{ requestId: string; payload: unknown }> = [];
    setupConversation(conversationId, resolveCalls);

    const result = await handleHostAppControlResult({
      body: { requestId, state: "running" },
      headers: {
        "x-vellum-client-id": "  client-A  ",
        "x-vellum-actor-principal-id": "user-1",
      },
    });

    expect(result).toEqual({ accepted: true });
    expect(resolveCalls).toHaveLength(1);
  });

  // ── Targeted + missing x-vellum-client-id → 400 ──────────────────────

  test("targeted + missing x-vellum-client-id: throws BadRequestError", () => {
    const requestId = "ac-req-targeted-no-header";
    pending.set(requestId, {
      conversationId: "conv-1",
      kind: "host_app_control",
      targetClientId: "client-A",
      targetActorPrincipalId: "user-1",
    });

    expect(() =>
      handleHostAppControlResult({
        body: { requestId, state: "running" },
      }),
    ).toThrow(BadRequestError);
  });

  test("targeted + whitespace-only x-vellum-client-id: throws BadRequestError", () => {
    const requestId = "ac-req-targeted-empty-header";
    pending.set(requestId, {
      conversationId: "conv-1",
      kind: "host_app_control",
      targetClientId: "client-A",
      targetActorPrincipalId: "user-1",
    });

    expect(() =>
      handleHostAppControlResult({
        body: { requestId, state: "running" },
        headers: { "x-vellum-client-id": "   " },
      }),
    ).toThrow(BadRequestError);
  });

  test("targeted + missing header: interaction is NOT consumed (still pending)", async () => {
    const requestId = "ac-req-targeted-no-header-stays";
    pending.set(requestId, {
      conversationId: "conv-1",
      kind: "host_app_control",
      targetClientId: "client-A",
      targetActorPrincipalId: "user-1",
    });

    await handleHostAppControlResult({
      body: { requestId, state: "running" },
    }).catch(() => {
      // expected
    });

    expect(pending.has(requestId)).toBe(true);
  });

  // ── Targeted + mismatched client id → 403 ────────────────────────────

  test("targeted + wrong client id: throws ForbiddenError", () => {
    const requestId = "ac-req-targeted-wrong-client";
    pending.set(requestId, {
      conversationId: "conv-1",
      kind: "host_app_control",
      targetClientId: "client-A",
      targetActorPrincipalId: "user-1",
    });

    expect(() =>
      handleHostAppControlResult({
        body: { requestId, state: "running" },
        headers: {
          "x-vellum-client-id": "client-B",
          "x-vellum-actor-principal-id": "user-1",
        },
      }),
    ).toThrow(ForbiddenError);
  });

  test("targeted + wrong client id: interaction is NOT consumed", async () => {
    const requestId = "ac-req-targeted-wrong-client-stays";
    pending.set(requestId, {
      conversationId: "conv-1",
      kind: "host_app_control",
      targetClientId: "client-A",
      targetActorPrincipalId: "user-1",
    });

    await handleHostAppControlResult({
      body: { requestId, state: "running" },
      headers: {
        "x-vellum-client-id": "client-B",
        "x-vellum-actor-principal-id": "user-1",
      },
    }).catch(() => {
      // expected
    });

    expect(pending.has(requestId)).toBe(true);
  });

  // ── Targeted + mismatched actor principal → 403 ───────────────────────

  test("targeted + wrong actor principal: throws ForbiddenError", () => {
    const requestId = "ac-req-targeted-wrong-actor";
    pending.set(requestId, {
      conversationId: "conv-1",
      kind: "host_app_control",
      targetClientId: "client-A",
      targetActorPrincipalId: "user-1",
    });

    expect(() =>
      handleHostAppControlResult({
        body: { requestId, state: "running" },
        headers: {
          "x-vellum-client-id": "client-A",
          "x-vellum-actor-principal-id": "user-2",
        },
      }),
    ).toThrow(ForbiddenError);
  });

  test("targeted + wrong actor principal: interaction is NOT consumed", async () => {
    const requestId = "ac-req-targeted-wrong-actor-stays";
    pending.set(requestId, {
      conversationId: "conv-1",
      kind: "host_app_control",
      targetClientId: "client-A",
      targetActorPrincipalId: "user-1",
    });

    await handleHostAppControlResult({
      body: { requestId, state: "running" },
      headers: {
        "x-vellum-client-id": "client-A",
        "x-vellum-actor-principal-id": "user-2",
      },
    }).catch(() => {
      // expected
    });

    expect(pending.has(requestId)).toBe(true);
  });
});
