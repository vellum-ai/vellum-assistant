import { describe, expect, test } from "bun:test";

import { routes } from "@/lib/routes.js";

import { sanitizeReturnTo } from "@/lib/account/return-to.js";

const FALLBACK = routes.assistant;

// ---------------------------------------------------------------------------
// Nullish and empty inputs → fallback
// ---------------------------------------------------------------------------

describe("sanitizeReturnTo", () => {
  test("returns fallback for null", () => {
    expect(sanitizeReturnTo(null, FALLBACK)).toBe(FALLBACK);
  });

  test("returns fallback for undefined", () => {
    expect(sanitizeReturnTo(undefined, FALLBACK)).toBe(FALLBACK);
  });

  test("returns fallback for empty string", () => {
    expect(sanitizeReturnTo("", FALLBACK)).toBe(FALLBACK);
  });

  // ---------------------------------------------------------------------------
  // Valid relative paths → returned as-is
  // ---------------------------------------------------------------------------

  test("returns valid relative path as-is", () => {
    const path = routes.admin.feedbackOne("123");
    expect(sanitizeReturnTo(path, FALLBACK)).toBe(path);
  });

  test("returns /assistant as-is", () => {
    expect(sanitizeReturnTo(routes.assistant, FALLBACK)).toBe(routes.assistant);
  });

  test("allows relative path with query containing absolute redirect_uri", () => {
    const chromeExtensionReturnTo =
      "/accounts/chrome-extension/start" +
      "?redirect_uri=https://abcdefghijklmnopqrstuvwxyzabcdef.chromiumapp.org/cloud-auth" +
      "&client_id=vellum-chrome-extension" +
      "&assistant_id=00000000-0000-4000-8000-000000000001";

    expect(sanitizeReturnTo(chromeExtensionReturnTo, FALLBACK)).toBe(
      chromeExtensionReturnTo,
    );
  });

  // ---------------------------------------------------------------------------
  // Trusted cross-origin URLs → allowed
  // ---------------------------------------------------------------------------

  test("allows https://www.vellum.ai absolute URL", () => {
    const url = `https://www.vellum.ai${routes.assistant}`;
    expect(sanitizeReturnTo(url, FALLBACK)).toBe(url);
  });

  test("allows https://vellum.ai absolute URL", () => {
    expect(sanitizeReturnTo("https://vellum.ai/pricing", FALLBACK)).toBe(
      "https://vellum.ai/pricing",
    );
  });

  test("allows any vellum.ai subdomain", () => {
    expect(
      sanitizeReturnTo("https://assistant.vellum.ai/dashboard", FALLBACK),
    ).toBe("https://assistant.vellum.ai/dashboard");
  });

  test("allows dev-assistant.vellum.ai", () => {
    expect(
      sanitizeReturnTo("https://dev-assistant.vellum.ai/download", FALLBACK),
    ).toBe("https://dev-assistant.vellum.ai/download");
  });

  test("returns fallback for http vellum.ai (non-https)", () => {
    expect(
      sanitizeReturnTo("http://www.vellum.ai/dashboard", FALLBACK),
    ).toBe(FALLBACK);
  });

  // ---------------------------------------------------------------------------
  // Untrusted absolute URLs → fallback (open redirect prevention)
  // ---------------------------------------------------------------------------

  test("returns fallback for untrusted https absolute URL", () => {
    expect(sanitizeReturnTo("https://evil.com", FALLBACK)).toBe(FALLBACK);
  });

  test("returns fallback for URL spoofing trusted domain as subdomain", () => {
    expect(sanitizeReturnTo("https://vellum.ai.evil.com/path", FALLBACK)).toBe(
      FALLBACK,
    );
  });

  test("returns fallback for URL with trusted domain in path", () => {
    expect(
      sanitizeReturnTo("https://evil.com/https://www.vellum.ai", FALLBACK),
    ).toBe(FALLBACK);
  });

  test("returns fallback for protocol-relative URL", () => {
    expect(sanitizeReturnTo("//evil.com", FALLBACK)).toBe(FALLBACK);
  });

  test("returns fallback for backslash open redirect", () => {
    expect(sanitizeReturnTo("/\\evil.com", FALLBACK)).toBe(FALLBACK);
  });

  test("returns fallback for backslash anywhere in path", () => {
    expect(sanitizeReturnTo("/foo\\bar", FALLBACK)).toBe(FALLBACK);
  });

  // ---------------------------------------------------------------------------
  // Non-path strings → fallback
  // ---------------------------------------------------------------------------

  test("returns fallback for javascript: URI", () => {
    expect(sanitizeReturnTo("javascript:alert(1)", FALLBACK)).toBe(FALLBACK);
  });

  test("returns fallback for bare string without leading slash", () => {
    expect(sanitizeReturnTo("not-a-path", FALLBACK)).toBe(FALLBACK);
  });
});
