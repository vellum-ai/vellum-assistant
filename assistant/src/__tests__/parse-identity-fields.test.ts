/**
 * Unit tests for identity field parsing and template placeholder filtering.
 *
 * Validates that parseIdentityFields correctly extracts real values from
 * IDENTITY.md content while treating template placeholders (e.g.
 * `_(not yet chosen)_`) as empty/unset.
 */

import { describe, expect, test } from "bun:test";

import {
  isTemplatePlaceholder,
  parseIdentityFields,
} from "../daemon/handlers/identity.js";

// ---------------------------------------------------------------------------
// isTemplatePlaceholder
// ---------------------------------------------------------------------------

describe("isTemplatePlaceholder", () => {
  test("returns true for _(not yet chosen)_", () => {
    expect(isTemplatePlaceholder("_(not yet chosen)_")).toBe(true);
  });

  test("returns true for _(not yet established)_", () => {
    expect(isTemplatePlaceholder("_(not yet established)_")).toBe(true);
  });

  test("returns true for any value matching _(…)_ pattern", () => {
    expect(isTemplatePlaceholder("_(something else)_")).toBe(true);
  });

  test("returns false for normal values", () => {
    expect(isTemplatePlaceholder("Your helpful coding assistant")).toBe(false);
    expect(isTemplatePlaceholder("Jarvis")).toBe(false);
    expect(isTemplatePlaceholder("")).toBe(false);
  });

  test("returns false for partial matches", () => {
    expect(isTemplatePlaceholder("_(incomplete")).toBe(false);
    expect(isTemplatePlaceholder("incomplete)_")).toBe(false);
    expect(isTemplatePlaceholder("_(")).toBe(false);
    expect(isTemplatePlaceholder(")_")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseIdentityFields — placeholder filtering
// ---------------------------------------------------------------------------

describe("parseIdentityFields", () => {
  test("returns empty strings for all template placeholder values", () => {
    const content = [
      "- **Name:** _(not yet chosen)_",
      "- **Role:** _(not yet established)_",
      "- **Personality:** _(not yet chosen)_",
      "- **Emoji:** _(not yet chosen)_",
      "- **Home:** _(not yet chosen)_",
    ].join("\n");

    const fields = parseIdentityFields(content);
    expect(fields.name).toBe("");
    expect(fields.role).toBe("");
    expect(fields.personality).toBe("");
    expect(fields.emoji).toBe("");
    expect(fields.home).toBe("");
  });

  test("preserves real user-provided values", () => {
    const content = [
      "- **Name:** Jarvis",
      "- **Role:** Coding assistant",
      "- **Personality:** Friendly and helpful",
      "- **Emoji:** 🤖",
      "- **Home:** ~/projects",
    ].join("\n");

    const fields = parseIdentityFields(content);
    expect(fields.name).toBe("Jarvis");
    expect(fields.role).toBe("Coding assistant");
    expect(fields.personality).toBe("Friendly and helpful");
    expect(fields.emoji).toBe("🤖");
    expect(fields.home).toBe("~/projects");
  });

  test("handles a mix of real and placeholder values", () => {
    const content = [
      "- **Name:** Jarvis",
      "- **Role:** _(not yet established)_",
      "- **Personality:** Friendly",
      "- **Emoji:** _(not yet chosen)_",
      "- **Home:** ~/dev",
    ].join("\n");

    const fields = parseIdentityFields(content);
    expect(fields.name).toBe("Jarvis");
    expect(fields.role).toBe("");
    expect(fields.personality).toBe("Friendly");
    expect(fields.emoji).toBe("");
    expect(fields.home).toBe("~/dev");
  });

  test("returns role: '' when IDENTITY.md contains placeholder role", () => {
    const content = "- **Role:** _(not yet established)_";
    const fields = parseIdentityFields(content);
    expect(fields.role).toBe("");
  });

  test("returns name: '' when IDENTITY.md contains placeholder name", () => {
    const content = "- **Name:** _(not yet chosen)_";
    const fields = parseIdentityFields(content);
    expect(fields.name).toBe("");
  });

  test('parses role: "Coding assistant" for real values', () => {
    const content = "- **Role:** Coding assistant";
    const fields = parseIdentityFields(content);
    expect(fields.role).toBe("Coding assistant");
  });

  test("returns empty strings when content has no identity fields", () => {
    const fields = parseIdentityFields("# Some other content\nHello world");
    expect(fields.name).toBe("");
    expect(fields.role).toBe("");
    expect(fields.personality).toBe("");
    expect(fields.emoji).toBe("");
    expect(fields.home).toBe("");
  });

  // --- Edge cases (extended coverage) ---

  test("multiple colons in value — captures full value after :**", () => {
    const content = "- **Name:** Dr. Who: Time Lord";
    const fields = parseIdentityFields(content);
    expect(fields.name).toBe("Dr. Who: Time Lord");
  });

  test("**Vibe:** as alternate key for personality", () => {
    const content = "- **Vibe:** Chill and laid-back";
    const fields = parseIdentityFields(content);
    expect(fields.personality).toBe("Chill and laid-back");
  });

  test("empty string input → all fields empty", () => {
    const fields = parseIdentityFields("");
    expect(fields.name).toBe("");
    expect(fields.role).toBe("");
    expect(fields.personality).toBe("");
    expect(fields.emoji).toBe("");
    expect(fields.home).toBe("");
  });

  test("no matching field lines (random text) → all fields empty", () => {
    const content =
      "This is just some random text.\nNothing to see here.\nNo fields at all.";
    const fields = parseIdentityFields(content);
    expect(fields.name).toBe("");
    expect(fields.role).toBe("");
    expect(fields.personality).toBe("");
    expect(fields.emoji).toBe("");
    expect(fields.home).toBe("");
  });

  test("extra blank lines between fields → still parses all fields", () => {
    const content = [
      "- **Name:** Alice",
      "",
      "",
      "- **Role:** Developer",
      "",
      "- **Personality:** Focused",
      "",
      "",
      "- **Emoji:** 💻",
      "",
      "- **Home:** /home/alice",
    ].join("\n");

    const fields = parseIdentityFields(content);
    expect(fields.name).toBe("Alice");
    expect(fields.role).toBe("Developer");
    expect(fields.personality).toBe("Focused");
    expect(fields.emoji).toBe("💻");
    expect(fields.home).toBe("/home/alice");
  });

  test("markdown with non-field content mixed in → ignores noise, parses fields", () => {
    const content = [
      "# My Assistant Identity",
      "",
      "Some introductory paragraph about the assistant.",
      "",
      "- **Name:** Bot9000",
      "- Some other bullet point",
      "- **Role:** General purpose helper",
      "",
      "## Additional Section",
      "",
      "More text here that should be ignored.",
      "- **Emoji:** 🤖",
    ].join("\n");

    const fields = parseIdentityFields(content);
    expect(fields.name).toBe("Bot9000");
    expect(fields.role).toBe("General purpose helper");
    expect(fields.emoji).toBe("🤖");
  });
});
