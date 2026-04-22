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

  describe("no-onboarding branch", () => {
    it("returns no-onboarding greeting when context is undefined", () => {
      expect(getCannedFirstGreeting(undefined)).toBe(CANNED_FIRST_GREETING);
    });

    it("returns no-onboarding greeting when everything is empty", () => {
      const greeting = getCannedFirstGreeting({
        tools: [],
        tasks: [],
        tone: "",
      });
      expect(greeting).toBe(CANNED_FIRST_GREETING);
    });

    it("no-onboarding greeting uses two-paragraph structure", () => {
      expect(CANNED_FIRST_GREETING).toContain("\n\n");
      expect(CANNED_FIRST_GREETING).toContain("I can ask");
    });
  });

  describe("personalized greeting", () => {
    const base: OnboardingGreetingContext = {
      tools: [],
      tasks: [],
      tone: "balanced",
    };

    it("full dev stack: GitHub + Linear, Building + PM", () => {
      const greeting = getCannedFirstGreeting({
        ...base,
        tools: ["github", "linear"],
        tasks: ["code-building", "project-management"],
        userName: "Alex",
        assistantName: "Pip",
      });
      expect(greeting).toContain("Hey Alex, I'm Pip.");
      expect(greeting).toContain("GitHub and Linear say");
      expect(greeting).toContain(
        "shipping code or figuring out what to ship next",
      );
      expect(greeting).toContain("\n\n");
    });

    it("PM + comms: Linear + Notion, PM + Writing", () => {
      const greeting = getCannedFirstGreeting({
        ...base,
        tools: ["linear", "notion"],
        tasks: ["project-management", "writing"],
        userName: "Alex",
        assistantName: "Pip",
      });
      expect(greeting).toContain("Notion and Linear say");
      expect(greeting).toContain("writing a spec or pushing something forward");
    });

    it("writer: Notion + Google Drive, Writing only", () => {
      const greeting = getCannedFirstGreeting({
        ...base,
        tools: ["notion", "google-drive"],
        tasks: ["writing"],
        userName: "Alex",
        assistantName: "Luna",
      });
      expect(greeting).toContain("Notion and Google Drive say");
      expect(greeting).toContain("drafting something or cleaning up docs");
    });

    it("single task no tools: Building only", () => {
      const greeting = getCannedFirstGreeting({
        ...base,
        tasks: ["code-building"],
        userName: "Alex",
        assistantName: "Pip",
      });
      expect(greeting).toContain("Probably shipping something or debugging");
      expect(greeting).not.toContain("Your");
    });

    it("single tool single task: GitHub + Building", () => {
      const greeting = getCannedFirstGreeting({
        ...base,
        tools: ["github"],
        tasks: ["code-building"],
        userName: "Alex",
        assistantName: "Pip",
      });
      expect(greeting).toContain("Your GitHub says");
    });

    it("many hats: 4 selections", () => {
      const greeting = getCannedFirstGreeting({
        ...base,
        tasks: ["code-building", "writing", "research", "project-management"],
        userName: "Alex",
        assistantName: "Pip",
      });
      expect(greeting).toContain("wear a lot of hats");
      expect(greeting).toContain("Where should we start?");
    });

    it("many hats: 6 selections", () => {
      const greeting = getCannedFirstGreeting({
        ...base,
        tasks: [
          "code-building",
          "writing",
          "research",
          "project-management",
          "scheduling",
          "personal",
        ],
        userName: "Alex",
        assistantName: "Pip",
      });
      expect(greeting).toContain("wear a lot of hats");
    });

    it("no tasks with tools: no-signal branch", () => {
      const greeting = getCannedFirstGreeting({
        ...base,
        tools: ["gmail", "linear"],
        tasks: [],
        userName: "Alex",
        assistantName: "Pip",
      });
      expect(greeting).toContain("What's on your plate?");
      expect(greeting).toContain("I can ask you a few questions");
    });

    it("missing name uses Hey comma opener", () => {
      const greeting = getCannedFirstGreeting({
        ...base,
        tasks: ["code-building"],
        assistantName: "Pip",
      });
      expect(greeting).toStartWith("Hey, I'm Pip.");
    });

    it("3-selection falls back to highest-priority single template", () => {
      const greeting = getCannedFirstGreeting({
        ...base,
        tasks: ["writing", "research", "scheduling"],
        userName: "Alex",
        assistantName: "Pip",
      });
      expect(greeting).toContain("drafting something or cleaning up docs");
    });

    it("unlisted 2-combo falls back to highest-priority single", () => {
      const greeting = getCannedFirstGreeting({
        ...base,
        tasks: ["research", "personal"],
        userName: "Alex",
        assistantName: "Pip",
      });
      expect(greeting).toContain(
        "digging into a topic or making sense of something",
      );
    });

    it("uses capital I throughout", () => {
      const greeting = getCannedFirstGreeting({
        ...base,
        tasks: ["code-building"],
        userName: "Alex",
        assistantName: "Pip",
      });
      expect(greeting).toContain("I'm Pip");
      expect(greeting).toContain("I'll get sharper");
      expect(greeting).toContain("am I on the right track");
    });

    it("two-paragraph structure with blank line", () => {
      const greeting = getCannedFirstGreeting({
        ...base,
        tasks: ["code-building"],
        userName: "Alex",
        assistantName: "Pip",
      });
      const paragraphs = greeting.split("\n\n");
      expect(paragraphs.length).toBe(2);
    });

    it("picks relevant tools for guess, not arbitrary selection order", () => {
      const greeting = getCannedFirstGreeting({
        ...base,
        tools: [
          "notion",
          "linear",
          "gmail",
          "google-calendar",
          "github",
          "apple-notes",
        ],
        tasks: ["code-building", "project-management"],
        userName: "Alex",
        assistantName: "Pip",
      });
      expect(greeting).toContain("GitHub and Linear say");
      expect(greeting).not.toContain("Apple Notes");
      expect(greeting).not.toContain("Notion");
    });

    it("falls back to no-tool prefix when no relevant tools match", () => {
      const greeting = getCannedFirstGreeting({
        ...base,
        tools: ["notion", "apple-notes"],
        tasks: ["code-building"],
        userName: "Alex",
        assistantName: "Pip",
      });
      expect(greeting).toContain("Probably shipping something or debugging");
      expect(greeting).not.toContain("Your");
    });

    it("life admin guess uses verb phrase", () => {
      const greeting = getCannedFirstGreeting({
        ...base,
        tools: ["gmail", "google-calendar"],
        tasks: ["personal"],
        userName: "Alex",
        assistantName: "Pip",
      });
      expect(greeting).toContain("Gmail and Google Calendar say");
      expect(greeting).toContain("juggling travel, bills, or household stuff");
    });
  });
});
