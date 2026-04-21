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

  test("contains the '## Goals' section header (canary for truncation)", () => {
    const prompt = loadCompactPrompt();
    expect(prompt).toContain("## Goals");
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
    expect(result).toContain("## Goals");
    expect(result).toContain("## Constraints");
    expect(result).toContain("## Decisions");
    expect(result).toContain("## Open Conversations");
    expect(result).toContain("## Key Artifacts");
    expect(result).toContain("## Recent Progress");
  });

  test("uses loadCompactPrompt as the default loader", () => {
    const result = loadCompactPromptOrFallback();
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain("## Goals");
  });
});
