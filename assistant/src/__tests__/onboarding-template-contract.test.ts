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

    test("anchors identity in the pre-chat personality and demands staying in character", () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain("pre-chat");
      expect(lower).toContain("in character");
    });

    test("opens in character with a move drawn from workspace files", () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain("you start the conversation");
      expect(lower).toContain("workspace files");
    });

    test("is engaging, inquisitive, and brief", () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain("follow-up question");
      expect(lower).toContain("short");
    });

    test("does the task then keeps learning about the user", () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain("just do it");
      expect(lower).toContain("keep learning about them");
    });

    test("contains cleanup instructions with deletion", () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain("delete");
      expect(lower).toContain("bootstrap.md");
    });

    test("offers assistant migration from an existing ChatGPT/Claude", () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain("chatgpt");
      expect(lower).toContain("claude");
      expect(bootstrap).toContain("assistant-migration");
    });

    test("does not instruct workspace identity-file writes", () => {
      expect(bootstrap).not.toContain("file_edit");
      expect(bootstrap).not.toContain("file_write");
      expect(bootstrap).not.toMatch(/write .*to SOUL\.md/i);
      expect(bootstrap).not.toMatch(/\{\{userSlug\}\}\.md/);
    });

    test("does not split users into conversation-first and task-first paths", () => {
      expect(bootstrap).not.toMatch(/Path A/);
      expect(bootstrap).not.toMatch(/Path B/);
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

    test("does not invite assistant-owned identity restructuring", () => {
      expect(identity).not.toContain("This file is yours");
      expect(identity).not.toContain("parsed by the app");
    });
  });

  // Legacy `templates/USER.md` was removed by workspace migration
  // `031-drop-user-md`. Guardian persona content is now seeded via
  // `GUARDIAN_PERSONA_TEMPLATE` in `prompts/persona-resolver.ts` and
  // lives on disk at `users/<slug>.md`.
});
