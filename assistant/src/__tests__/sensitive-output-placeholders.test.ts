import { describe, expect, test } from "bun:test";

import {
  applyStreamingSubstitution,
  applySubstitutions,
  extractAndSanitize,
} from "../tools/sensitive-output-placeholders.js";

describe("extractAndSanitize", () => {
  test("parses a valid invite_code directive and replaces raw value with placeholder", () => {
    const rawToken = "abc123def456";
    const content = `<vellum-sensitive-output kind="invite_code" value="${rawToken}" />\nhttps://t.me/bot?start=iv_${rawToken}`;

    const { sanitizedContent, bindings } = extractAndSanitize(content);

    expect(bindings).toHaveLength(1);
    expect(bindings[0].kind).toBe("invite_code");
    expect(bindings[0].value).toBe(rawToken);
    expect(bindings[0].placeholder).toMatch(
      /^VELLUM_ASSISTANT_INVITE_CODE_[A-Z0-9]{8}$/,
    );

    // Directive tag should be stripped
    expect(sanitizedContent).not.toContain("<vellum-sensitive-output");
    // Raw token should be replaced with placeholder
    expect(sanitizedContent).not.toContain(rawToken);
    expect(sanitizedContent).toContain(bindings[0].placeholder);
    // The link structure should be preserved
    expect(sanitizedContent).toContain(
      `https://t.me/bot?start=iv_${bindings[0].placeholder}`,
    );
  });

  test("ignores malformed directives safely", () => {
    const content = "Some text <vellum-sensitive-output broken />";
    const { sanitizedContent, bindings } = extractAndSanitize(content);

    expect(bindings).toHaveLength(0);
    expect(sanitizedContent).toBe(content);
  });

  test("ignores unknown kind values", () => {
    const content =
      '<vellum-sensitive-output kind="unknown_kind" value="secret123" />';
    const { sanitizedContent, bindings } = extractAndSanitize(content);

    expect(bindings).toHaveLength(0);
    expect(sanitizedContent).toBe(content);
  });

  test("drops empty values", () => {
    const content = '<vellum-sensitive-output kind="invite_code" value="" />';
    const { sanitizedContent, bindings } = extractAndSanitize(content);

    expect(bindings).toHaveLength(0);
    // Directive should remain since no valid binding was extracted
    expect(sanitizedContent).toBe(content);
  });

  test("deduplicates identical values into a single binding", () => {
    const rawToken = "token123";
    const content = [
      `<vellum-sensitive-output kind="invite_code" value="${rawToken}" />`,
      `<vellum-sensitive-output kind="invite_code" value="${rawToken}" />`,
      `Link1: https://t.me/bot?start=iv_${rawToken}`,
      `Link2: https://t.me/bot?start=iv_${rawToken}`,
    ].join("\n");

    const { sanitizedContent, bindings } = extractAndSanitize(content);

    expect(bindings).toHaveLength(1);
    expect(bindings[0].value).toBe(rawToken);

    // Both occurrences of the raw token should be replaced with the same placeholder
    const placeholderCount =
      sanitizedContent.split(bindings[0].placeholder).length - 1;
    expect(placeholderCount).toBe(2);
    expect(sanitizedContent).not.toContain(rawToken);
  });

  test("supports multiple distinct bindings", () => {
    const token1 = "firstToken123";
    const token2 = "secondToken456";
    const content = [
      `<vellum-sensitive-output kind="invite_code" value="${token1}" />`,
      `<vellum-sensitive-output kind="invite_code" value="${token2}" />`,
      `Link1: https://t.me/bot?start=iv_${token1}`,
      `Link2: https://t.me/bot?start=iv_${token2}`,
    ].join("\n");

    const { sanitizedContent, bindings } = extractAndSanitize(content);

    expect(bindings).toHaveLength(2);
    expect(bindings[0].value).toBe(token1);
    expect(bindings[1].value).toBe(token2);

    // Both raw tokens should be replaced
    expect(sanitizedContent).not.toContain(token1);
    expect(sanitizedContent).not.toContain(token2);
    expect(sanitizedContent).toContain(bindings[0].placeholder);
    expect(sanitizedContent).toContain(bindings[1].placeholder);
  });

  test("returns content unchanged when no directives are present", () => {
    const content = "Just a normal tool output with no directives.";
    const { sanitizedContent, bindings } = extractAndSanitize(content);

    expect(bindings).toHaveLength(0);
    expect(sanitizedContent).toBe(content);
  });

  test("placeholder format matches required pattern", () => {
    const content =
      '<vellum-sensitive-output kind="invite_code" value="tok123" />';
    const { bindings } = extractAndSanitize(content);

    expect(bindings).toHaveLength(1);
    // Must be exactly: VELLUM_ASSISTANT_INVITE_CODE_ followed by 8 uppercase alphanumeric chars
    expect(bindings[0].placeholder).toMatch(
      /^VELLUM_ASSISTANT_INVITE_CODE_[A-Z0-9]{8}$/,
    );
  });
});

describe("applySubstitutions", () => {
  test("replaces placeholders with real values", () => {
    const map = new Map([
      ["VELLUM_ASSISTANT_INVITE_CODE_ABCD1234", "realtoken123"],
    ]);

    const text =
      "Your link: https://t.me/bot?start=iv_VELLUM_ASSISTANT_INVITE_CODE_ABCD1234";
    const result = applySubstitutions(text, map);

    expect(result).toBe("Your link: https://t.me/bot?start=iv_realtoken123");
  });

  test("replaces multiple placeholders", () => {
    const map = new Map([
      ["VELLUM_ASSISTANT_INVITE_CODE_AAAA1111", "token1"],
      ["VELLUM_ASSISTANT_INVITE_CODE_BBBB2222", "token2"],
    ]);

    const text =
      "Link1: VELLUM_ASSISTANT_INVITE_CODE_AAAA1111, Link2: VELLUM_ASSISTANT_INVITE_CODE_BBBB2222";
    const result = applySubstitutions(text, map);

    expect(result).toBe("Link1: token1, Link2: token2");
  });

  test("returns text unchanged when map is empty", () => {
    const map = new Map<string, string>();
    const text = "No placeholders here.";
    expect(applySubstitutions(text, map)).toBe(text);
  });
});

describe("applyStreamingSubstitution", () => {
  test("resolves complete placeholders in a single chunk", () => {
    const map = new Map([
      ["VELLUM_ASSISTANT_INVITE_CODE_ABCD1234", "realtoken"],
    ]);

    const { emit, pending } = applyStreamingSubstitution(
      "Your code: VELLUM_ASSISTANT_INVITE_CODE_ABCD1234 is ready.",
      map,
    );

    expect(emit).toContain("realtoken");
    expect(emit).not.toContain("VELLUM_ASSISTANT_INVITE_CODE_ABCD1234");
    // No pending text since the placeholder was complete
    expect(pending).toBe("");
  });

  test("buffers text that could be an incomplete placeholder prefix", () => {
    const map = new Map([
      ["VELLUM_ASSISTANT_INVITE_CODE_ABCD1234", "realtoken"],
    ]);

    // Chunk ends mid-placeholder
    const { emit, pending } = applyStreamingSubstitution(
      "Your code: VELLUM_ASSISTANT_",
      map,
    );

    // The ambiguous tail should be buffered
    expect(pending.length).toBeGreaterThan(0);
    // emit should not contain the partial placeholder
    expect(emit).not.toContain("VELLUM_ASSISTANT_");
  });

  test("handles split-chunk placeholder by concatenating pending with next chunk", () => {
    const map = new Map([
      ["VELLUM_ASSISTANT_INVITE_CODE_ABCD1234", "realtoken"],
    ]);

    // First chunk: partial placeholder
    const result1 = applyStreamingSubstitution("Link: VELLUM_ASSISTANT_", map);

    // Second chunk completes the placeholder
    const combined = result1.pending + "INVITE_CODE_ABCD1234 done.";
    const result2 = applyStreamingSubstitution(combined, map);

    expect(result2.emit).toContain("realtoken");
    expect(result2.emit).toContain("done.");
    expect(result2.pending).toBe("");
  });

  test("returns text unchanged when map is empty", () => {
    const map = new Map<string, string>();
    const { emit, pending } = applyStreamingSubstitution("Hello world", map);

    expect(emit).toBe("Hello world");
    expect(pending).toBe("");
  });
});
