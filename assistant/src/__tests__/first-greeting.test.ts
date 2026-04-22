import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

const tempDir = process.env.VELLUM_WORKSPACE_DIR!;

const { isWakeUpGreeting, getCannedFirstGreeting, CANNED_FIRST_GREETING } =
  await import("../daemon/first-greeting.js");
import type { OnboardingGreetingContext } from "../daemon/first-greeting.js";

describe("first-greeting", () => {
  describe("isWakeUpGreeting", () => {
    it("returns true for wake-up greeting with 0 messages and BOOTSTRAP.md present", () => {
      writeFileSync(join(tempDir, "BOOTSTRAP.md"), "bootstrap content");
      expect(isWakeUpGreeting("Wake up, my friend.", 0)).toBe(true);
    });

    it("returns true for case variations", () => {
      writeFileSync(join(tempDir, "BOOTSTRAP.md"), "bootstrap content");
      expect(isWakeUpGreeting("wake up, my friend.", 0)).toBe(true);
      expect(isWakeUpGreeting("WAKE UP, MY FRIEND.", 0)).toBe(true);
      expect(isWakeUpGreeting("Wake Up, My Friend.", 0)).toBe(true);
    });

    it("returns true for punctuation variations", () => {
      writeFileSync(join(tempDir, "BOOTSTRAP.md"), "bootstrap content");
      expect(isWakeUpGreeting("Wake up, my friend!", 0)).toBe(true);
      expect(isWakeUpGreeting("Wake up, my friend?", 0)).toBe(true);
      expect(isWakeUpGreeting("Wake up, my friend", 0)).toBe(true);
    });

    it("returns false when content doesn't match wake-up greeting", () => {
      writeFileSync(join(tempDir, "BOOTSTRAP.md"), "bootstrap content");
      expect(isWakeUpGreeting("Hello", 0)).toBe(false);
      expect(isWakeUpGreeting("Hey there", 0)).toBe(false);
      expect(isWakeUpGreeting("Wake up", 0)).toBe(false);
    });

    it("returns false when conversationMessageCount > 0", () => {
      writeFileSync(join(tempDir, "BOOTSTRAP.md"), "bootstrap content");
      expect(isWakeUpGreeting("Wake up, my friend.", 1)).toBe(false);
      expect(isWakeUpGreeting("Wake up, my friend.", 5)).toBe(false);
    });

    it("returns false when BOOTSTRAP.md doesn't exist", () => {
      rmSync(join(tempDir, "BOOTSTRAP.md"), { force: true });
      expect(existsSync(join(tempDir, "BOOTSTRAP.md"))).toBe(false);
      expect(isWakeUpGreeting("Wake up, my friend.", 0)).toBe(false);
    });
  });

  describe("getCannedFirstGreeting", () => {
    it("returns the generic greeting when no onboarding context", () => {
      const greeting = getCannedFirstGreeting();
      expect(greeting).toBe(CANNED_FIRST_GREETING);
      expect(greeting).toContain("brand new");
    });

    it("returns the generic greeting when onboarding is undefined", () => {
      expect(getCannedFirstGreeting(undefined)).toBe(CANNED_FIRST_GREETING);
    });
  });

  describe("personalized greeting", () => {
    const base: OnboardingGreetingContext = {
      tools: [],
      tasks: [],
      tone: "balanced",
    };

    it("includes user name when provided", () => {
      const greeting = getCannedFirstGreeting({ ...base, userName: "Alex" });
      expect(greeting).toContain("Alex");
    });

    it("includes assistant name when provided", () => {
      const greeting = getCannedFirstGreeting({
        ...base,
        assistantName: "Pax",
      });
      expect(greeting).toContain("I'm Pax");
    });

    it("uses casual tone", () => {
      const greeting = getCannedFirstGreeting({
        ...base,
        tone: "casual",
        userName: "Alex",
      });
      expect(greeting).toStartWith("Hey Alex!");
    });

    it("uses professional tone", () => {
      const greeting = getCannedFirstGreeting({
        ...base,
        tone: "professional",
        userName: "Alex",
      });
      expect(greeting).toStartWith("Hello, Alex.");
    });

    it("does not mention selected tools by name", () => {
      const greeting = getCannedFirstGreeting({
        ...base,
        tools: ["slack", "linear", "gmail", "notion"],
      });
      expect(greeting).not.toContain("Slack");
      expect(greeting).not.toContain("Linear");
      expect(greeting).not.toContain("Gmail");
    });

    it("suggests actions from selected tasks", () => {
      const greeting = getCannedFirstGreeting({
        ...base,
        tasks: ["code-building"],
      });
      expect(greeting).toContain("help you build something");
      expect(greeting).not.toContain("?");
    });

    it("offers two suggestions when multiple tasks selected", () => {
      const greeting = getCannedFirstGreeting({
        ...base,
        tasks: ["writing", "research"],
      });
      expect(greeting).toContain("draft or edit some writing");
      expect(greeting).toContain("dig into a research question");
      expect(greeting).not.toContain("?");
    });

    it("falls back to direct prompt when no tasks selected", () => {
      const greeting = getCannedFirstGreeting({ ...base, tasks: [] });
      expect(greeting).not.toContain("?");
    });

    it("assembles a full personalized greeting", () => {
      const greeting = getCannedFirstGreeting({
        tools: ["slack", "github"],
        tasks: ["code-building", "research"],
        tone: "casual",
        userName: "Alex",
        assistantName: "Pax",
      });
      expect(greeting).toStartWith("Hey Alex!");
      expect(greeting).toContain("I'm Pax");
      expect(greeting).not.toContain("Slack");
      expect(greeting).not.toContain("GitHub");
      expect(greeting).toContain("help you build something");
    });
  });
});
