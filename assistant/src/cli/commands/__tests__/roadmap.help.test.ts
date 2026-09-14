import { describe, expect, test } from "bun:test";

import { roadmapHelp } from "../roadmap.help.js";

const DISCORD_URL = "https://vellum.ai/community";

describe("roadmap help is feature-proposal-only", () => {
  test("top-level help describes feature proposals and routes bugs to Discord", () => {
    const description = roadmapHelp.description;
    const helpText = roadmapHelp.helpText ?? "";
    const combined = `${description}\n${helpText}`.toLowerCase();

    expect(combined).toMatch(/feature proposals?/);
    expect(description.split(DISCORD_URL)).toHaveLength(2);
    expect(helpText).toContain(DISCORD_URL);
    expect(combined).toContain("instruct the user");
    expect(combined).not.toMatch(/support@|github\.com|share feedback/);
  });
});
