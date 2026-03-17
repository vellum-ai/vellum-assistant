import * as realFs from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

const TEST_DIR = "/tmp/vellum-user-ref-test";

mock.module("../util/platform.js", () => ({
  getWorkspacePromptPath: (file: string) => join(TEST_DIR, file),
}));

// Mutable state the tests control
let mockFileExists = false;
let mockFileContent = "";

mock.module("node:fs", () => ({
  ...realFs,
  existsSync: (path: string) => {
    if (path === join(TEST_DIR, "USER.md")) return mockFileExists;
    return false;
  },
  readFileSync: (path: string, _encoding: string) => {
    if (path === join(TEST_DIR, "USER.md") && mockFileExists)
      return mockFileContent;
    throw new Error(`ENOENT: no such file: ${path}`);
  },
}));

// Import after mocks are in place
const {
  resolveUserReference,
  resolveUserPronouns,
  resolveGuardianName,
  DEFAULT_USER_REFERENCE,
} = await import("../prompts/user-reference.js");

describe("resolveUserReference", () => {
  beforeEach(() => {
    mockFileExists = false;
    mockFileContent = "";
  });

  test('returns "my human" when USER.md does not exist', () => {
    mockFileExists = false;
    expect(resolveUserReference()).toBe("my human");
  });

  test('returns "my human" when preferred name field is empty', () => {
    mockFileExists = true;
    mockFileContent = [
      "## Onboarding Snapshot",
      "",
      "- Preferred name/reference:",
      "- Goals:",
      "- Locale:",
    ].join("\n");
    expect(resolveUserReference()).toBe("my human");
  });

  test("returns the configured name when it is set", () => {
    mockFileExists = true;
    mockFileContent = [
      "## Onboarding Snapshot",
      "",
      "- Preferred name/reference: John",
      "- Goals: ship fast",
      "- Locale: en-US",
    ].join("\n");
    expect(resolveUserReference()).toBe("John");
  });

  test("trims whitespace around the configured name", () => {
    mockFileExists = true;
    mockFileContent = "- Preferred name/reference:   Alice   \n";
    expect(resolveUserReference()).toBe("Alice");
  });
});

describe("resolveUserPronouns", () => {
  beforeEach(() => {
    mockFileExists = false;
    mockFileContent = "";
  });

  test("returns null when USER.md does not exist", () => {
    mockFileExists = false;
    expect(resolveUserPronouns()).toBeNull();
  });

  test("returns pronouns from flat USER.md (no Onboarding Snapshot)", () => {
    mockFileExists = true;
    mockFileContent = [
      "# USER.md",
      "",
      "- Preferred name/reference: Alice",
      "- Pronouns: she/her",
      "- Locale: en-US",
    ].join("\n");
    expect(resolveUserPronouns()).toBe("she/her");
  });

  test("returns null when pronouns field is empty in flat format", () => {
    mockFileExists = true;
    mockFileContent = [
      "# USER.md",
      "",
      "- Preferred name/reference: Alice",
      "- Pronouns:",
      "- Locale: en-US",
    ].join("\n");
    expect(resolveUserPronouns()).toBeNull();
  });

  test("returns pronouns from legacy Onboarding Snapshot section", () => {
    mockFileExists = true;
    mockFileContent = [
      "## Onboarding Snapshot",
      "",
      "- Pronouns: they/them",
    ].join("\n");
    expect(resolveUserPronouns()).toBe("they/them");
  });

  test("prefers pronouns above Onboarding Snapshot over inside it", () => {
    mockFileExists = true;
    mockFileContent = [
      "Pronouns: he/him",
      "",
      "## Onboarding Snapshot",
      "",
      "- Pronouns: she/her",
    ].join("\n");
    expect(resolveUserPronouns()).toBe("he/him");
  });

  test("returns null for declined_by_user", () => {
    mockFileExists = true;
    mockFileContent = [
      "- Preferred name/reference: Alice",
      "- Pronouns: declined_by_user",
    ].join("\n");
    expect(resolveUserPronouns()).toBeNull();
  });

  test("strips inferred: prefix", () => {
    mockFileExists = true;
    mockFileContent = [
      "- Preferred name/reference: Alice",
      "- Pronouns: inferred: she/her",
    ].join("\n");
    expect(resolveUserPronouns()).toBe("she/her");
  });
});

describe("resolveGuardianName", () => {
  beforeEach(() => {
    mockFileExists = false;
    mockFileContent = "";
  });

  test("returns USER.md name when present, ignoring guardianDisplayName", () => {
    mockFileExists = true;
    mockFileContent = [
      "## Onboarding Snapshot",
      "",
      "- Preferred name/reference: John",
    ].join("\n");
    expect(resolveGuardianName("Jane")).toBe("John");
  });

  test('returns "my human" when USER.md explicitly sets name to default value', () => {
    mockFileExists = true;
    mockFileContent = [
      "## Onboarding Snapshot",
      "",
      "- Preferred name/reference: my human",
    ].join("\n");
    // The user's explicit choice must be respected even though it matches the default sentinel
    expect(resolveGuardianName("Jane")).toBe("my human");
  });

  test("falls back to guardianDisplayName when USER.md is empty", () => {
    mockFileExists = false;
    expect(resolveGuardianName("Jane")).toBe("Jane");
  });

  test("falls back to DEFAULT_USER_REFERENCE when both are empty", () => {
    mockFileExists = false;
    expect(resolveGuardianName()).toBe(DEFAULT_USER_REFERENCE);
    expect(resolveGuardianName(null)).toBe(DEFAULT_USER_REFERENCE);
    expect(resolveGuardianName("")).toBe(DEFAULT_USER_REFERENCE);
  });

  test("trims whitespace on guardianDisplayName fallback", () => {
    mockFileExists = false;
    expect(resolveGuardianName("  Jane  ")).toBe("Jane");
  });
});
