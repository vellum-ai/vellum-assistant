import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const templatesDir = join(import.meta.dirname, "..", "prompts", "templates");
const bootstrap = readFileSync(join(templatesDir, "BOOTSTRAP.md"), "utf-8");
const identity = readFileSync(join(templatesDir, "IDENTITY.md"), "utf-8");
const user = readFileSync(join(templatesDir, "USER.md"), "utf-8");

describe("onboarding template contracts", () => {
  describe("BOOTSTRAP.md", () => {
    test("contains identity question prompts", () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain("who am i");
    });

    test("infers personality organically instead of asking directly", () => {
      const lower = bootstrap.toLowerCase();
      // Personality step must instruct organic discovery via conversation
      expect(lower).toContain("personality");
      expect(lower).toContain("emerge");
      expect(lower).toContain("vibe");
    });

    test("contains emoji auto-selection with change-later instruction", () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain("emoji");
      expect(lower).toContain("change it later");
    });

    test("contains naming intent markers so the first reply includes naming cues", () => {
      const lower = bootstrap.toLowerCase();
      // The template must prompt the assistant to ask about names.
      expect(lower).toContain("name");
      // The first step should be about the assistant's name
      expect(lower).toContain("your name");
      // The conversation sequence must include identity/naming
      expect(lower).toContain("who am i");
    });

    test("asks user name AFTER assistant identity is established", () => {
      // Step 1 is the assistant's name, step 4 is asking the user's name
      const assistantNameIdx = bootstrap.indexOf("Your name:");
      const userNameIdx = bootstrap.indexOf("who am I talking to?");
      expect(assistantNameIdx).toBeGreaterThan(-1);
      expect(userNameIdx).toBeGreaterThan(-1);
      expect(assistantNameIdx).toBeLessThan(userNameIdx);
    });

    test("gathers user context: work role, hobbies, daily tools", () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain("work");
      expect(lower).toContain("hobbies");
      expect(lower).toContain("tools");
    });

    test("shows exactly 2 suggestions via ui_show card with relay_prompt actions", () => {
      expect(bootstrap).toContain("ui_show");
      expect(bootstrap).toContain("exactly 2");
      // Must use card surface with relay_prompt action buttons
      expect(bootstrap).toContain('surface_type: "card"');
      expect(bootstrap).toContain("relay_prompt");
    });

    test("contains completion gate with all required conditions", () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain("completion gate");
      expect(lower).toContain("do not delete this file");
      // Assistant name is hard-required
      expect(lower).toContain("you have a name");
      expect(lower).toContain("hard-required");
      expect(lower).toContain("vibe");
      // User detail fields must be resolved (provided, inferred, or declined)
      expect(lower).toContain("resolved");
      expect(lower).toContain("work role");
      expect(lower).toContain("2 suggestions from step 6");
    });

    test("contains refusal policy", () => {
      const lower = bootstrap.toLowerCase();
      // Assistant name is hard-required, user details are best-effort
      expect(lower).toContain("hard-required");
      expect(lower).toContain("best-effort");
      // Refusal is a valid resolution
      expect(lower).toContain("declined");
      expect(lower).toContain("do not push");
    });

    test("defines resolved as provided, inferred, or declined", () => {
      const lower = bootstrap.toLowerCase();
      // The template must define what "resolved" means
      expect(lower).toContain("resolved");
      expect(lower).toContain("inferred");
      expect(lower).toContain("declined");
    });

    // em-dash and technical jargon instructions are now hardcoded in the system
    // prompt builder (buildSystemPrompt) rather than in the BOOTSTRAP.md template.

    test("preserves comment line format instruction", () => {
      // The template must start with the comment format explanation
      expect(bootstrap).toMatch(/^_ Lines starting with _/);
    });

    test("instructs saving to IDENTITY.md, USER.md, and SOUL.md via file_edit", () => {
      expect(bootstrap).toContain("IDENTITY.md");
      expect(bootstrap).toContain("USER.md");
      expect(bootstrap).toContain("SOUL.md");
      expect(bootstrap).toContain("file_edit");
    });
  });

  describe("IDENTITY.md", () => {
    test("contains canonical fields: Name, Nature, Personality, Emoji", () => {
      expect(identity).toContain("**Name:**");
      expect(identity).toContain("**Nature:**");
      expect(identity).toContain("**Personality:**");
      expect(identity).toContain("**Emoji:**");
    });

    test("contains the emoji overwrite instruction", () => {
      const lower = identity.toLowerCase();
      expect(lower).toContain("change their emoji");
    });

    test("contains the style tendency field", () => {
      expect(identity).toContain("**Style tendency:**");
    });
  });

  describe("USER.md", () => {
    test("contains onboarding snapshot with all required fields", () => {
      expect(user).toContain("Preferred name/reference:");
      expect(user).toContain("Goals:");
      expect(user).toContain("Locale:");
      expect(user).toContain("Work role:");
      expect(user).toContain("Hobbies/fun:");
      expect(user).toContain("Daily tools:");
    });

    test("documents resolved-field status conventions", () => {
      const lower = user.toLowerCase();
      expect(lower).toContain("declined_by_user");
      expect(lower).toContain("resolved");
    });
  });
});
