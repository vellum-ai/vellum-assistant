/**
 * Unit tests for the /v1/host-browser-result route handler.
 *
 * Tests handleHostBrowserResult directly via RouteHandlerArgs with a
 * stub Conversation whose resolveHostBrowser method records calls.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import type { Conversation } from "../daemon/conversation.js";

// ── Module mocks ─────────────────────────────────────────────────────

mock.module("../config/env.js", () => ({
  isHttpAuthDisabled: () => true,
  hasUngatedHttpAuthDisabled: () => false,
}));

// ── Real imports (after mocks) ───────────────────────────────────────

import * as pendingInteractions from "../runtime/pending-interactions.js";
import { BadRequestError, ConflictError, NotFoundError } from "../runtime/routes/errors.js";
import { ROUTES } from "../runtime/routes/host-browser-routes.js";

afterAll(() => {
  mock.restore();
});

const handleHostBrowserResult = ROUTES.find(
  (r) => r.endpoint === "host-browser-result",
)!.handler;

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

// ── Tests ────────────────────────────────────────────────────────────

describe("handleHostBrowserResult", () => {
  beforeEach(() => {
    pendingInteractions.clear();
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

    const result = await handleHostBrowserResult({
      body: { requestId, content: "ok", isError: false },
    });

    expect(result).toEqual({ accepted: true });
    expect(spy).toHaveLength(1);
    expect(spy[0].requestId).toBe(requestId);
    expect(spy[0].response).toEqual({ content: "ok", isError: false });

    // Pending interaction should be consumed
    expect(pendingInteractions.get(requestId)).toBeUndefined();
  });

  test("missing body: throws BadRequestError", () => {
    expect(() => handleHostBrowserResult({})).toThrow(BadRequestError);
  });

  test("missing requestId: throws BadRequestError", () => {
    expect(() =>
      handleHostBrowserResult({ body: { content: "x" } }),
    ).toThrow(BadRequestError);
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

  test("wrong kind: throws ConflictError with mismatch message", () => {
    const spy: ResolveHostBrowserCall[] = [];
    const conversation = makeStubConversation(spy);
    const requestId = "browser-req-wrong-kind";

    pendingInteractions.register(requestId, {
      conversation,
      conversationId: "conv-1",
      kind: "host_bash",
    });

    expect(() =>
      handleHostBrowserResult({
        body: { requestId, content: "x", isError: false },
      }),
    ).toThrow(ConflictError);

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

    const result = await handleHostBrowserResult({ body: { requestId } });

    expect(result).toEqual({ accepted: true });
    expect(spy).toHaveLength(1);
    expect(spy[0].requestId).toBe(requestId);
    expect(spy[0].response).toEqual({ content: "", isError: false });
  });
});
