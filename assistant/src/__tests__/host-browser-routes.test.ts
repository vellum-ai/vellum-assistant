/**
 * Unit tests for the /v1/host-browser-result route handler.
 *
 * Resolution goes through HostBrowserProxy.instance (singleton). The
 * mock below controls the proxy's pending request map and resolve spy.
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
const pendingRequests = new Set<string>();

mock.module("../daemon/host-browser-proxy.js", () => ({
  HostBrowserProxy: {
    get instance() {
      return {
        hasPendingRequest(requestId: string) {
          return pendingRequests.has(requestId);
        },
        resolve(
          requestId: string,
          response: { content: string; isError: boolean },
        ) {
          pendingRequests.delete(requestId);
          resolveSpy.push({ requestId, response });
        },
      };
    },
  },
}));

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
    pendingRequests.clear();
    resolveSpy.length = 0;
  });

  test("happy path: resolves a pending host_browser request via singleton", async () => {
    const requestId = "browser-req-happy";
    pendingRequests.add(requestId);

    const result = await handleHostBrowserResult({
      body: { requestId, content: "ok", isError: false },
    });

    expect(result).toEqual({ accepted: true });
    expect(resolveSpy).toHaveLength(1);
    expect(resolveSpy[0].requestId).toBe(requestId);
    expect(resolveSpy[0].response).toEqual({ content: "ok", isError: false });

    expect(pendingRequests.has(requestId)).toBe(false);
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
    pendingRequests.add(requestId);

    const result = await handleHostBrowserResult({ body: { requestId } });

    expect(result).toEqual({ accepted: true });
    expect(resolveSpy).toHaveLength(1);
    expect(resolveSpy[0].requestId).toBe(requestId);
    expect(resolveSpy[0].response).toEqual({ content: "", isError: false });
  });
});
