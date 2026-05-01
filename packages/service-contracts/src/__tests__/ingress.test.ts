import { describe, expect, test } from "bun:test";

import {
  normalizeHttpPublicBaseUrl,
  normalizePublicBaseUrl,
} from "../ingress.js";

describe("normalizePublicBaseUrl", () => {
  test("trims whitespace and trailing slashes", () => {
    expect(normalizePublicBaseUrl(" https://example.test/path/// ")).toBe(
      "https://example.test/path",
    );
  });

  test("rejects non-string and empty values", () => {
    expect(normalizePublicBaseUrl(undefined)).toBeUndefined();
    expect(normalizePublicBaseUrl("   ")).toBeUndefined();
  });
});

describe("normalizeHttpPublicBaseUrl", () => {
  test("normalizes valid HTTP and HTTPS URLs", () => {
    expect(normalizeHttpPublicBaseUrl(" HTTPS://EXAMPLE.TEST/twilio ")).toBe(
      "https://example.test/twilio",
    );
    expect(normalizeHttpPublicBaseUrl("https://example.test/twilio///")).toBe(
      "https://example.test/twilio",
    );
    expect(normalizeHttpPublicBaseUrl("https://example.test")).toBe(
      "https://example.test/",
    );
  });

  test("rejects non-HTTP URLs and malformed values", () => {
    expect(normalizeHttpPublicBaseUrl("ftp://example.test")).toBeUndefined();
    expect(normalizeHttpPublicBaseUrl("notaurl")).toBeUndefined();
    expect(normalizeHttpPublicBaseUrl("")).toBeUndefined();
  });

  test("rejects query strings and fragments instead of mutating them", () => {
    expect(
      normalizeHttpPublicBaseUrl("https://example.test/twilio?token=abc/"),
    ).toBeUndefined();
    expect(
      normalizeHttpPublicBaseUrl("https://example.test/twilio#section/"),
    ).toBeUndefined();
    expect(
      normalizeHttpPublicBaseUrl("https://example.test/twilio?"),
    ).toBeUndefined();
    expect(
      normalizeHttpPublicBaseUrl("https://example.test/twilio#"),
    ).toBeUndefined();
  });
});
