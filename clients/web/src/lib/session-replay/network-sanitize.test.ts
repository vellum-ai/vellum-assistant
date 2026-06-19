import { describe, expect, test } from "bun:test";

import {
  sanitizeReplayRequest,
  sanitizeReplayResponse,
  sessionReplayNetworkConfig,
} from "@/lib/session-replay/network-sanitize";

describe("sanitizeReplayRequest", () => {
  test("redacts sensitive headers by name (case-insensitive)", () => {
    const out = sanitizeReplayRequest({
      headers: {
        Authorization: "Bearer x",
        "Content-Type": "application/json",
        Cookie: "s=1",
      },
    });
    expect(out.headers).toEqual({
      Authorization: "[REDACTED]",
      "Content-Type": "application/json",
      Cookie: "[REDACTED]",
    });
  });

  test("strips tokens from the url and referrer", () => {
    const out = sanitizeReplayRequest({
      url: "https://api.vellum.ai/x?access_token=secret&page=2",
      referrer: "https://app.vellum.ai/cb?code=abc",
    });
    expect(out.url).toContain("access_token=%5BREDACTED%5D");
    expect(out.url).toContain("page=2");
    expect(out.referrer).toContain("code=%5BREDACTED%5D");
  });

  test("redacts sensitive keys in an object body, recursively", () => {
    const out = sanitizeReplayRequest({
      body: {
        password: "p",
        nested: { refresh_token: "r", keep: 1 },
        list: [{ secret: "s" }],
      },
    });
    expect(out.body).toEqual({
      password: "[REDACTED]",
      nested: { refresh_token: "[REDACTED]", keep: 1 },
      list: [{ secret: "[REDACTED]" }],
    });
  });

  test("redacts sensitive keys inside a JSON string body", () => {
    const out = sanitizeReplayRequest({
      body: JSON.stringify({ token: "t", q: "ok" }),
    });
    expect(out.body).toBe(JSON.stringify({ token: "[REDACTED]", q: "ok" }));
  });

  test("leaves non-sensitive data untouched (same body reference)", () => {
    const body = { q: "hello" };
    const out = sanitizeReplayRequest({
      url: "https://api.vellum.ai/x?page=2",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(out.url).toBe("https://api.vellum.ai/x?page=2");
    expect(out.headers).toEqual({ "Content-Type": "application/json" });
    expect(out.body).toBe(body);
  });
});

describe("sanitizeReplayResponse", () => {
  test("redacts sensitive headers, body keys, and url tokens", () => {
    const out = sanitizeReplayResponse({
      status: 200,
      headers: { "Set-Cookie": "s=1", "X-Request-Id": "abc" },
      body: { id_token: "j", ok: true },
      url: "https://api.vellum.ai/me?token=z",
    });
    expect(out.status).toBe(200);
    expect(out.headers).toEqual({
      "Set-Cookie": "[REDACTED]",
      "X-Request-Id": "abc",
    });
    expect(out.body).toEqual({ id_token: "[REDACTED]", ok: true });
    expect(out.url).toContain("token=%5BREDACTED%5D");
  });
});

describe("sessionReplayNetworkConfig", () => {
  test("wires the sanitizers and is enabled", () => {
    expect(sessionReplayNetworkConfig.isEnabled).toBe(true);
    expect(sessionReplayNetworkConfig.requestSanitizer).toBe(sanitizeReplayRequest);
    expect(sessionReplayNetworkConfig.responseSanitizer).toBe(
      sanitizeReplayResponse,
    );
  });
});
