/**
 * Unit tests for the /v1/host-browser-result route handler.
 *
 * Tests handleHostBrowserResult directly with mocked AuthContext, Request,
 * and a stub Conversation whose resolveHostBrowser method records calls.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import type { Conversation } from "../daemon/conversation.js";
import type { AuthContext } from "../runtime/auth/types.js";

// ── Module mocks ─────────────────────────────────────────────────────

let fakeHttpAuthDisabled = true;

mock.module("../config/env.js", () => ({
  isHttpAuthDisabled: () => fakeHttpAuthDisabled,
  hasUngatedHttpAuthDisabled: () => false,
}));

// ── Real imports (after mocks) ───────────────────────────────────────

import * as pendingInteractions from "../runtime/pending-interactions.js";
import { handleHostBrowserResult } from "../runtime/routes/host-browser-routes.js";

afterAll(() => {
  mock.restore();
});

// ── Helpers ──────────────────────────────────────────────────────────

interface ResolveHostBrowserCall {
  requestId: string;
  response: { content: string; isError: boolean };
}

function makeStubConversation(spy: ResolveHostBrowserCall[]): Conversation {
  return {
    resolveHostBrowser(
      requestId: string,
      response: { content: string; isError: boolean },
    ) {
      spy.push({ requestId, response });
    },
  } as unknown as Conversation;
}

const AUTHED_CONTEXT: AuthContext = {
  subject: "actor:test",
  principalType: "actor",
  assistantId: "test-assistant",
  actorPrincipalId: "actor-principal-1",
  scopeProfile: "actor_client_v1",
  scopes: new Set(),
  policyEpoch: 0,
};

const UNAUTHED_CONTEXT: AuthContext = {
  subject: "actor:test",
  principalType: "actor",
  assistantId: "test-assistant",
  // actorPrincipalId intentionally absent
  scopeProfile: "actor_client_v1",
  scopes: new Set(),
  policyEpoch: 0,
};

function makeJsonRequest(body: unknown): Request {
  return new Request("http://localhost/v1/host-browser-result", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ── Tests ────────────────────────────────────────────────────────────

describe("handleHostBrowserResult", () => {
  beforeEach(() => {
    pendingInteractions.clear();
    fakeHttpAuthDisabled = true;
  });

  test("happy path: resolves a pending host_browser interaction", async () => {
    const spy: ResolveHostBrowserCall[] = [];
    const conversation = makeStubConversation(spy);
    const requestId = "browser-req-happy";

    pendingInteractions.register(requestId, {
      conversation,
      conversationId: "conv-1",
      kind: "host_browser",
    });

    const req = makeJsonRequest({
      requestId,
      content: "ok",
      isError: false,
    });

    const res = await handleHostBrowserResult(req, AUTHED_CONTEXT);
    const body = (await res.json()) as { accepted: boolean };

    expect(res.status).toBe(200);
    expect(body.accepted).toBe(true);
    expect(spy).toHaveLength(1);
    expect(spy[0].requestId).toBe(requestId);
    expect(spy[0].response).toEqual({ content: "ok", isError: false });

    // Pending interaction should be consumed
    expect(pendingInteractions.get(requestId)).toBeUndefined();
  });

  test("unauthorized: returns 403 when actor is not guardian-bound", async () => {
    fakeHttpAuthDisabled = false;

    const req = makeJsonRequest({
      requestId: "browser-req-unauth",
      content: "anything",
      isError: false,
    });

    const res = await handleHostBrowserResult(req, UNAUTHED_CONTEXT);
    expect(res.status).toBe(403);
  });

  test("missing requestId: returns 400", async () => {
    const req = makeJsonRequest({ content: "x" });

    const res = await handleHostBrowserResult(req, AUTHED_CONTEXT);
    expect(res.status).toBe(400);
  });

  test("unknown requestId: returns 404", async () => {
    const req = makeJsonRequest({
      requestId: "00000000-0000-0000-0000-000000000000",
      content: "x",
      isError: false,
    });

    const res = await handleHostBrowserResult(req, AUTHED_CONTEXT);
    expect(res.status).toBe(404);
  });

  test("wrong kind: returns 409 with mismatch message", async () => {
    const spy: ResolveHostBrowserCall[] = [];
    const conversation = makeStubConversation(spy);
    const requestId = "browser-req-wrong-kind";

    pendingInteractions.register(requestId, {
      conversation,
      conversationId: "conv-1",
      kind: "host_bash",
    });

    const req = makeJsonRequest({
      requestId,
      content: "x",
      isError: false,
    });

    const res = await handleHostBrowserResult(req, AUTHED_CONTEXT);
    expect(res.status).toBe(409);

    const body = (await res.json()) as {
      error: { message: string; code?: string };
    };
    expect(body.error.message).toContain('"host_bash"');
    expect(body.error.message).toContain('"host_browser"');

    // Pending interaction should NOT have been consumed
    expect(pendingInteractions.get(requestId)).toBeDefined();
    expect(spy).toHaveLength(0);
  });

  test("defaults: missing content/isError default to '' and false", async () => {
    const spy: ResolveHostBrowserCall[] = [];
    const conversation = makeStubConversation(spy);
    const requestId = "browser-req-defaults";

    pendingInteractions.register(requestId, {
      conversation,
      conversationId: "conv-1",
      kind: "host_browser",
    });

    const req = makeJsonRequest({ requestId });

    const res = await handleHostBrowserResult(req, AUTHED_CONTEXT);
    const body = (await res.json()) as { accepted: boolean };

    expect(res.status).toBe(200);
    expect(body.accepted).toBe(true);
    expect(spy).toHaveLength(1);
    expect(spy[0].requestId).toBe(requestId);
    expect(spy[0].response).toEqual({ content: "", isError: false });
  });
});
