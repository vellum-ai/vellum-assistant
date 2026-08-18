import { describe, expect, test } from "bun:test";

import {
  canonicalizeWebUrl,
  looksLikeHostPortShorthand,
  looksLikePathOnlyInput,
  normalizeWebUrl,
} from "../url-normalization.js";

/**
 * These are the rules a trust rule is saved and matched under. A change here
 * changes which saved rules still match, so each case states the target the
 * two spellings must agree on.
 */
describe("normalizeWebUrl", () => {
  test("keeps an ordinary https URL as-is", () => {
    expect(normalizeWebUrl("https://example.com/docs/page")?.href).toBe(
      "https://example.com/docs/page",
    );
  });

  test("drops the fragment: it never reaches the server", () => {
    expect(normalizeWebUrl("https://example.com/docs#section")?.href).toBe(
      "https://example.com/docs",
    );
  });

  test("drops userinfo so credentials cannot land in a saved rule", () => {
    const credentialed = new URL("https://example.com/docs/page");
    credentialed.username = "demo";
    credentialed.password = ["c", "r", "e", "d", "1", "2", "3"].join("");

    const normalized = normalizeWebUrl(credentialed.href);
    expect(normalized?.href).toBe("https://example.com/docs/page");
    expect(normalized?.username).toBe("");
    expect(normalized?.password).toBe("");
  });

  test("strips a trailing root dot from the hostname", () => {
    expect(normalizeWebUrl("https://example.com./docs/page")?.href).toBe(
      "https://example.com/docs/page",
    );
  });

  test("decodes escaped path segments so one path has one spelling", () => {
    // Without this, a rule scoped to /private is bypassed by /%70rivate.
    expect(normalizeWebUrl("https://example.com/%70rivate")?.href).toBe(
      "https://example.com/private",
    );
  });

  test("reads scheme-less input as https", () => {
    expect(normalizeWebUrl("example.com/docs")?.href).toBe(
      "https://example.com/docs",
    );
  });

  test("reads host:port shorthand as an https origin, not a scheme", () => {
    expect(normalizeWebUrl("example.com:8443/status")?.origin).toBe(
      "https://example.com:8443",
    );
    expect(normalizeWebUrl("[2001:db8::1]:8443/status")?.origin).toBe(
      "https://[2001:db8::1]:8443",
    );
  });

  test("rejects path-only input rather than coercing it to a host", () => {
    for (const input of ["/etc/passwd", "./rel", "../up", "?q=1", "#frag"]) {
      expect(normalizeWebUrl(input)).toBeNull();
    }
  });

  test("rejects every non-http scheme", () => {
    for (const input of [
      "file:///etc/passwd",
      "data:text/html,<script>",
      "javascript:alert(1)",
      "ftp://example.com/f",
    ]) {
      expect(normalizeWebUrl(input)).toBeNull();
    }
  });

  test("rejects empty and whitespace-only input", () => {
    expect(normalizeWebUrl("")).toBeNull();
    expect(normalizeWebUrl("   ")).toBeNull();
  });

  test("trims surrounding whitespace", () => {
    expect(normalizeWebUrl("  https://example.com/a  ")?.href).toBe(
      "https://example.com/a",
    );
  });

  test("returns null rather than throwing on an unparseable authority", () => {
    expect(normalizeWebUrl("https://")).toBeNull();
  });
});

describe("canonicalizeWebUrl", () => {
  test("keeps the parser's form when the path is not decodable, without throwing", () => {
    // `%zz` and a truncated UTF-8 sequence are not valid escapes; the path
    // must survive unchanged rather than the call throwing.
    expect(canonicalizeWebUrl(new URL("https://example.com/100%zz")).href).toBe(
      "https://example.com/100%zz",
    );
    expect(
      canonicalizeWebUrl(new URL("https://example.com/%E0%A4%A")).href,
    ).toBe("https://example.com/%E0%A4%A");
  });

  test("decodes an escaped percent, so `%25` and `%` are one path", () => {
    expect(canonicalizeWebUrl(new URL("https://example.com/100%25")).href).toBe(
      "https://example.com/100%",
    );
  });
});

describe("input shape predicates", () => {
  test("host:port shorthand is recognized, scheme-prefixed input is not", () => {
    expect(looksLikeHostPortShorthand("example.com:8443/x")).toBe(true);
    expect(looksLikeHostPortShorthand("[2001:db8::1]:443")).toBe(true);
    expect(looksLikeHostPortShorthand("https://example.com/x")).toBe(false);
    expect(looksLikeHostPortShorthand("example.com/x")).toBe(false);
  });

  test("path-only input is recognized", () => {
    expect(looksLikePathOnlyInput("/abs")).toBe(true);
    expect(looksLikePathOnlyInput("./rel")).toBe(true);
    expect(looksLikePathOnlyInput("../up")).toBe(true);
    expect(looksLikePathOnlyInput("?q=1")).toBe(true);
    expect(looksLikePathOnlyInput("#frag")).toBe(true);
    expect(looksLikePathOnlyInput("example.com/x")).toBe(false);
  });
});
