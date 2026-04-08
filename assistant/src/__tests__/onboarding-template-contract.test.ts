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

    test("frames the assistant as a new colleague, not a product demo", () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain("new colleague");
      expect(lower).toContain("not a product demo");
    });

    // ── Core pattern ──────────────────────────────────────────────────────

    test("states the core pattern: infer → do → surface → offer", () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain("core pattern");
      expect(lower).toContain("infer");
      expect(lower).toContain("surface what you learned");
      // The four beats should appear in order inside the core pattern line.
      const inferIdx = lower.indexOf("infer");
      const surfaceIdx = lower.indexOf("surface what you learned");
      const offerIdx = lower.indexOf("offer the next level");
      expect(inferIdx).toBeLessThan(surfaceIdx);
      expect(surfaceIdx).toBeLessThan(offerIdx);
    });

    // ── The seven goals ───────────────────────────────────────────────────

    test("declares a Goals section", () => {
      expect(bootstrap).toMatch(/^## Goals/m);
    });

    test("goal: mutual identity — gently, or not at all", () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain("mutual identity");
      expect(lower).toContain("gently, or not at all");
    });

    test("goal: prove value fast (wow moment)", () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain("prove value fast");
      expect(lower).toContain("wow moment");
    });

    test("goal: infer, don't interrogate — no quiz, no forms", () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain("infer, don't interrogate");
      expect(lower).toContain("no personality quiz");
      expect(lower).toContain("no dropdown forms");
    });

    test("goal: surface what you learned (correctable receipt)", () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain("surface what you learned");
      expect(lower).toContain("correct");
    });

    test("goal: offer the next level", () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain("offer the next level");
    });

    test("goal: write everything immediately, never batch saves", () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain("write everything immediately");
      expect(lower).toContain("never batch saves");
      expect(lower).toContain("same turn");
    });

    test("goal: clean up — delete both bootstrap files", () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain("clean up");
      expect(lower).toContain("one shot");
    });

    // ── The four constraints ──────────────────────────────────────────────

    test("declares a Constraints section", () => {
      expect(bootstrap).toMatch(/^## Constraints/m);
    });

    test("constraint: $2 soft / $5 hard budget cap", () => {
      expect(bootstrap).toContain("$2");
      expect(bootstrap).toContain("$5");
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain("soft");
      expect(lower).toContain("hard");
    });

    test("constraint: no more than 2 questions in a row without doing something", () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain("2 questions in a row");
      expect(lower).toContain("without doing something");
    });

    test("constraint: don't block on setup", () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain("don't block on setup");
    });

    test("constraint: one-shot, bootstrap files deleted at end regardless", () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain("one-shot");
      expect(lower).toContain("regardless of how far you got");
    });

    // ── What the model owns ───────────────────────────────────────────────

    test("declares what the model owns (no prescribed sequencing)", () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain("what you own");
      expect(lower).toContain("sequencing and pacing");
      expect(lower).toContain("there is no step 1");
    });

    test("tells the model to match the user's energy", () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain("match the user's energy");
    });

    // ── Identity handling ─────────────────────────────────────────────────

    test("does not force names — provides the Pax default fallback", () => {
      expect(bootstrap).toContain("Pax");
      expect(bootstrap).toContain("I'll go by Pax");
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain("do not re-ask names");
    });

    test("instructs task-first openings to skip introductions", () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain("skip introductions");
    });

    // ── Pre-chat onboarding context (forward-compatible injection) ─────────

    test("describes the pre-chat onboarding context shape for Phase 2", () => {
      expect(bootstrap).toContain("Pre-Chat Onboarding Context");
      expect(bootstrap).toContain('"onboarding"');
      expect(bootstrap).toContain("userName");
      expect(bootstrap).toContain("assistantName");
      expect(bootstrap).toContain("tools");
      expect(bootstrap).toContain("tasks");
      expect(bootstrap).toContain("tone");
    });

    test("tells model to use pre-chat context if present, fall back to inference if not", () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain("if this block is present");
      expect(lower).toContain("if this block is not present");
      expect(lower).toContain("fall back to inferring");
    });

    // ── Technical contract ────────────────────────────────────────────────

    test("declares a technical contract section", () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain("technical contract");
    });

    test("instructs saving to IDENTITY.md, USER.md, and SOUL.md via file_edit", () => {
      expect(bootstrap).toContain("IDENTITY.md");
      expect(bootstrap).toContain("USER.md");
      expect(bootstrap).toContain("SOUL.md");
      expect(bootstrap).toContain("file_edit");
    });

    test("gathers user context fields: work role, hobbies, daily tools", () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain("work role");
      expect(lower).toContain("hobbies");
      expect(lower).toContain("daily tools");
    });

    test("defines resolved as provided, inferred, or declined (with marker format)", () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain("resolved");
      expect(lower).toContain("inferred");
      expect(lower).toContain("declined");
      expect(lower).toContain("declined_by_user");
    });

    test("vibe is hard-required, everything else best-effort", () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain("hard-required");
      expect(lower).toContain("best-effort");
    });

    test("points at BOOTSTRAP-REFERENCE.md as an inference reference, not a form", () => {
      expect(bootstrap).toContain("BOOTSTRAP-REFERENCE.md");
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain("not a form");
      expect(lower).toContain("not a quiz");
    });

    test("references Connected Services section advisorially, not as a scripted gate", () => {
      expect(bootstrap).toContain("Connected Services");
    });

    // ── Cleanup ───────────────────────────────────────────────────────────

    test("contains cleanup instructions deleting both bootstrap files", () => {
      expect(bootstrap).toContain("BOOTSTRAP.md");
      expect(bootstrap).toContain("BOOTSTRAP-REFERENCE.md");
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain("delete");
    });

    test("instructs writing a journal entry before cleanup", () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain("journal entry");
    });

    // ── Negative assertions: the old scripted contract is gone ────────────

    test("does NOT contain scripted numbered steps (Step 1:, Step 2:, …)", () => {
      // The whole point of Phase 1 is to strip the rigid scripted sequence.
      // If these come back, something has regressed.
      expect(bootstrap).not.toMatch(/^### Step \d+:/m);
      expect(bootstrap).not.toContain("Step 1: Name Exchange");
      expect(bootstrap).not.toContain("Step 2: Personality Quiz");
      expect(bootstrap).not.toContain("Step 3: What's on Your Mind");
      expect(bootstrap).not.toContain("Step 4: First Task");
      expect(bootstrap).not.toContain("Step 5: Keep the Momentum");
    });

    test("does NOT prescribe a personality quiz / dropdown form", () => {
      // The old scripted version had a "### Step 2: Personality Quiz" header
      // pointing at a ui_show form payload.  None of those surface strings
      // should reappear.  The word "dropdowns" is intentionally allowed in
      // the forbidding sense ("No dropdown forms", "never show dropdowns"),
      // which is part of the new contract, not a regression.
      expect(bootstrap).not.toContain("Personality Quiz");
      expect(bootstrap).not.toContain("personality form");
      expect(bootstrap).not.toContain("ui_show");
      expect(bootstrap).not.toContain("surface_type");
    });

    test("does NOT prescribe the old emotional arc or task-card copy", () => {
      // These were the tell-tale strings of the scripted version.
      expect(bootstrap).not.toContain("Oh, this has personality");
      expect(bootstrap).not.toContain("Oh, this is useful");
      expect(bootstrap).not.toContain("Pick something. I'll do it right now.");
      expect(bootstrap).not.toContain("chain off the task");
      expect(bootstrap).not.toContain("while we're at it");
    });
  });

  describe("BOOTSTRAP-REFERENCE.md", () => {
    test("preserves comment line format instruction", () => {
      expect(bootstrapRef).toMatch(/^_ /);
    });

    test("is explicitly framed as inference reference, not a form/quiz/menu", () => {
      const lower = bootstrapRef.toLowerCase();
      expect(lower).toContain("not a form");
      expect(lower).toContain("not a quiz");
      expect(lower).toContain("not a menu");
      expect(lower).toContain("inference reference");
    });

    test("covers all four personality dimensions", () => {
      const lower = bootstrapRef.toLowerCase();
      expect(lower).toContain("communication style");
      expect(lower).toContain("task style");
      expect(lower).toContain("humor");
      expect(lower).toContain("depth");
    });

    test("tells the model to save specific observations to SOUL.md", () => {
      expect(bootstrapRef).toContain("SOUL.md");
      const lower = bootstrapRef.toLowerCase();
      expect(lower).toContain("specific observations");
    });

    test("explicitly forbids self-reporting / dropdown delivery", () => {
      const lower = bootstrapRef.toLowerCase();
      expect(lower).toContain("never ask the user to self-report");
      expect(lower).toContain("never show them as dropdowns");
    });

    // ── Negative assertions: the old ui_show payloads are gone ────────────

    test("does NOT contain any ui_show form payload", () => {
      expect(bootstrapRef).not.toContain("ui_show");
      expect(bootstrapRef).not.toContain('surface_type: "form"');
      expect(bootstrapRef).not.toContain("submitLabel");
    });

    test("does NOT contain the old task-card ui_show payloads", () => {
      expect(bootstrapRef).not.toContain('surface_type: "card"');
      expect(bootstrapRef).not.toContain("relay_prompt");
      expect(bootstrapRef).not.toContain("Email Not Connected");
      expect(bootstrapRef).not.toContain("Email Already Connected");
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
