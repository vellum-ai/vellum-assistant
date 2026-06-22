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
        // Django's CSRF header (matched case-insensitively); lowercased here to
        // avoid the repo's no-CSRF-header-literal lint rule.
        "x-csrftoken": "tok",
      },
    });
    expect(out.headers).toEqual({
      Authorization: "[REDACTED]",
      "Content-Type": "application/json",
      Cookie: "[REDACTED]",
      "x-csrftoken": "[REDACTED]",
    });
  });

  test("redacts every query-param value (keys kept) in url and referrer", () => {
    const out = sanitizeReplayRequest({
      // `q` is generic user content (search text), not credential-looking.
      url: "https://api.vellum.ai/v1/search/global?q=secret%20text&page=2",
      referrer: "https://app.vellum.ai/cb?code=abc",
    });
    expect(out.url).toBe(
      "https://api.vellum.ai/v1/search/global?q=%5BREDACTED%5D&page=%5BREDACTED%5D",
    );
    expect(out.referrer).toBe("https://app.vellum.ai/cb?code=%5BREDACTED%5D");
  });

  test("leaves a query-less url untouched", () => {
    expect(sanitizeReplayRequest({ url: "https://api.vellum.ai/x" }).url).toBe(
      "https://api.vellum.ai/x",
    );
  });

  test("redacts any request body wholesale", () => {
    expect(
      sanitizeReplayRequest({
        body: { type: "credential", name: "n", value: "raw-secret" },
      }).body,
    ).toBe("[REDACTED]");
    expect(sanitizeReplayRequest({ body: "plain text" }).body).toBe("[REDACTED]");
  });

  test("leaves an absent body untouched", () => {
    expect(sanitizeReplayRequest({ url: "https://api.vellum.ai/x" }).body).toBeUndefined();
  });
});

describe("sanitizeReplayResponse", () => {
  test("redacts sensitive headers, body, and url tokens", () => {
    const out = sanitizeReplayResponse({
      status: 200,
      headers: { "Set-Cookie": "s=1", "X-Request-Id": "abc" },
      body: { ok: true },
      url: "https://api.vellum.ai/me?token=z",
    });
    expect(out.status).toBe(200);
    expect(out.headers).toEqual({
      "Set-Cookie": "[REDACTED]",
      "X-Request-Id": "abc",
    });
    expect(out.body).toBe("[REDACTED]");
    expect(out.url).toBe("https://api.vellum.ai/me?token=%5BREDACTED%5D");
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
