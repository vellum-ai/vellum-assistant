/**
 * Tests for persona-resolver helpers used by the drop-user-md migration:
 * `resolveGuardianPersonaPath` and `ensureGuardianPersonaFile`.
 *
 * The module under test reads/writes files under `getWorkspaceDir()`,
 * so these tests stub `util/platform.js` to point at an ephemeral temp
 * directory and stub `contacts/contact-store.js` to control which
 * guardian (if any) is returned by the resolver.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

// ── Mock state ────────────────────────────────────────────────────

let mockWorkspaceDir: string = "";
let mockVellumGuardian:
  | {
      contact: { userFile: string | null };
      channel: Record<string, unknown>;
    }
  | null = null;
let mockAnyGuardian:
  | {
      contact: { userFile: string | null };
      channels: Record<string, unknown>[];
    }
  | null = null;

// ── Mock modules (must precede imports from the module under test) ──

mock.module("../util/platform.js", () => ({
  getWorkspaceDir: () => mockWorkspaceDir,
}));

mock.module("../contacts/contact-store.js", () => ({
  findContactByChannelExternalId: () => null,
  findGuardianForChannel: (channelType: string) =>
    channelType === "vellum" ? mockVellumGuardian : null,
  listGuardianChannels: () => mockAnyGuardian,
}));

// Import AFTER mocks so the module under test binds to the stubbed
// implementations.
import {
  ensureGuardianPersonaFile,
  isGuardianPersonaCustomized,
  resolveGuardianPersona,
  resolveGuardianPersonaPath,
  resolveGuardianPersonaStrict,
} from "../prompts/persona-resolver.js";

// ── Temp workspace scaffold ───────────────────────────────────────

let testRoot: string;

beforeAll(() => {
  testRoot = mkdtempSync(join(tmpdir(), "persona-resolver-test-"));
});

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

beforeEach(() => {
  // Fresh workspace per test, so filesystem state doesn't leak.
  mockWorkspaceDir = mkdtempSync(join(testRoot, "ws-"));
  mockVellumGuardian = null;
  mockAnyGuardian = null;
});

afterEach(() => {
  rmSync(mockWorkspaceDir, { recursive: true, force: true });
});

// ── resolveGuardianPersonaPath ─────────────────────────────────────

describe("resolveGuardianPersonaPath", () => {
  test("returns null when no guardian exists", () => {
    mockVellumGuardian = null;
    mockAnyGuardian = null;

    expect(resolveGuardianPersonaPath()).toBeNull();
  });

  test("returns absolute path when guardian has userFile set", () => {
    mockVellumGuardian = {
      contact: { userFile: "alice.md" },
      channel: {},
    };

    const result = resolveGuardianPersonaPath();
    expect(result).toBe(join(mockWorkspaceDir, "users", "alice.md"));
  });
});

// ── ensureGuardianPersonaFile ──────────────────────────────────────

describe("ensureGuardianPersonaFile", () => {
  test("writes the template when the file is missing", () => {
    const userFile = "alice.md";
    const filePath = join(mockWorkspaceDir, "users", userFile);

    expect(existsSync(filePath)).toBe(false);

    ensureGuardianPersonaFile(userFile);

    expect(existsSync(filePath)).toBe(true);
    const content = readFileSync(filePath, "utf-8");
    expect(content).toContain("# User Profile");
    expect(content).toContain("Preferred name/reference:");
    expect(content).toContain("Daily tools:");
    // Sanity check the comment-line prefix survives verbatim.
    expect(content.startsWith("_ Lines starting with _ are comments")).toBe(
      true,
    );
  });

  test("is a no-op when the file already exists (does not clobber)", () => {
    const userFile = "alice.md";
    const dir = join(mockWorkspaceDir, "users");
    const filePath = join(dir, userFile);
    const existingContent = "# Existing user notes\n\n- Likes sparkling water\n";

    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, existingContent, "utf-8");

    ensureGuardianPersonaFile(userFile);

    const content = readFileSync(filePath, "utf-8");
    expect(content).toBe(existingContent);
  });
});

// ── resolveGuardianPersonaStrict ───────────────────────────────────

describe("resolveGuardianPersonaStrict", () => {
  test("returns null when no guardian contact exists", () => {
    mockVellumGuardian = null;
    mockAnyGuardian = null;

    expect(resolveGuardianPersonaStrict()).toBeNull();
  });

  test("returns null when the guardian's own file is missing, even if default.md exists", () => {
    mockVellumGuardian = {
      contact: { userFile: "alice.md" },
      channel: {},
    };

    // default.md is populated but alice.md is not on disk.
    const usersDir = join(mockWorkspaceDir, "users");
    mkdirSync(usersDir, { recursive: true });
    writeFileSync(
      join(usersDir, "default.md"),
      "- Preferred name/reference: DefaultName\n",
      "utf-8",
    );

    // Strict variant must not leak default.md content.
    expect(resolveGuardianPersonaStrict()).toBeNull();
    // Sanity: the non-strict variant DOES fall back to default.md, which
    // is the documented divergence these tests pin down.
    expect(resolveGuardianPersona()).toContain("DefaultName");
  });

  test("returns guardian file content when present", () => {
    mockVellumGuardian = {
      contact: { userFile: "alice.md" },
      channel: {},
    };

    const usersDir = join(mockWorkspaceDir, "users");
    mkdirSync(usersDir, { recursive: true });
    writeFileSync(
      join(usersDir, "alice.md"),
      "- Preferred name/reference: Alice\n",
      "utf-8",
    );

    expect(resolveGuardianPersonaStrict()).toContain("Alice");
  });
});

// ── isGuardianPersonaCustomized ────────────────────────────────────

describe("isGuardianPersonaCustomized", () => {
  test("returns false when the file does not exist", () => {
    const filePath = join(mockWorkspaceDir, "users", "nobody.md");
    expect(isGuardianPersonaCustomized(filePath)).toBe(false);
  });

  test("returns false for the bare scaffold template (no user edits)", () => {
    const userFile = "alice.md";
    const filePath = join(mockWorkspaceDir, "users", userFile);

    // ensureGuardianPersonaFile writes the canonical template — the
    // exact bytes that "not customized" accepts.
    ensureGuardianPersonaFile(userFile);

    expect(isGuardianPersonaCustomized(filePath)).toBe(false);
  });

  test("returns false when the file contains only comment lines", () => {
    const userFile = "alice.md";
    const dir = join(mockWorkspaceDir, "users");
    const filePath = join(dir, userFile);

    mkdirSync(dir, { recursive: true });
    writeFileSync(
      filePath,
      "_ only comments here\n_ nothing meaningful\n",
      "utf-8",
    );

    expect(isGuardianPersonaCustomized(filePath)).toBe(false);
  });

  test("returns true when the file has user-authored content", () => {
    const userFile = "alice.md";
    const dir = join(mockWorkspaceDir, "users");
    const filePath = join(dir, userFile);

    mkdirSync(dir, { recursive: true });
    writeFileSync(
      filePath,
      "# My profile\n\n- Preferred name/reference: Real User\n",
      "utf-8",
    );

    expect(isGuardianPersonaCustomized(filePath)).toBe(true);
  });
});
