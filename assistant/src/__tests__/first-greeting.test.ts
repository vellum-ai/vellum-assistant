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
      const paragraphs = CANNED_FIRST_GREETING.split("\n\n");
      expect(paragraphs.length).toBe(2);
    });

    it("no-onboarding greeting does not contain old self-deprecation text", () => {
      expect(CANNED_FIRST_GREETING).not.toContain("no name, no memories");
      expect(CANNED_FIRST_GREETING).not.toContain("Brand new");
      expect(CANNED_FIRST_GREETING).not.toContain("I can ask");
      expect(CANNED_FIRST_GREETING).not.toContain("get sharper");
    });
  });

  describe("personalized greeting", () => {
    const base: OnboardingGreetingContext = {
      tools: [],
      tasks: [],
      tone: "grounded",
    };

    it("grounded + name + assistantName", () => {
      const greeting = getCannedFirstGreeting({
        ...base,
        tone: "grounded",
        userName: "Alice",
        assistantName: "Pax",
      });
      expect(greeting).toBe(
        "Hey Alice, I'm Pax.\n\nWe can get into whatever you've got, or just talk first — that tends to go better. Up to you.",
      );
    });

    it("warm + name + assistantName", () => {
      const greeting = getCannedFirstGreeting({
        ...base,
        tone: "warm",
        userName: "Alice",
        assistantName: "Remy",
      });
      expect(greeting).toBe(
        "Hey Alice, I'm Remy. Good to meet you.\n\nWe can start on something specific, or just talk for a bit first — honestly that tends to work out better. Either way, I'm here.",
      );
    });

    it("energetic + no names", () => {
      const greeting = getCannedFirstGreeting({
        ...base,
        tone: "energetic",
        assistantName: "Pax",
      });
      expect(greeting).toBe(
        "Hey, I'm Pax. Let's see what you've got.\n\nWe can jump straight into whatever you've got, or take a few minutes to just talk first. What sounds right?",
      );
    });

    it("poetic + name + assistantName", () => {
      const greeting = getCannedFirstGreeting({
        ...base,
        tone: "poetic",
        userName: "Alice",
        assistantName: "Pax",
      });
      expect(greeting).toBe(
        "Hey Alice, I'm Pax.\n\nWe can start with whatever's in front of you, or just talk for a bit first. Either way.",
      );
    });

    it("name only (no assistantName)", () => {
      const greeting = getCannedFirstGreeting({
        ...base,
        tone: "grounded",
        userName: "Alice",
      });
      expect(greeting).toBe(
        "Hey Alice,\n\nWe can get into whatever you've got, or just talk first — that tends to go better. Up to you.",
      );
    });

    it("assistantName only (no userName)", () => {
      const greeting = getCannedFirstGreeting({
        ...base,
        tone: "grounded",
        assistantName: "Pax",
      });
      expect(greeting).toBe(
        "Hey, I'm Pax.\n\nWe can get into whatever you've got, or just talk first — that tends to go better. Up to you.",
      );
    });

    it("no name, no assistantName, no tone returns CANNED_FIRST_GREETING", () => {
      const greeting = getCannedFirstGreeting({
        tools: [],
        tasks: [],
        tone: "",
      });
      expect(greeting).toBe(CANNED_FIRST_GREETING);
    });

    it("no names but valid tone uses tone-aware greeting", () => {
      const greeting = getCannedFirstGreeting({
        tools: [],
        tasks: [],
        tone: "warm",
      });
      expect(greeting).toBe(
        "Hey,\n\nWe can start on something specific, or just talk for a bit first — honestly that tends to work out better. Either way, I'm here.",
      );
    });

    it("each valid tone with no names produces distinct invite", () => {
      const greetings = ["grounded", "warm", "energetic", "poetic"].map(
        (tone) => getCannedFirstGreeting({ tools: [], tasks: [], tone }),
      );
      const unique = new Set(greetings);
      expect(unique.size).toBe(4);
    });

    it("unknown tone falls back to grounded defaults", () => {
      const greeting = getCannedFirstGreeting({
        ...base,
        tone: "mysterious-future-tone",
        userName: "Alice",
        assistantName: "Pax",
      });
      expect(greeting).toBe(
        "Hey Alice, I'm Pax.\n\nWe can get into whatever you've got, or just talk first — that tends to go better. Up to you.",
      );
    });

    it("two-paragraph structure preserved", () => {
      const greeting = getCannedFirstGreeting({
        ...base,
        tone: "grounded",
        userName: "Alice",
        assistantName: "Pax",
      });
      const paragraphs = greeting.split("\n\n");
      expect(paragraphs.length).toBe(2);
    });
  });

  describe("tone-specific greetings", () => {
    const base: OnboardingGreetingContext = {
      tools: [],
      tasks: [],
      tone: "grounded",
      userName: "Bob",
      assistantName: "Pax",
    };

    it("grounded intro close is empty, invite is grounded", () => {
      const greeting = getCannedFirstGreeting({ ...base, tone: "grounded" });
      const [intro, invite] = greeting.split("\n\n");
      expect(intro).toBe("Hey Bob, I'm Pax.");
      expect(invite).toBe(
        "We can get into whatever you've got, or just talk first — that tends to go better. Up to you.",
      );
    });

    it("warm intro close is 'Good to meet you.', invite is warm", () => {
      const greeting = getCannedFirstGreeting({ ...base, tone: "warm" });
      const [intro, invite] = greeting.split("\n\n");
      expect(intro).toBe("Hey Bob, I'm Pax. Good to meet you.");
      expect(invite).toBe(
        "We can start on something specific, or just talk for a bit first — honestly that tends to work out better. Either way, I'm here.",
      );
    });

    it("energetic intro close is 'Let's see what you've got.', invite is energetic", () => {
      const greeting = getCannedFirstGreeting({ ...base, tone: "energetic" });
      const [intro, invite] = greeting.split("\n\n");
      expect(intro).toBe("Hey Bob, I'm Pax. Let's see what you've got.");
      expect(invite).toBe(
        "We can jump straight into whatever you've got, or take a few minutes to just talk first. What sounds right?",
      );
    });

    it("poetic intro close is empty, invite is poetic", () => {
      const greeting = getCannedFirstGreeting({ ...base, tone: "poetic" });
      const [intro, invite] = greeting.split("\n\n");
      expect(intro).toBe("Hey Bob, I'm Pax.");
      expect(invite).toBe(
        "We can start with whatever's in front of you, or just talk for a bit first. Either way.",
      );
    });

    it("each tone produces a distinct full greeting", () => {
      const tones = ["grounded", "warm", "energetic", "poetic"];
      const greetings = tones.map((tone) => {
        return getCannedFirstGreeting({ ...base, tone });
      });
      const unique = new Set(greetings);
      expect(unique.size).toBe(tones.length);
    });

    it("each tone produces distinct invite text", () => {
      const tones = ["grounded", "warm", "energetic", "poetic"];
      const invites = tones.map((tone) => {
        const greeting = getCannedFirstGreeting({ ...base, tone });
        return greeting.split("\n\n")[1];
      });
      const unique = new Set(invites);
      expect(unique.size).toBe(tones.length);
    });
  });

  describe("tasks and tools fields are ignored", () => {
    it("tasks do not appear in output", () => {
      const greeting = getCannedFirstGreeting({
        tools: ["github", "linear"],
        tasks: ["code-building", "project-management"],
        tone: "grounded",
        userName: "Alice",
        assistantName: "Pax",
      });
      expect(greeting).not.toContain("GitHub");
      expect(greeting).not.toContain("Linear");
      expect(greeting).not.toContain("code");
      expect(greeting).not.toContain("shipping");
      expect(greeting).not.toContain("You mentioned using");
      expect(greeting).not.toContain("wear a lot of hats");
      expect(greeting).not.toContain("Am I on the right track");
    });

    it("tools do not appear in output", () => {
      const greeting = getCannedFirstGreeting({
        tools: ["gmail", "google-calendar", "slack", "notion"],
        tasks: ["scheduling", "personal", "writing", "research"],
        tone: "warm",
        userName: "Bob",
        assistantName: "Remy",
      });
      expect(greeting).not.toContain("Gmail");
      expect(greeting).not.toContain("Google Calendar");
      expect(greeting).not.toContain("Slack");
      expect(greeting).not.toContain("Notion");
      expect(greeting).not.toContain("scheduling");
      expect(greeting).not.toContain("personal");
    });
  });
});
