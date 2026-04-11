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
  resolveGuardianPersonaPath,
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
      contact: { userFile: "sidd.md" },
      channel: {},
    };

    const result = resolveGuardianPersonaPath();
    expect(result).toBe(join(mockWorkspaceDir, "users", "sidd.md"));
  });
});

// ── ensureGuardianPersonaFile ──────────────────────────────────────

describe("ensureGuardianPersonaFile", () => {
  test("writes the template when the file is missing", () => {
    const slug = "sidd.md";
    const filePath = join(mockWorkspaceDir, "users", slug);

    expect(existsSync(filePath)).toBe(false);

    ensureGuardianPersonaFile(slug);

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
    const slug = "sidd.md";
    const dir = join(mockWorkspaceDir, "users");
    const filePath = join(dir, slug);
    const existingContent = "# Existing user notes\n\n- Likes sparkling water\n";

    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, existingContent, "utf-8");

    ensureGuardianPersonaFile(slug);

    const content = readFileSync(filePath, "utf-8");
    expect(content).toBe(existingContent);
  });
});
