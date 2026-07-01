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

  // ---------------------------------------------------------------------------
  // parseIdentityFields — prose-style fallbacks
  // ---------------------------------------------------------------------------

  describe("prose-style fallbacks", () => {
    test("parses **Name:** without bullet", () => {
      const fields = parseIdentityFields("**Name:** Jophiel\n**Role:** Assistant\n**Home:** ~/data");
      expect(fields.name).toBe("Jophiel");
      expect(fields.role).toBe("Assistant");
      expect(fields.home).toBe("~/data");
    });

    test('parses "I\'m [Name]" pattern', () => {
      const fields = parseIdentityFields("I'm Jophiel.\n\n## Purpose\nHelp people.");
      expect(fields.name).toBe("Jophiel");
    });

    test('parses "My name is [Name]" pattern', () => {
      const fields = parseIdentityFields("My name is Credence");
      expect(fields.name).toBe("Credence");
    });

    test('parses "I am [Name]" pattern', () => {
      const fields = parseIdentityFields("I am Vel.");
      expect(fields.name).toBe("Vel");
    });

    test("bullet format takes priority over prose on same field", () => {
      const fields = parseIdentityFields([
        "- **Name:** Jarvis",
        "I'm Jophiel.",
      ].join("\n"));
      expect(fields.name).toBe("Jarvis");
    });

    test("extracts **Personality:** without bullet", () => {
      const fields = parseIdentityFields("**Personality:** Snarky and helpful");
      expect(fields.personality).toBe("Snarky and helpful");
    });

    test("extracts **Emoji:** without bullet", () => {
      const fields = parseIdentityFields("**Emoji:** 🔥");
      expect(fields.emoji).toBe("🔥");
    });

    test("handles mixed bullet and prose fields", () => {
      const fields = parseIdentityFields([
        "- **Name:** Jarvis",
        "**Role:** Coding assistant",
        "**Personality:** Friendly",
        "- **Emoji:** 🤖",
        "**Home:** ~/dev",
      ].join("\n"));
      expect(fields.name).toBe("Jarvis");
      expect(fields.role).toBe("Coding assistant");
      expect(fields.personality).toBe("Friendly");
      expect(fields.emoji).toBe("🤖");
      expect(fields.home).toBe("~/dev");
    });

    test("filters template placeholders in prose format", () => {
      const fields = parseIdentityFields("**Name:** _(not yet chosen)_");
      expect(fields.name).toBe("");
    });

    test("extracts **Vibe:** without bullet maps to personality", () => {
      const fields = parseIdentityFields("**Vibe:** Chill and focused");
      expect(fields.personality).toBe("Chill and focused");
    });
  });
});
