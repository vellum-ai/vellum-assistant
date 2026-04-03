import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const templatesDir = join(import.meta.dirname, "..", "prompts", "templates");
const bootstrap = readFileSync(join(templatesDir, "BOOTSTRAP.md"), "utf-8");
const bootstrapRef = readFileSync(
  join(templatesDir, "BOOTSTRAP-REFERENCE.md"),
  "utf-8",
);
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
    });

    test("leads with personality-first emotional arc", () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain("personality");
      expect(lower).toContain("vibe");
      // Personality arc should come before usefulness arc
      const personalityIdx = lower.indexOf("oh, this has personality");
      const usefulIdx = lower.indexOf("oh, this is useful");
      expect(personalityIdx).toBeGreaterThan(-1);
      expect(usefulIdx).toBeGreaterThan(-1);
      expect(personalityIdx).toBeLessThan(usefulIdx);
    });

    test("contains name selection with change-later instruction", () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain("what they want to call you");
      expect(lower).toContain("change it later");
    });

    test("name exchange happens before personality quiz", () => {
      const nameIdx = bootstrap.indexOf("Step 1: Name Exchange");
      const quizIdx = bootstrap.indexOf("Step 2: Personality Quiz");
      expect(nameIdx).toBeGreaterThan(-1);
      expect(quizIdx).toBeGreaterThan(-1);
      expect(nameIdx).toBeLessThan(quizIdx);
    });

    test("gathers user context: work role, hobbies, daily tools", () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain("work role");
      expect(lower).toContain("hobbies");
      expect(lower).toContain("tools");
    });

    test("references ui_show payloads from BOOTSTRAP-REFERENCE.md", () => {
      expect(bootstrap).toContain("ui_show");
      expect(bootstrap).toContain("BOOTSTRAP-REFERENCE.md");
    });

    test("contains wrapping-up criteria with deletion instructions", () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain("wrapping up");
      expect(lower).toContain("delete");
      expect(lower).toContain("bootstrap.md");
    });

    test("contains refusal policy", () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain("hard-required");
      expect(lower).toContain("best-effort");
      expect(lower).toContain("declined");
      expect(lower).toContain("not interrogation");
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

    test("includes budget constraint", () => {
      expect(bootstrap).toContain("$5");
    });

    test("includes new colleague framing", () => {
      expect(bootstrap).toContain("new colleague");
    });

    test("instructs checking Connected Services for email task variant", () => {
      expect(bootstrap).toContain("Connected Services");
      expect(bootstrap).toContain("Connect my email");
      expect(bootstrap).toContain("Check my email");
    });

    test("includes daily briefing and channel suggestions in getting set up", () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain("daily briefing");
      expect(lower).toContain("slack");
      expect(lower).toContain("telegram");
    });
  });

  describe("BOOTSTRAP-REFERENCE.md", () => {
    test("contains personality form with 4 dropdowns", () => {
      expect(bootstrapRef).toContain("surface_type: \"form\"");
      expect(bootstrapRef).toContain("communication_style");
      expect(bootstrapRef).toContain("task_style");
      expect(bootstrapRef).toContain("humor");
      expect(bootstrapRef).toContain("depth");
    });

    test("contains email-not-connected task card variant", () => {
      expect(bootstrapRef).toContain("Email Not Connected");
      expect(bootstrapRef).toContain("Connect my email");
      expect(bootstrapRef).toContain("relay_prompt");
    });

    test("contains email-already-connected task card variant", () => {
      expect(bootstrapRef).toContain("Email Already Connected");
      expect(bootstrapRef).toContain("Check my email");
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
