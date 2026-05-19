import { describe, expect, test } from "bun:test";

import { inferCategory, SKILL_CATEGORIES } from "@/lib/skills/category.js";

describe("inferCategory", () => {
  test("classifies email-related skills as communication", () => {
    expect(
      inferCategory({
        name: "Gmail",
        description: "Read and send email through Gmail.",
      }),
    ).toBe("communication");
  });

  test("classifies phone/call skills as communication", () => {
    expect(
      inferCategory({
        name: "Phone Calls",
        description: "Place outbound voice calls.",
      }),
    ).toBe("communication");
  });

  test("classifies calendar/schedule skills as productivity", () => {
    expect(
      inferCategory({
        name: "Google Calendar",
        description: "Manage calendar events and schedule meetings.",
      }),
    ).toBe("productivity");
  });

  test("classifies coding/github skills as development", () => {
    expect(
      inferCategory({
        name: "Subagent",
        description: "Spawn a subagent to write code.",
      }),
    ).toBe("development");
  });

  test("classifies browser/macos skills as automation", () => {
    expect(
      inferCategory({
        name: "Browser",
        description: "Navigate and interact with web pages.",
      }),
    ).toBe("automation");
  });

  test("classifies image/video skills as media", () => {
    expect(
      inferCategory({
        name: "Image Studio",
        description: "Generate and edit images.",
      }),
    ).toBe("media");
  });

  test("classifies twitter/x.com skills as webSocial", () => {
    expect(
      inferCategory({
        name: "Twitter",
        description: "Post to x.com on behalf of the user.",
      }),
    ).toBe("webSocial");
  });

  test("classifies weather/briefing skills as knowledge", () => {
    expect(
      inferCategory({
        name: "Weather",
        description: "Fetch forecast data.",
      }),
    ).toBe("knowledge");
  });

  test("classifies oauth/setup skills as integration", () => {
    expect(
      inferCategory({
        name: "Guardian Verify Setup",
        description: "Connect to Guardian via OAuth.",
      }),
    ).toBe("integration");
  });

  test("falls back to knowledge when no keywords match", () => {
    expect(
      inferCategory({
        name: "Mysterious",
        description: "Something totally unrelated.",
      }),
    ).toBe("knowledge");
  });

  test("returns a valid SkillCategory for every input", () => {
    const result = inferCategory({ name: "X", description: "Y" });
    expect(SKILL_CATEGORIES).toContain(result);
  });
});
