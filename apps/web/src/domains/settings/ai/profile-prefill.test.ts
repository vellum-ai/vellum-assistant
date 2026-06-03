import { describe, expect, test } from "bun:test";

import {
  dedupeKey,
  deriveProfileDefaults,
  deriveProviderDefaults,
  slugify,
} from "@/domains/settings/ai/profile-prefill";

describe("slugify", () => {
  test("collapses dots into hyphens", () => {
    expect(slugify("Claude Opus 4.7")).toBe("claude-opus-4-7");
  });

  test("collapses multiple spaces into a single hyphen", () => {
    expect(slugify("GPT   5   Mini")).toBe("gpt-5-mini");
  });

  test("collapses symbols and consecutive separators", () => {
    expect(slugify("Hello, World!!")).toBe("hello-world");
    expect(slugify("a---b___c")).toBe("a-b-c");
  });

  test("strips leading and trailing separators", () => {
    expect(slugify("  Spaces  ")).toBe("spaces");
    expect(slugify("--anthropic--")).toBe("anthropic");
  });

  test("handles empty string", () => {
    expect(slugify("")).toBe("");
  });

  test("handles a string with no alphanumerics", () => {
    expect(slugify("!!!")).toBe("");
  });
});

describe("dedupeKey", () => {
  test("returns the base when there is no collision", () => {
    expect(dedupeKey("anthropic", [])).toBe("anthropic");
    expect(dedupeKey("anthropic", ["openai"])).toBe("anthropic");
  });

  test("appends -2 on the first collision", () => {
    expect(dedupeKey("anthropic", ["anthropic"])).toBe("anthropic-2");
  });

  test("walks the suffix until unique", () => {
    expect(dedupeKey("anthropic", ["anthropic", "anthropic-2"])).toBe(
      "anthropic-3",
    );
  });

  test("compares case-insensitively", () => {
    expect(dedupeKey("Anthropic", ["anthropic"])).toBe("Anthropic-2");
  });
});

describe("deriveProviderDefaults", () => {
  test("uses the display name and a deduped slug key", () => {
    expect(deriveProviderDefaults("anthropic", [])).toEqual({
      name: "Anthropic",
      key: "anthropic",
    });
  });

  test("dedupes the key against existing connection names", () => {
    expect(deriveProviderDefaults("anthropic", ["anthropic"])).toEqual({
      name: "Anthropic",
      key: "anthropic-2",
    });
  });

  test("falls back to the provider type when no display name exists", () => {
    expect(deriveProviderDefaults("custom-provider", [])).toEqual({
      name: "custom-provider",
      key: "custom-provider",
    });
  });
});

describe("deriveProfileDefaults", () => {
  test("uses the model display name and a deduped slug key", () => {
    expect(deriveProfileDefaults("Claude Opus 4.7", [])).toEqual({
      name: "Claude Opus 4.7",
      key: "claude-opus-4-7",
    });
  });

  test("dedupes the key against existing profile names", () => {
    expect(
      deriveProfileDefaults("Claude Opus 4.7", ["claude-opus-4-7"]),
    ).toEqual({
      name: "Claude Opus 4.7",
      key: "claude-opus-4-7-2",
    });
  });
});
