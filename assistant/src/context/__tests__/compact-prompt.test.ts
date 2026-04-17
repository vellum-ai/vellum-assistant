import { describe, expect, test } from "bun:test";

import { loadCompactPrompt } from "../window-manager.js";

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
