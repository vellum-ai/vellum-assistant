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
      expect(lower).toContain("identity");
      expect(lower).toContain("infer");
    });

    test("gathers user context", () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain("work role");
      expect(lower).toContain("goals");
      expect(lower).toContain("tools");
    });

    test("contains wrapping-up criteria with deletion instructions", () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain("wrapping up");
      expect(lower).toContain("delete");
      expect(lower).toContain("bootstrap.md");
    });

    test("contains refusal policy", () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain("declined");
      expect(lower).toContain("constraints");
    });

    test("defines field states as inferred or declined", () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain("inferred");
      expect(lower).toContain("declined");
    });

    test("instructs saving to IDENTITY.md, SOUL.md, and user persona file via file_edit", () => {
      expect(bootstrap).toContain("IDENTITY.md");
      expect(bootstrap).toContain("SOUL.md");
      expect(bootstrap).toContain("{{USER_PERSONA_FILE}}");
      expect(bootstrap).toContain("file_edit");
    });

    test("includes budget constraint", () => {
      expect(bootstrap).toContain("$2");
      expect(bootstrap).toContain("$5");
    });

    test("includes new colleague framing", () => {
      expect(bootstrap).toContain("new colleague");
    });

    test("contains numbered goals", () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain("establish mutual identity");
      expect(lower).toContain("prove value fast");
      expect(lower).toContain("infer, don't interrogate");
      expect(lower).toContain("surface what you learned");
      expect(lower).toContain("offer the next level");
      expect(lower).toContain("write everything immediately");
      expect(lower).toContain("clean up");
    });

    test("contains constraints section", () => {
      expect(bootstrap).toContain("## Constraints");
      expect(bootstrap).toContain("$2");
      expect(bootstrap).toContain("2 questions");
      expect(bootstrap.toLowerCase()).toContain("don't block on setup");
      expect(bootstrap).toContain("One-shot");
    });

    test("contains 'what you own' section", () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain("sequencing");
      expect(lower).toContain("pacing");
    });

    test("contains technical contract", () => {
      expect(bootstrap).toContain("Technical Contract");
      expect(bootstrap).toContain("prescribed");
    });

    test("contains capability unlock pattern", () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain("email");
      expect(lower).toContain("voice");
      expect(lower).toContain("slack");
    });

    test("contains tone guidance", () => {
      expect(bootstrap).toContain("Not servile");
      expect(bootstrap.toLowerCase()).toContain("match");
      expect(bootstrap.toLowerCase()).toContain("energy");
    });

    test("contains pre-chat onboarding context section", () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain("onboarding");
      expect(lower).toContain("json");
      expect(lower).toContain("context");
    });

    test("does not contain personality quiz references", () => {
      // BOOTSTRAP.md says "No personality quiz" as part of goal 3,
      // but should NOT contain instructions TO USE or SHOW a personality quiz
      expect(bootstrap).not.toMatch(/show.*personality quiz/i);
      expect(bootstrap).not.toMatch(/present.*personality quiz/i);
      // "dropdown" only appears in "No dropdown forms" — that's a prohibition, not an instruction
      expect(bootstrap).not.toMatch(/show.*dropdown/i);
    });

    test("does not contain rigid step sequence", () => {
      expect(bootstrap).not.toMatch(/Step 1:/);
      expect(bootstrap).not.toMatch(/Step 2:/);
      expect(bootstrap).not.toMatch(/Step 3:/);
    });
  });

  describe("BOOTSTRAP-REFERENCE.md", () => {
    test("contains email-not-connected task card variant", () => {
      expect(bootstrapRef).toContain("Email Not Connected");
      expect(bootstrapRef).toContain("Connect my email");
      expect(bootstrapRef).toContain("relay_prompt");
    });

    test("contains email-already-connected task card variant", () => {
      expect(bootstrapRef).toContain("Email Already Connected");
      expect(bootstrapRef).toContain("Check my email");
    });

    test("does not contain personality form", () => {
      expect(bootstrapRef).not.toContain('surface_type: "form"');
      expect(bootstrapRef).not.toContain("communication_style");
      expect(bootstrapRef).not.toContain("task_style");
      expect(bootstrapRef).not.toContain("humor");
      expect(bootstrapRef).not.toContain("depth");
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
