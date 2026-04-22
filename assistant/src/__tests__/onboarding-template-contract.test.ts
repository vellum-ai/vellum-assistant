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

describe("onboarding template contracts", () => {
  describe("BOOTSTRAP.md", () => {
    test("preserves comment line format instruction", () => {
      expect(bootstrap).toMatch(/^_ Lines starting with _/);
    });

    test("contains identity section", () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain("identity");
      expect(lower).toContain("colleague");
    });

    test("gathers user context", () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain("work role");
      expect(lower).toContain("goals");
      expect(lower).toContain("tools");
    });

    test("contains cleanup instructions with deletion", () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain("wrap up");
      expect(lower).toContain("delete");
      expect(lower).toContain("bootstrap.md");
    });

    test("handles declined fields", () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain("declined");
    });

    test("instructs saving to IDENTITY.md, SOUL.md, and user persona file via file_edit", () => {
      expect(bootstrap).toContain("IDENTITY.md");
      expect(bootstrap).toContain("SOUL.md");
      expect(bootstrap).toContain("{{USER_PERSONA_FILE}}");
      expect(bootstrap).toContain("file_edit");
    });

    test("contains core principle", () => {
      expect(bootstrap).toContain("earns its keep");
    });

    test("contains opening move with onboarding context", () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain("onboarding");
      expect(lower).toContain("json");
      expect(lower).toContain("context");
    });

    test("contains tone matching guidance", () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain("match");
      expect(lower).toContain("energy");
    });

    test("is one-shot", () => {
      expect(bootstrap).toContain("One-shot");
    });

    test("does not contain personality quiz references", () => {
      expect(bootstrap).not.toMatch(/show.*personality quiz/i);
      expect(bootstrap).not.toMatch(/present.*personality quiz/i);
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

  // Legacy `templates/USER.md` was removed by workspace migration
  // `031-drop-user-md`. Guardian persona content is now seeded via
  // `GUARDIAN_PERSONA_TEMPLATE` in `prompts/persona-resolver.ts` and
  // lives on disk at `users/<slug>.md`.
});
