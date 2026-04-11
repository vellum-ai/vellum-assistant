/**
 * Tests for user-reference resolvers. After the drop-user-md migration,
 * `readPreferredNameFromUserMd` and `resolveUserPronouns` source their
 * content from `resolveGuardianPersona()` instead of the legacy
 * workspace-root `USER.md`. We mock the persona-resolver module directly
 * so tests can drive the input content without touching disk.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// Mutable state the tests control — represents the value returned by
// `resolveGuardianPersona()` (comment-stripped string, or null when no
// guardian / empty file).
let mockGuardianPersona: string | null = null;

mock.module("../prompts/persona-resolver.js", () => ({
  resolveGuardianPersona: () => mockGuardianPersona,
}));

// Import after mocks are in place so the module under test binds to
// the stubbed implementation.
const {
  resolveUserReference,
  resolveUserPronouns,
  resolveGuardianName,
  DEFAULT_USER_REFERENCE,
} = await import("../prompts/user-reference.js");

describe("resolveUserReference", () => {
  beforeEach(() => {
    mockGuardianPersona = null;
  });

  test('returns "my human" when no guardian persona exists', () => {
    mockGuardianPersona = null;
    expect(resolveUserReference()).toBe("my human");
  });

  test('returns "my human" when preferred name field is empty', () => {
    mockGuardianPersona = [
      "## Onboarding Snapshot",
      "",
      "- Preferred name/reference:",
      "- Goals:",
      "- Locale:",
    ].join("\n");
    expect(resolveUserReference()).toBe("my human");
  });

  test("returns the configured name when it is set", () => {
    mockGuardianPersona = [
      "## Onboarding Snapshot",
      "",
      "- Preferred name/reference: John",
      "- Goals: ship fast",
      "- Locale: en-US",
    ].join("\n");
    expect(resolveUserReference()).toBe("John");
  });

  test("trims whitespace around the configured name", () => {
    mockGuardianPersona = "- Preferred name/reference:   Alice   \n";
    expect(resolveUserReference()).toBe("Alice");
  });
});

describe("resolveUserPronouns", () => {
  beforeEach(() => {
    mockGuardianPersona = null;
  });

  test("returns null when no guardian persona exists", () => {
    mockGuardianPersona = null;
    expect(resolveUserPronouns()).toBeNull();
  });

  test("returns pronouns from flat persona file (no Onboarding Snapshot)", () => {
    mockGuardianPersona = [
      "# User Profile",
      "",
      "- Preferred name/reference: Alice",
      "- Pronouns: she/her",
      "- Locale: en-US",
    ].join("\n");
    expect(resolveUserPronouns()).toBe("she/her");
  });

  test("returns null when pronouns field is empty in flat format", () => {
    mockGuardianPersona = [
      "# User Profile",
      "",
      "- Preferred name/reference: Alice",
      "- Pronouns:",
      "- Locale: en-US",
    ].join("\n");
    expect(resolveUserPronouns()).toBeNull();
  });

  test("returns pronouns from legacy Onboarding Snapshot section", () => {
    mockGuardianPersona = [
      "## Onboarding Snapshot",
      "",
      "- Pronouns: they/them",
    ].join("\n");
    expect(resolveUserPronouns()).toBe("they/them");
  });

  test("prefers pronouns above Onboarding Snapshot over inside it", () => {
    mockGuardianPersona = [
      "Pronouns: he/him",
      "",
      "## Onboarding Snapshot",
      "",
      "- Pronouns: she/her",
    ].join("\n");
    expect(resolveUserPronouns()).toBe("he/him");
  });

  test("returns null for declined_by_user", () => {
    mockGuardianPersona = [
      "- Preferred name/reference: Alice",
      "- Pronouns: declined_by_user",
    ].join("\n");
    expect(resolveUserPronouns()).toBeNull();
  });

  test("strips inferred: prefix", () => {
    mockGuardianPersona = [
      "- Preferred name/reference: Alice",
      "- Pronouns: inferred: she/her",
    ].join("\n");
    expect(resolveUserPronouns()).toBe("she/her");
  });
});

describe("resolveGuardianName", () => {
  beforeEach(() => {
    mockGuardianPersona = null;
  });

  test("returns persona name when present, ignoring guardianDisplayName", () => {
    mockGuardianPersona = [
      "## Onboarding Snapshot",
      "",
      "- Preferred name/reference: John",
    ].join("\n");
    expect(resolveGuardianName("Jane")).toBe("John");
  });

  test('returns "my human" when persona explicitly sets name to default value', () => {
    mockGuardianPersona = [
      "## Onboarding Snapshot",
      "",
      "- Preferred name/reference: my human",
    ].join("\n");
    // The user's explicit choice must be respected even though it matches the default sentinel
    expect(resolveGuardianName("Jane")).toBe("my human");
  });

  test("falls back to guardianDisplayName when persona is empty", () => {
    mockGuardianPersona = null;
    expect(resolveGuardianName("Jane")).toBe("Jane");
  });

  test("falls back to DEFAULT_USER_REFERENCE when both are empty", () => {
    mockGuardianPersona = null;
    expect(resolveGuardianName()).toBe(DEFAULT_USER_REFERENCE);
    expect(resolveGuardianName(null)).toBe(DEFAULT_USER_REFERENCE);
    expect(resolveGuardianName("")).toBe(DEFAULT_USER_REFERENCE);
  });

  test("trims whitespace on guardianDisplayName fallback", () => {
    mockGuardianPersona = null;
    expect(resolveGuardianName("  Jane  ")).toBe("Jane");
  });
});
