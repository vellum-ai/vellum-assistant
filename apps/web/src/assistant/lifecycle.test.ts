import { describe, expect, test } from "bun:test";

import {
  ERROR_RETRY_BASE_MS,
  ERROR_RETRY_MAX_MS,
  errorRetryDelayMs,
  isTransportShapedError,
  PROXY_NETWORK_ERROR_CODE,
  resolveAssistantLifecycleState,
  TRANSPORT_ERROR_MESSAGE,
} from "./lifecycle";

describe("resolveAssistantLifecycleState — transport-shaped failures (LUM-2402)", () => {
  test("proxy-synthesized network 502 resolves to a transient error with friendly copy", () => {
    expect(
      resolveAssistantLifecycleState({
        ok: false,
        status: 502,
        error: {
          detail: "Couldn't reach Vellum.",
          code: PROXY_NETWORK_ERROR_CODE,
        },
      }),
    ).toEqual({
      kind: "error",
      transient: true,
      message: TRANSPORT_ERROR_MESSAGE,
    });
  });

  test("raw Chromium net:: detail (legacy proxy body) is never shown to the user", () => {
    const state = resolveAssistantLifecycleState({
      ok: false,
      status: 502,
      error: { detail: "net::ERR_NETWORK_CHANGED" },
    });
    expect(state).toEqual({
      kind: "error",
      transient: true,
      message: TRANSPORT_ERROR_MESSAGE,
    });
  });

  test("genuine server errors stay non-transient with their own message", () => {
    expect(
      resolveAssistantLifecycleState({
        ok: false,
        status: 500,
        error: { detail: "Internal server error" },
      }),
    ).toEqual({ kind: "error", message: "Internal server error" });
  });

  test("404 still resolves to auto_hatch, not a transport error", () => {
    expect(
      resolveAssistantLifecycleState({ ok: false, status: 404, error: {} }),
    ).toEqual({ kind: "auto_hatch" });
  });
});

describe("isTransportShapedError", () => {
  test("matches the structured proxy code", () => {
    expect(
      isTransportShapedError({ code: PROXY_NETWORK_ERROR_CODE }),
    ).toBe(true);
  });

  test("matches a raw net::ERR_* detail", () => {
    expect(
      isTransportShapedError({ detail: "net::ERR_INTERNET_DISCONNECTED" }),
    ).toBe(true);
  });

  test("does not match ordinary server error payloads", () => {
    expect(isTransportShapedError({ detail: "Bad Gateway" })).toBe(false);
    expect(isTransportShapedError({ code: "platform_hosted_disabled" })).toBe(
      false,
    );
    expect(isTransportShapedError({})).toBe(false);
  });
});

describe("errorRetryDelayMs", () => {
  test("doubles from the base and caps at the maximum", () => {
    expect(errorRetryDelayMs(0)).toBe(ERROR_RETRY_BASE_MS);
    expect(errorRetryDelayMs(1)).toBe(ERROR_RETRY_BASE_MS * 2);
    expect(errorRetryDelayMs(2)).toBe(ERROR_RETRY_BASE_MS * 4);
    expect(errorRetryDelayMs(4)).toBe(ERROR_RETRY_MAX_MS);
    expect(errorRetryDelayMs(20)).toBe(ERROR_RETRY_MAX_MS);
  });
});
