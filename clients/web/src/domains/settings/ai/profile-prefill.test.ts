import { describe, expect, test } from "bun:test";

import {
  deriveProfileDefaults,
  deriveProviderDefaults,
} from "@/domains/settings/ai/profile-prefill";

// `slugify` and `dedupeKey` are module-private — they have no non-test
// consumers, so they're exercised here through the public `derive*` helpers
// that compose them (the `key` field is the slugified + deduped result).

describe("deriveProfileDefaults — slug derivation (slugify)", () => {
  test("collapses dots and spaces into single hyphens", () => {
    expect(deriveProfileDefaults("Claude Opus 4.7", []).key).toBe(
      "claude-opus-4-7",
    );
    expect(deriveProfileDefaults("GPT   5   Mini", []).key).toBe("gpt-5-mini");
  });

  test("collapses symbols and consecutive separators", () => {
    expect(deriveProfileDefaults("Hello, World!!", []).key).toBe("hello-world");
    expect(deriveProfileDefaults("a---b___c", []).key).toBe("a-b-c");
  });

  test("strips leading and trailing separators", () => {
    expect(deriveProfileDefaults("  Spaces  ", []).key).toBe("spaces");
    expect(deriveProfileDefaults("--anthropic--", []).key).toBe("anthropic");
  });

  test("yields an empty key when there are no alphanumerics", () => {
    expect(deriveProfileDefaults("!!!", []).key).toBe("");
  });
});

describe("deriveProfileDefaults — collision handling (dedupeKey)", () => {
  test("returns the base slug when there is no collision", () => {
    expect(deriveProfileDefaults("Anthropic", []).key).toBe("anthropic");
    expect(deriveProfileDefaults("Anthropic", ["openai"]).key).toBe(
      "anthropic",
    );
  });

  test("appends -2 on the first collision", () => {
    expect(deriveProfileDefaults("Anthropic", ["anthropic"]).key).toBe(
      "anthropic-2",
    );
  });

  test("walks the suffix until unique", () => {
    expect(
      deriveProfileDefaults("Anthropic", ["anthropic", "anthropic-2"]).key,
    ).toBe("anthropic-3");
  });

  test("compares collisions case-insensitively", () => {
    // Slug is already lowercase, so seed an upper-case existing name to prove
    // the comparison ignores case.
    expect(deriveProfileDefaults("Anthropic", ["ANTHROPIC"]).key).toBe(
      "anthropic-2",
    );
  });
});

describe("deriveProviderDefaults", () => {
  test("uses the display name and a deduped slug key", () => {
    expect(deriveProviderDefaults("anthropic", [])).toEqual({
      name: "Anthropic",
      key: "anthropic-personal",
    });
  });

  test("dedupes the key against existing connection names", () => {
    expect(
      deriveProviderDefaults("anthropic", ["anthropic-personal"]),
    ).toEqual({
      name: "Anthropic",
      key: "anthropic-personal-2",
    });
  });

  test("falls back to the provider type when no display name exists", () => {
    expect(deriveProviderDefaults("custom-provider", [])).toEqual({
      name: "custom-provider",
      key: "custom-provider-personal",
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
