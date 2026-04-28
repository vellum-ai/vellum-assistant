/**
 * Unit tests for the /v1/host-browser-result route handler.
 *
 * Resolution goes through HostBrowserProxy.instance (singleton) rather
 * than per-conversation. The mock below controls what .instance returns.
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
let mockProxyAvailable = true;

mock.module("../daemon/host-browser-proxy.js", () => ({
  HostBrowserProxy: {
    get instance() {
      if (!mockProxyAvailable) return undefined;
      return {
        resolve(
          requestId: string,
          response: { content: string; isError: boolean },
        ) {
          resolveSpy.push({ requestId, response });
        },
      };
    },
  },
}));

// ── Real imports (after mocks) ───────────────────────────────────────

import * as pendingInteractions from "../runtime/pending-interactions.js";
import {
  BadRequestError,
  ConflictError,
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
    mockProxyAvailable = true;
  });

  test("happy path: resolves a pending host_browser interaction via singleton", async () => {
    const requestId = "browser-req-happy";

    pendingInteractions.register(requestId, {
      conversation: null,
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

    // Pending interaction should be consumed
    expect(pendingInteractions.get(requestId)).toBeUndefined();
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

  test("wrong kind: throws ConflictError with mismatch message", () => {
    const requestId = "browser-req-wrong-kind";

    pendingInteractions.register(requestId, {
      conversation: null,
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
    expect(resolveSpy).toHaveLength(0);
  });

  test("defaults: missing content/isError default to '' and false", async () => {
    const requestId = "browser-req-defaults";

    pendingInteractions.register(requestId, {
      conversation: null,
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
