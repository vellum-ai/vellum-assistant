import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const templatesDir = join(import.meta.dirname, "..", "prompts", "templates");
const bootstrap = readFileSync(join(templatesDir, "BOOTSTRAP.md"), "utf-8");
const identity = readFileSync(join(templatesDir, "IDENTITY.md"), "utf-8");
const user = readFileSync(join(templatesDir, "USER.md"), "utf-8");

describe("onboarding template contracts", () => {
  describe("BOOTSTRAP.md", () => {
    test("preserves comment line format instruction", () => {
      expect(bootstrap).toMatch(/^_ Lines starting with _/);
    });

    test("contains identity discovery prompts", () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain("your name");
      expect(lower).toContain("personality");
      expect(lower).toContain("avatar");
    });

    test("infers personality organically instead of asking directly", () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain("personality");
      expect(lower).toContain("emerge");
      expect(lower).toContain("vibe");
    });

    test("contains emoji auto-selection with change-later instruction", () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain("emoji");
      expect(lower).toContain("change it later");
    });

    test("asks about user after assistant identity", () => {
      const nameIdx = bootstrap.indexOf("Your name");
      const guardianIdx = bootstrap.indexOf("Your guardian");
      expect(nameIdx).toBeGreaterThan(-1);
      expect(guardianIdx).toBeGreaterThan(-1);
      expect(nameIdx).toBeLessThan(guardianIdx);
    });

    test("gathers user context: work role, hobbies, daily tools", () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain("work role");
      expect(lower).toContain("hobbies");
      expect(lower).toContain("tools");
    });

    test("shows exactly 2 suggestions via ui_show card with relay_prompt actions", () => {
      expect(bootstrap).toContain("ui_show");
      expect(bootstrap).toContain("exactly 2");
      expect(bootstrap).toContain("relay_prompt");
    });

    test("contains completion gate with required conditions", () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain("completion gate");
      expect(lower).toContain("do not delete this file");
      expect(lower).toContain("you have a name");
      expect(lower).toContain("vibe");
      expect(lower).toContain("two suggestions");
    });

    test("contains refusal policy", () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain("hard-required");
      expect(lower).toContain("best-effort");
      expect(lower).toContain("declined");
      expect(lower).toContain("don't push");
    });

    test("defines resolved as provided, inferred, or declined", () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain("resolved");
      expect(lower).toContain("inferred");
      expect(lower).toContain("declined");
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

    test("contains parsed field format guidance", () => {
      expect(identity).toContain("parsed by the app");
    });
  });

  describe("USER.md", () => {
    test("contains profile fields", () => {
      expect(user).toContain("Preferred name/reference:");
      expect(user).toContain("Goals:");
      expect(user).toContain("Locale:");
      expect(user).toContain("Work role:");
      expect(user).toContain("Hobbies/fun:");
      expect(user).toContain("Daily tools:");
    });
  });
});
