import { describe, expect, test } from "bun:test";

import {
  deriveProfileDefaults,
  deriveProviderDefaults,
  uniqueProfileName,
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
    expect(deriveProviderDefaults("anthropic", ["anthropic-personal"])).toEqual(
      {
        name: "Anthropic",
        key: "anthropic-personal-2",
      },
    );
  });

  test("falls back to the provider type when no display name exists", () => {
    expect(deriveProviderDefaults("custom-provider", [])).toEqual({
      name: "custom-provider",
      key: "custom-provider-personal",
    });
  });
});

describe("deriveProfileDefaults", () => {
  test("uses the model display name and the key it slugifies to", () => {
    expect(deriveProfileDefaults("Claude Opus 4.7", [])).toEqual({
      name: "Claude Opus 4.7",
      key: "claude-opus-4-7",
    });
  });

  test("suffixes the name, and the key follows it", () => {
    expect(
      deriveProfileDefaults("Claude Opus 4.7", ["claude-opus-4-7"]),
    ).toEqual({
      name: "Claude Opus 4.7 (2)",
      key: "claude-opus-4-7-2",
    });
  });
});

describe("uniqueProfileName", () => {
  test("leaves a free name alone", () => {
    expect(uniqueProfileName("Claude Opus 4.8", [])).toBe("Claude Opus 4.8");
    expect(uniqueProfileName("Claude Opus 4.8", ["gpt-5-6"])).toBe(
      "Claude Opus 4.8",
    );
  });

  test("appends (2) on the first collision", () => {
    expect(uniqueProfileName("Claude Opus 4.8", ["claude-opus-4-8"])).toBe(
      "Claude Opus 4.8 (2)",
    );
  });

  test("walks the suffix until both the name and its key are free", () => {
    expect(
      uniqueProfileName("Claude Opus 4.8", [
        "claude-opus-4-8",
        "claude-opus-4-8-2",
        "claude-opus-4-8-3",
      ]),
    ).toBe("Claude Opus 4.8 (4)");
  });

  test("fills a gap rather than counting past the highest suffix", () => {
    // "(2)" and "(4)" are taken, so the next one is "(3)": the lowest free
    // number, so deleting a copy cannot change what the next one is called.
    expect(
      uniqueProfileName("Claude Opus 4.8", [
        "claude-opus-4-8",
        "claude-opus-4-8-2",
        "claude-opus-4-8-4",
      ]),
    ).toBe("Claude Opus 4.8 (3)");
  });

  test("rejects a candidate whose key is taken under a different name", () => {
    // "fast-cheap" was stored from "Fast & Cheap"; "Fast Cheap" slugifies to
    // the same key, so it collides even though the names differ.
    expect(uniqueProfileName("Fast Cheap", ["fast-cheap"])).toBe(
      "Fast Cheap (2)",
    );
  });

  test("matches a taken name case-insensitively", () => {
    expect(uniqueProfileName("Anthropic", ["ANTHROPIC"])).toBe(
      "Anthropic (2)",
    );
  });

  test("lets a profile being edited keep its own name", () => {
    expect(
      uniqueProfileName("Claude Opus 4.8", ["claude-opus-4-8"], "claude-opus-4-8"),
    ).toBe("Claude Opus 4.8");
  });
});
