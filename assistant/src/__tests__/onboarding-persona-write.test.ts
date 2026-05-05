/**
 * Tests for `writeOnboardingSection` in persona-resolver.
 *
 * The function writes a managed `## Onboarding Context` section to the
 * guardian persona file (with a fallback chain). These tests stub
 * `util/platform.js` and `contacts/contact-store.js` to control the
 * write target and verify idempotency, fallback, and field omission.
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
let mockVellumGuardian: {
  contact: { userFile: string | null };
  channel: Record<string, unknown>;
} | null = null;

// ── Mock modules (must precede imports from the module under test) ──

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: (_target, prop) =>
        prop === "child"
          ? () =>
              new Proxy({} as Record<string, unknown>, { get: () => () => {} })
          : () => {},
    }),
  getCliLogger: () => ({}),
  truncateForLog: (v: string) => v,
  initLogger: () => {},
  pruneOldLogFiles: () => 0,
}));

mock.module("../util/platform.js", () => ({
  getWorkspaceDir: () => mockWorkspaceDir,
  getWorkspacePromptPath: (file: string) => join(mockWorkspaceDir, file),
}));

mock.module("../contacts/contact-store.js", () => ({
  findContactByChannelExternalId: () => null,
  findGuardianForChannel: (channelType: string) =>
    channelType === "vellum" ? mockVellumGuardian : null,
  listGuardianChannels: () => null,
}));

// Import AFTER mocks so the module under test binds to the stubbed
// implementations.
import { writeOnboardingSection } from "../prompts/persona-resolver.js";

// ── Temp workspace scaffold ───────────────────────────────────────

let testRoot: string;

function workspacePath(file: string): string {
  return join(mockWorkspaceDir, file);
}

beforeAll(() => {
  testRoot = mkdtempSync(join(tmpdir(), "onboarding-persona-write-test-"));
});

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

beforeEach(() => {
  mockWorkspaceDir = mkdtempSync(join(testRoot, "ws-"));
  mockVellumGuardian = null;
});

afterEach(() => {
  rmSync(mockWorkspaceDir, { recursive: true, force: true });
});

// ── Tests ─────────────────────────────────────────────────────────

describe("writeOnboardingSection", () => {
  test("writes section to guardian persona file when it exists", () => {
    mockVellumGuardian = {
      contact: { userFile: "alice.md" },
      channel: {},
    };
    const guardianPath = workspacePath("users/alice.md");
    mkdirSync(workspacePath("users"), { recursive: true });
    writeFileSync(guardianPath, "# User Profile\n\n- **Name:** Alice\n");

    writeOnboardingSection({
      preferredName: "Alice",
      commonWork: ["builds code, apps, or tools", "plans and coordinates work"],
      dailyTools: ["GitHub", "Linear", "Slack"],
    });

    const content = readFileSync(guardianPath, "utf-8");
    expect(content).toContain("- **Name:** Alice");
    expect(content).toContain("## Onboarding Context");
    expect(content).toContain("- **Preferred name:** Alice");
    expect(content).toContain(
      "- **Common work:** builds code, apps, or tools; plans and coordinates work",
    );
    expect(content).toContain("- **Daily tools:** GitHub, Linear, Slack");
  });

  test("falls back to users/default.md when guardian path is null", () => {
    mockVellumGuardian = null;
    mkdirSync(workspacePath("users"), { recursive: true });
    writeFileSync(
      workspacePath("users/default.md"),
      "# User Profile\n\n- **Name:** Default User\n",
    );

    writeOnboardingSection({
      preferredName: "Alice",
      commonWork: [],
      dailyTools: ["Slack"],
    });

    const content = readFileSync(workspacePath("users/default.md"), "utf-8");
    expect(content).toContain("- **Name:** Default User");
    expect(content).toContain("## Onboarding Context");
    expect(content).toContain("- **Preferred name:** Alice");
    expect(content).toContain("- **Daily tools:** Slack");

    // USER.md should not be created
    expect(existsSync(workspacePath("USER.md"))).toBe(false);
  });

  test("falls back to USER.md when no users/ files exist", () => {
    mockVellumGuardian = null;

    writeOnboardingSection({
      preferredName: "Alice",
      commonWork: [],
      dailyTools: [],
    });

    expect(existsSync(workspacePath("USER.md"))).toBe(true);
    const content = readFileSync(workspacePath("USER.md"), "utf-8");
    expect(content).toContain("## Onboarding Context");
    expect(content).toContain("- **Preferred name:** Alice");
  });

  test("creates file with header + section when target doesn't exist", () => {
    mockVellumGuardian = null;

    writeOnboardingSection({
      preferredName: "Alice",
      commonWork: ["builds code, apps, or tools"],
      dailyTools: ["GitHub", "Linear", "Slack"],
    });

    const content = readFileSync(workspacePath("USER.md"), "utf-8");
    expect(content).toContain("# User Profile");
    expect(content).toContain("## Onboarding Context");
    expect(content).toContain("- **Preferred name:** Alice");
    expect(content).toContain("- **Common work:** builds code, apps, or tools");
    expect(content).toContain("- **Daily tools:** GitHub, Linear, Slack");
  });

  test("idempotent: calling twice produces the same file content", () => {
    mockVellumGuardian = null;
    const normalized = {
      preferredName: "Alice",
      commonWork: ["builds code, apps, or tools"],
      dailyTools: ["GitHub", "Linear"],
    };

    writeOnboardingSection(normalized);
    const first = readFileSync(workspacePath("USER.md"), "utf-8");

    writeOnboardingSection(normalized);
    const second = readFileSync(workspacePath("USER.md"), "utf-8");

    expect(first).toBe(second);
  });

  test("replaces existing onboarding section with updated data", () => {
    mockVellumGuardian = null;

    writeOnboardingSection({
      preferredName: "Alice",
      commonWork: ["builds code, apps, or tools"],
      dailyTools: ["GitHub"],
    });

    writeOnboardingSection({
      preferredName: "Bob",
      commonWork: ["writes docs, emails, or content"],
      dailyTools: ["Notion", "Slack"],
    });

    const content = readFileSync(workspacePath("USER.md"), "utf-8");
    expect(content).toContain("- **Preferred name:** Bob");
    expect(content).toContain(
      "- **Common work:** writes docs, emails, or content",
    );
    expect(content).toContain("- **Daily tools:** Notion, Slack");
    // Old values should be gone
    expect(content).not.toContain("**Preferred name:** Alice");
    expect(content).not.toContain("GitHub");
  });

  test("preserves content outside the managed section", () => {
    mockVellumGuardian = null;
    writeFileSync(
      workspacePath("USER.md"),
      "# User Profile\n\n- **Name:** Alice\n- **Role:** Engineer\n",
    );

    writeOnboardingSection({
      preferredName: "Alice",
      commonWork: [],
      dailyTools: ["GitHub"],
    });

    const content = readFileSync(workspacePath("USER.md"), "utf-8");
    expect(content).toContain("- **Name:** Alice");
    expect(content).toContain("- **Role:** Engineer");
    expect(content).toContain("## Onboarding Context");
    expect(content).toContain("- **Daily tools:** GitHub");
  });

  test("omits empty fields", () => {
    mockVellumGuardian = null;

    writeOnboardingSection({
      commonWork: [],
      dailyTools: [],
    });

    const content = readFileSync(workspacePath("USER.md"), "utf-8");
    expect(content).toContain("## Onboarding Context");
    expect(content).not.toContain("Preferred name");
    expect(content).not.toContain("Common work");
    expect(content).not.toContain("Daily tools");
  });

  test("omits preferredName when undefined", () => {
    mockVellumGuardian = null;

    writeOnboardingSection({
      preferredName: undefined,
      commonWork: ["builds code, apps, or tools"],
      dailyTools: ["GitHub"],
    });

    const content = readFileSync(workspacePath("USER.md"), "utf-8");
    expect(content).not.toContain("Preferred name");
    expect(content).toContain("- **Common work:** builds code, apps, or tools");
    expect(content).toContain("- **Daily tools:** GitHub");
  });

  test("preserves content after onboarding section when followed by another heading", () => {
    mockVellumGuardian = null;
    writeFileSync(
      workspacePath("USER.md"),
      [
        "# User Profile",
        "",
        "- **Name:** Alice",
        "",
        "## Onboarding Context",
        "",
        "- **Preferred name:** Alice",
        "",
        "## Preferences",
        "",
        "- Likes dark mode",
        "",
      ].join("\n"),
    );

    writeOnboardingSection({
      preferredName: "Bob",
      commonWork: [],
      dailyTools: ["Slack"],
    });

    const content = readFileSync(workspacePath("USER.md"), "utf-8");
    expect(content).toContain("- **Preferred name:** Bob");
    expect(content).toContain("- **Daily tools:** Slack");
    expect(content).toContain("## Preferences");
    expect(content).toContain("- Likes dark mode");
    // Old preferred name should be gone from the onboarding section
    expect(content).not.toContain("**Preferred name:** Alice");
  });
});
