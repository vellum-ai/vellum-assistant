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

import { BadRequestError, NotFoundError } from "../runtime/routes/errors.js";
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
