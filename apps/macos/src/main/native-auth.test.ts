import { describe, expect, mock, test } from "bun:test";

import { buildStartUrl, generateState } from "./native-auth";

describe("generateState", () => {
  test("returns a base64url-encoded string of sufficient length", () => {
    const state = generateState();
    expect(state.length).toBeGreaterThanOrEqual(16);
    expect(/^[A-Za-z0-9_-]+$/.test(state)).toBe(true);
  });

  test("generates unique values", () => {
    const a = generateState();
    const b = generateState();
    expect(a).not.toBe(b);
  });
});

describe("buildStartUrl", () => {
  test("builds URL with required state param", () => {
    const url = buildStartUrl("https://platform.vellum.ai", "abc123", {});
    expect(url).toBe(
      "https://platform.vellum.ai/accounts/native/start?state=abc123",
    );
  });

  test("includes optional params when provided", () => {
    const url = buildStartUrl("https://platform.vellum.ai", "abc123", {
      providerHint: "GoogleOAuth",
      loginHint: "user@example.com",
      clientVersion: "1.0.0",
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get("state")).toBe("abc123");
    expect(parsed.searchParams.get("provider_hint")).toBe("GoogleOAuth");
    expect(parsed.searchParams.get("login_hint")).toBe("user@example.com");
    expect(parsed.searchParams.get("client_version")).toBe("1.0.0");
  });

  test("omits optional params when not provided", () => {
    const url = buildStartUrl("https://platform.vellum.ai", "abc123", {});
    const parsed = new URL(url);
    expect(parsed.searchParams.has("provider_hint")).toBe(false);
    expect(parsed.searchParams.has("login_hint")).toBe(false);
    expect(parsed.searchParams.has("client_version")).toBe(false);
  });
});
