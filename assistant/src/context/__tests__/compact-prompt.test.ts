import { describe, expect, test } from "bun:test";

import {
  loadCompactPrompt,
  loadCompactPromptOrFallback,
} from "../window-manager.js";

describe("compact.md prompt asset", () => {
  test("loads a non-empty prompt string", () => {
    const prompt = loadCompactPrompt();
    expect(prompt.length).toBeGreaterThan(0);
  });

  test("contains explicit length target (canary against accidental 'concise' reversion)", () => {
    const prompt = loadCompactPrompt();
    expect(prompt).toContain("1500");
    expect(prompt).toContain("4000");
    expect(prompt.toLowerCase()).toContain("tokens");
  });

  test("includes the never-include guidance for injection tags", () => {
    const prompt = loadCompactPrompt();
    expect(prompt).toContain("<memory");
    expect(prompt).toContain("<turn_context>");
    expect(prompt.toLowerCase()).toContain("never include");
  });

  test("lists the flexible section headers", () => {
    const prompt = loadCompactPrompt();
    expect(prompt).toContain("## What We're Working On");
    expect(prompt).toContain("## Decisions & Commitments");
    expect(prompt).toContain("## Facts Worth Remembering");
    expect(prompt).toContain("## Open Threads");
  });
});

describe("loadCompactPromptOrFallback", () => {
  test("returns loader output when the loader succeeds", () => {
    const loaded = "custom loaded prompt";
    const result = loadCompactPromptOrFallback(() => loaded);
    expect(result).toBe(loaded);
  });

  test("returns inline fallback when the loader throws", () => {
    const result = loadCompactPromptOrFallback(() => {
      throw new Error("compact.md missing");
    });
    expect(result.length).toBeGreaterThan(0);
    // Fallback must carry the same core guidance as the on-disk prompt so
    // summary quality doesn't silently collapse when the bundled asset is
    // missing (partial deploys, filesystem corruption).
    expect(result).toContain("1500");
    expect(result).toContain("4000");
    expect(result).toContain("<memory");
    expect(result.toLowerCase()).toContain("never include");
  });

  test("uses loadCompactPrompt as the default loader", () => {
    const result = loadCompactPromptOrFallback();
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain("1500");
  });
});
