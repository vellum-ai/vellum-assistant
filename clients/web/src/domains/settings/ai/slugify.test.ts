import { describe, expect, test } from "bun:test";

import { toKebabCase } from "@/domains/settings/ai/slugify";

describe("toKebabCase", () => {
  test("lowercases and joins words with hyphens", () => {
    expect(toKebabCase("My Anthropic Key")).toBe("my-anthropic-key");
  });

  test("handles camelCase input", () => {
    expect(toKebabCase("myAnthropicKey")).toBe("myanthropickey");
  });

  test("strips non-alphanumeric characters", () => {
    expect(toKebabCase("Hello, World!")).toBe("hello-world");
  });

  test("handles leading/trailing separators", () => {
    expect(toKebabCase("  spaces  ")).toBe("spaces");
  });

  test("handles empty string", () => {
    expect(toKebabCase("")).toBe("");
  });

  test("handles consecutive separators", () => {
    expect(toKebabCase("a---b___c")).toBe("a-b-c");
  });

  test("preserves numbers", () => {
    expect(toKebabCase("GPT 4o Mini")).toBe("gpt-4o-mini");
  });
});
