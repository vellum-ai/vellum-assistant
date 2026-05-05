/**
 * Tests that vellum-self-knowledge loads correctly and contains the expected
 * routing structure — pointers to sources of truth (CLI, docs, source code)
 * rather than static content.
 */

import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ── Paths ──────────────────────────────────────────────────────────────────

const TEST_DIR = process.env.VELLUM_WORKSPACE_DIR!;

/** Resolve the real skill directory so we can copy SKILL.md into the test. */
const SKILL_SRC_DIR = join(
  import.meta.dirname ?? __dirname,
  "..",
  "..",
  "..",
  "skills",
  "vellum-self-knowledge",
);

// ── Mocks (must be declared before any imports from the project) ──────────

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
  truncateForLog: (s: unknown) => String(s),
}));

// Mock autoInstallFromCatalog
const mockAutoInstall = mock((_skillId: string) => Promise.resolve(false));
mock.module("../skills/catalog-install.js", () => ({
  autoInstallFromCatalog: (skillId: string) => mockAutoInstall(skillId),
  resolveCatalog: (_skillId?: string) => Promise.resolve([]),
}));

interface TestConfig {
  permissions: { autoApproveUpTo?: "none" | "low" | "medium" | "high" };
  skills: { load: { extraDirs: string[] } };
  sandbox: { enabled: boolean };
  [key: string]: unknown;
}

const testConfig: TestConfig = {
  permissions: {},
  skills: { load: { extraDirs: [] } },
  sandbox: { enabled: true },
};

mock.module("../config/loader.js", () => ({
  getConfig: () => testConfig,
  loadConfig: () => testConfig,
  invalidateConfigCache: () => {},
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  getNestedValue: () => undefined,
  setNestedValue: () => {},
}));

// ── Imports (after mocks) ────────────────────────────────────────────────

await import("../tools/skills/load.js");
const { getTool } = await import("../tools/registry.js");

// ── Helpers ──────────────────────────────────────────────────────────────

/** Copy the real vellum-self-knowledge SKILL.md into the test skills dir. */
function installSelfKnowledgeSkill(): void {
  const destDir = join(TEST_DIR, "skills", "vellum-self-knowledge");
  mkdirSync(destDir, { recursive: true });
  copyFileSync(join(SKILL_SRC_DIR, "SKILL.md"), join(destDir, "SKILL.md"));
}

async function executeSkillLoad(
  input: Record<string, unknown>,
  workingDir = "/tmp",
): Promise<{ content: string; isError: boolean }> {
  const tool = getTool("skill_load");
  if (!tool) throw new Error("skill_load tool was not registered");

  const result = await tool.execute(input, {
    workingDir,
    conversationId: "conversation-1",
    trustClass: "guardian",
  });
  return { content: result.content, isError: result.isError };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("vellum-self-knowledge skill", () => {
  beforeEach(() => {
    mkdirSync(join(TEST_DIR, "skills"), { recursive: true });
    mockAutoInstall.mockReset();
    mockAutoInstall.mockImplementation(() => Promise.resolve(false));
    testConfig.skills = { load: { extraDirs: [] } };
    installSelfKnowledgeSkill();
  });

  afterEach(() => {});

  // ── Loads successfully ───────────────────────────────────────────────

  test("loads without error", async () => {
    const result = await executeSkillLoad({ skill: "vellum-self-knowledge" });
    expect(result.isError).toBe(false);
  });

  // ── Contains no static content ───────────────────────────────────────

  test("does not contain hard-coded model names or provider catalogs", async () => {
    const result = await executeSkillLoad({ skill: "vellum-self-knowledge" });
    // Old skill had a model catalog table with specific model IDs
    expect(result.content).not.toContain("claude-sonnet-4-6");
    expect(result.content).not.toContain("claude-opus-4-6");
    expect(result.content).not.toContain("gpt-4o");
    expect(result.content).not.toContain("gemini-2.5");
  });

  test("does not contain inline command tokens", async () => {
    const result = await executeSkillLoad({ skill: "vellum-self-knowledge" });
    expect(result.content).not.toContain("!`bun run");
    expect(result.content).not.toContain("self-info.ts");
  });

  // ── Routes to CLI ────────────────────────────────────────────────────

  test("references the assistant CLI for runtime state", async () => {
    const result = await executeSkillLoad({ skill: "vellum-self-knowledge" });
    expect(result.content).toContain("assistant config get llm");
    expect(result.content).toContain("assistant --version");
    expect(result.content).toContain("assistant skills list");
    expect(result.content).toContain("assistant platform status");
  });

  // ── Routes to docs site ──────────────────────────────────────────────

  test("references the docs site for conceptual questions", async () => {
    const result = await executeSkillLoad({ skill: "vellum-self-knowledge" });
    expect(result.content).toContain("https://www.vellum.ai/docs");
    expect(result.content).toContain("/getting-started/what-is-vellum");
    expect(result.content).toContain("/developer-guide/architecture");
    expect(result.content).toContain("/trust-security/the-permissions-model");
  });

  // ── Routes to source code ────────────────────────────────────────────

  test("references the GitHub repo for deep implementation questions", async () => {
    const result = await executeSkillLoad({ skill: "vellum-self-knowledge" });
    expect(result.content).toContain("github.com/vellum-ai/vellum-assistant");
    expect(result.content).toContain("ARCHITECTURE.md");
  });

  // ── Critical rule ────────────────────────────────────────────────────

  test("contains the critical rule about not answering from memory", async () => {
    const result = await executeSkillLoad({ skill: "vellum-self-knowledge" });
    expect(result.content).toContain("## Critical Rule");
    expect(result.content).toContain("Never answer from memory");
  });

  // ── Resolution order ─────────────────────────────────────────────────

  test("specifies resolution order (CLI → docs → source)", async () => {
    const result = await executeSkillLoad({ skill: "vellum-self-knowledge" });
    expect(result.content).toContain("### Resolution Order");
    expect(result.content).toContain("CLI first");
    expect(result.content).toContain("Docs second");
    expect(result.content).toContain("Source code last");
  });
});
