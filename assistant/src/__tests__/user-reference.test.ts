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
const { resolveUserReference, resolveGuardianName, DEFAULT_USER_REFERENCE } =
  await import("../prompts/user-reference.js");

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
