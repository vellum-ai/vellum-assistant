import { describe, it, expect } from "bun:test";

import { sanitizeUrl } from "@/lib/sentry/url-sanitize";

describe("sanitizeUrl", () => {
  it("redacts known sensitive query params", () => {
    expect(sanitizeUrl("https://app/callback?code=xyz&state=abc")).toBe(
      "https://app/callback?code=%5BREDACTED%5D&state=abc",
    );
    expect(sanitizeUrl("https://app/invite?token=secret123")).toBe(
      "https://app/invite?token=%5BREDACTED%5D",
    );
    expect(sanitizeUrl("https://app/?email=alice@example.com")).toBe(
      "https://app/?email=%5BREDACTED%5D",
    );
  });

  it("matches sensitive keys case-insensitively", () => {
    expect(sanitizeUrl("https://app/?Token=abc&API_KEY=zz")).toBe(
      "https://app/?Token=%5BREDACTED%5D&API_KEY=%5BREDACTED%5D",
    );
  });

  it("leaves benign query params untouched", () => {
    expect(sanitizeUrl("https://app/list?page=2&sort=desc")).toBe(
      "https://app/list?page=2&sort=desc",
    );
  });

  it("does not over-scrub routing params containing `key` substrings", () => {
    // Bare `key` is intentionally excluded from SENSITIVE_PARAM_KEYS so
    // routing params whose names contain "key" (e.g. legacy/temporary
    // routing surfaces) survive untouched.
    expect(sanitizeUrl("https://app/chat?someRoutingKey=abc123")).toBe(
      "https://app/chat?someRoutingKey=abc123",
    );
  });

  it("scrubs OAuth deep-link codes on custom schemes (iOS Capacitor)", () => {
    expect(
      sanitizeUrl(
        "vellum-assistant://oauth-complete?oauth_code=xyz&oauth_provider=google",
      ),
    ).toBe(
      "vellum-assistant://oauth-complete?oauth_code=%5BREDACTED%5D&oauth_provider=google",
    );
  });

  it("redacts parametric hash fragments (OAuth implicit flow)", () => {
    expect(
      sanitizeUrl("https://app/#access_token=abc&token_type=Bearer"),
    ).toBe("https://app/#[REDACTED]");
  });

  it("preserves anchor-style hashes without `=`", () => {
    expect(sanitizeUrl("https://app/docs#section-two")).toBe(
      "https://app/docs#section-two",
    );
  });

  it("preserves relative URLs without re-introducing the placeholder origin", () => {
    expect(sanitizeUrl("/callback?code=xyz")).toBe(
      "/callback?code=%5BREDACTED%5D",
    );
    expect(sanitizeUrl("/list?page=2")).toBe("/list?page=2");
  });

  it("preserves the host for protocol-relative URLs", () => {
    expect(sanitizeUrl("//api.example.com/callback?token=xyz")).toBe(
      "//api.example.com/callback?token=%5BREDACTED%5D",
    );
  });

  it("returns the input unchanged for non-URL strings", () => {
    expect(sanitizeUrl("")).toBe("");
    expect(sanitizeUrl("not a url at all")).toBe("not a url at all");
  });
});
