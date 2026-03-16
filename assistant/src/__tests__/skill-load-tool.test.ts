import {
  existsSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const TEST_DIR = join(
  tmpdir(),
  `vellum-skill-load-tool-test-${crypto.randomUUID()}`,
);

// Build a mock that covers every export from platform.ts — any function not
// explicitly mapped returns a no-op stub so that transitive imports don't fail.
const platformOverrides: Record<string, (...args: unknown[]) => unknown> = {
  getRootDir: () => TEST_DIR,
  getDataDir: () => TEST_DIR,
  ensureDataDir: () => {},
  getPidPath: () => join(TEST_DIR, "vellum.pid"),
  getDbPath: () => join(TEST_DIR, "data", "assistant.db"),
  getLogPath: () => join(TEST_DIR, "logs", "vellum.log"),
  getWorkspaceDir: () => join(TEST_DIR, "workspace"),
  getWorkspaceSkillsDir: () => join(TEST_DIR, "skills"),
  getWorkspaceConfigPath: () => join(TEST_DIR, "workspace", "config.json"),
  getWorkspaceHooksDir: () => join(TEST_DIR, "workspace", "hooks"),
  getWorkspacePromptPath: (f: unknown) =>
    join(TEST_DIR, "workspace", String(f)),
  getInterfacesDir: () => join(TEST_DIR, "interfaces"),
  getHooksDir: () => join(TEST_DIR, "hooks"),

  getSandboxRootDir: () => join(TEST_DIR, "sandbox"),
  getSandboxWorkingDir: () => join(TEST_DIR, "sandbox", "work"),
  getHistoryPath: () => join(TEST_DIR, "history"),
  getSessionTokenPath: () => join(TEST_DIR, "session-token"),
  readSessionToken: () => null,
  getClipboardCommand: () => null,
  readLockfile: () => null,
  normalizeAssistantId: (id: unknown) => String(id),
  writeLockfile: () => {},
  getEmbeddingModelsDir: () => join(TEST_DIR, "embedding-models"),
  getTCPPort: () => 8765,
  isTCPEnabled: () => false,
  getTCPHost: () => "127.0.0.1",
  isIOSPairingEnabled: () => false,
  getPlatformTokenPath: () => join(TEST_DIR, "platform-token"),
  readPlatformToken: () => null,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getPlatformName: () => process.platform,
};
mock.module("../util/platform.js", () => platformOverrides);

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
  truncateForLog: (s: unknown) => String(s),
}));

// Mock autoInstallFromCatalog — default returns false (not found in catalog).
// Tests can override via `mockAutoInstall.mockImplementation(...)`.
const mockAutoInstall = mock((_skillId: string) => Promise.resolve(false));
mock.module("../skills/catalog-install.js", () => ({
  autoInstallFromCatalog: (skillId: string) => mockAutoInstall(skillId),
  resolveCatalog: (_skillId?: string) => Promise.resolve([]),
}));

await import("../tools/skills/load.js");
const { getTool } = await import("../tools/registry.js");

function writeSkill(
  skillId: string,
  name: string,
  description: string,
  body: string,
): void {
  const skillDir = join(TEST_DIR, "skills", skillId);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: "${name}"\ndescription: "${description}"\n---\n\n${body}\n`,
  );
}

function writeSkillWithIncludes(
  skillId: string,
  name: string,
  description: string,
  body: string,
  includes: string[],
): void {
  const skillDir = join(TEST_DIR, "skills", skillId);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: "${name}"\ndescription: "${description}"\nmetadata: ${JSON.stringify(
      { vellum: { includes } },
    )}\n---\n\n${body}\n`,
  );
}

function writeToolsJson(
  skillId: string,
  tools: Array<{
    name: string;
    description: string;
    category?: string;
    risk?: string;
    input_schema?: Record<string, unknown>;
    executor?: string;
    execution_target?: string;
  }>,
): void {
  const skillDir = join(TEST_DIR, "skills", skillId);
  mkdirSync(skillDir, { recursive: true });
  const manifest = {
    version: 1,
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      category: t.category ?? "general",
      risk: t.risk ?? "low",
      input_schema: t.input_schema ?? { type: "object", properties: {} },
      executor: t.executor ?? "scripts/run.sh",
      execution_target: t.execution_target ?? "host",
    })),
  };
  writeFileSync(join(skillDir, "TOOLS.json"), JSON.stringify(manifest));
}

async function executeSkillLoad(
  input: Record<string, unknown>,
): Promise<{ content: string; isError: boolean }> {
  const tool = getTool("skill_load");
  if (!tool) throw new Error("skill_load tool was not registered");

  const result = await tool.execute(input, {
    workingDir: "/tmp",
    conversationId: "conversation-1",
    trustClass: "guardian",
  });
  return { content: result.content, isError: result.isError };
}

describe("skill_load tool", () => {
  beforeEach(() => {
    mkdirSync(join(TEST_DIR, "skills"), { recursive: true });
    mockAutoInstall.mockReset();
    mockAutoInstall.mockImplementation((_skillId: string) =>
      Promise.resolve(false),
    );
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  test("loads a skill by exact id", async () => {
    writeSkill(
      "release-checklist",
      "Release Checklist",
      "Runs release checks",
      "1. Run tests",
    );
    writeFileSync(
      join(TEST_DIR, "skills", "SKILLS.md"),
      "- release-checklist\n",
    );

    const result = await executeSkillLoad({ skill: "release-checklist" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Skill: Release Checklist");
    expect(result.content).toContain("ID: release-checklist");
    expect(result.content).toContain("1. Run tests");
    expect(result.content).not.toContain('name: "Release Checklist"');
    // Marker must include a version attribute with the v1:<hex> format
    const markerMatch = result.content.match(
      /<loaded_skill id="release-checklist" version="(v1:[a-f0-9]{64})" \/>/,
    );
    expect(markerMatch).not.toBeNull();
  });

  test("loads a skill by exact name (case-insensitive)", async () => {
    writeSkill(
      "oncall",
      "Oncall Runbook",
      "Handles incidents",
      "Page primary responder",
    );
    writeFileSync(join(TEST_DIR, "skills", "SKILLS.md"), "- oncall\n");

    const result = await executeSkillLoad({ skill: "oncall runbook" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Skill: Oncall Runbook");
    expect(result.content).toContain("Page primary responder");
    const markerMatch = result.content.match(
      /<loaded_skill id="oncall" version="(v1:[a-f0-9]{64})" \/>/,
    );
    expect(markerMatch).not.toBeNull();
  });

  test("loads a skill by unique id prefix", async () => {
    writeSkill(
      "incident-response",
      "Incident Response",
      "Triage incidents",
      "Run triage checklist",
    );
    writeSkill(
      "release-checklist",
      "Release Checklist",
      "Release flow",
      "Run release checklist",
    );
    writeFileSync(
      join(TEST_DIR, "skills", "SKILLS.md"),
      "- incident-response\n- release-checklist\n",
    );

    const result = await executeSkillLoad({ skill: "incident" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("ID: incident-response");
    const markerMatch = result.content.match(
      /<loaded_skill id="incident-response" version="(v1:[a-f0-9]{64})" \/>/,
    );
    expect(markerMatch).not.toBeNull();
  });

  test("returns an error when name resolution is ambiguous", async () => {
    writeSkill("skill-a", "Shared Name", "First", "Body A");
    writeSkill("skill-b", "Shared Name", "Second", "Body B");
    writeFileSync(
      join(TEST_DIR, "skills", "SKILLS.md"),
      "- skill-a\n- skill-b\n",
    );

    const result = await executeSkillLoad({ skill: "Shared Name" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Ambiguous skill name");
    expect(result.content).not.toContain("<loaded_skill");
  });

  test("version hash changes when skill content changes", async () => {
    writeSkill(
      "versioned",
      "Versioned Skill",
      "Test versioning",
      "Original body",
    );
    writeFileSync(join(TEST_DIR, "skills", "SKILLS.md"), "- versioned\n");

    const result1 = await executeSkillLoad({ skill: "versioned" });
    const match1 = result1.content.match(
      /<loaded_skill id="versioned" version="(v1:[a-f0-9]{64})" \/>/,
    );
    expect(match1).not.toBeNull();
    const hash1 = match1![1];

    // Modify the skill body
    writeSkill(
      "versioned",
      "Versioned Skill",
      "Test versioning",
      "Updated body",
    );

    const result2 = await executeSkillLoad({ skill: "versioned" });
    const match2 = result2.content.match(
      /<loaded_skill id="versioned" version="(v1:[a-f0-9]{64})" \/>/,
    );
    expect(match2).not.toBeNull();
    const hash2 = match2![1];

    expect(hash1).not.toBe(hash2);
  });

  test("returns an error when skill is missing", async () => {
    writeSkill("existing", "Existing Skill", "Exists", "Body");
    writeFileSync(join(TEST_DIR, "skills", "SKILLS.md"), "- existing\n");

    const result = await executeSkillLoad({ skill: "does-not-exist" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("No skill matched");
    expect(result.content).not.toContain("<loaded_skill");
  });

  test('successful skill_load output shows "none" for skills without includes', async () => {
    writeSkill(
      "standalone",
      "Standalone Skill",
      "A skill with no children",
      "Do the thing",
    );
    writeFileSync(join(TEST_DIR, "skills", "SKILLS.md"), "- standalone\n");

    const result = await executeSkillLoad({ skill: "standalone" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Included Skills (immediate): none");
  });

  test("successful skill_load emits exactly one loaded_skill marker", async () => {
    writeSkill(
      "single-marker",
      "Single Marker Skill",
      "Should have one marker",
      "Step 1",
    );
    writeFileSync(join(TEST_DIR, "skills", "SKILLS.md"), "- single-marker\n");

    const result = await executeSkillLoad({ skill: "single-marker" });
    expect(result.isError).toBe(false);
    const markers = result.content.match(/<loaded_skill/g) || [];
    expect(markers.length).toBe(1);
  });

  test("returns error when skill has missing include", async () => {
    writeSkillWithIncludes("parent", "Parent", "Has missing child", "Body", [
      "missing-child",
    ]);
    writeFileSync(join(TEST_DIR, "skills", "SKILLS.md"), "- parent\n");

    const result = await executeSkillLoad({ skill: "parent" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("missing-child");
    expect(result.content).toContain("not found");
    expect(result.content).not.toContain("<loaded_skill");
  });

  test("returns error when skill has circular include", async () => {
    writeSkillWithIncludes("skill-a", "Skill A", "Cycles", "Body A", [
      "skill-b",
    ]);
    writeSkillWithIncludes("skill-b", "Skill B", "Cycles", "Body B", [
      "skill-a",
    ]);
    writeFileSync(
      join(TEST_DIR, "skills", "SKILLS.md"),
      "- skill-a\n- skill-b\n",
    );

    const result = await executeSkillLoad({ skill: "skill-a" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("circular");
    expect(result.content).not.toContain("<loaded_skill");
  });

  test("succeeds when skill has valid includes", async () => {
    writeSkillWithIncludes(
      "valid-parent",
      "Valid Parent",
      "Has valid child",
      "Body",
      ["valid-child"],
    );
    writeSkill("valid-child", "Valid Child", "A child", "Child body");
    writeFileSync(
      join(TEST_DIR, "skills", "SKILLS.md"),
      "- valid-parent\n- valid-child\n",
    );

    const result = await executeSkillLoad({ skill: "valid-parent" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Skill: Valid Parent");
    expect(result.content).toContain("<loaded_skill");
  });

  test("failed include validation (missing) emits no loaded_skill marker", async () => {
    const skillDir = join(TEST_DIR, "skills", "marker-missing");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      '---\nname: "Marker Missing"\ndescription: "test"\nmetadata: {"vellum":{"includes":["nonexistent"]}}\n---\n\nBody.\n',
    );
    writeFileSync(join(TEST_DIR, "skills", "SKILLS.md"), "- marker-missing\n");

    const result = await executeSkillLoad({ skill: "marker-missing" });
    expect(result.isError).toBe(true);
    expect(result.content).not.toContain("<loaded_skill");
    expect(result.content).not.toMatch(/<loaded_skill\s/);
  });

  test("failed include validation (cycle) emits no loaded_skill marker", async () => {
    const dirA = join(TEST_DIR, "skills", "cycle-a");
    const dirB = join(TEST_DIR, "skills", "cycle-b");
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    writeFileSync(
      join(dirA, "SKILL.md"),
      '---\nname: "Cycle A"\ndescription: "test"\nmetadata: {"vellum":{"includes":["cycle-b"]}}\n---\n\nBody A.\n',
    );
    writeFileSync(
      join(dirB, "SKILL.md"),
      '---\nname: "Cycle B"\ndescription: "test"\nmetadata: {"vellum":{"includes":["cycle-a"]}}\n---\n\nBody B.\n',
    );
    writeFileSync(
      join(TEST_DIR, "skills", "SKILLS.md"),
      "- cycle-a\n- cycle-b\n",
    );

    const result = await executeSkillLoad({ skill: "cycle-a" });
    expect(result.isError).toBe(true);
    expect(result.content).not.toContain("<loaded_skill");
    expect(result.content).not.toMatch(/<loaded_skill\s/);
  });

  test("succeeds when skill has no includes", async () => {
    writeSkill("no-includes", "No Includes", "Plain skill", "Body");
    writeFileSync(join(TEST_DIR, "skills", "SKILLS.md"), "- no-includes\n");

    const result = await executeSkillLoad({ skill: "no-includes" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Skill: No Includes");
  });

  test("skill_load output includes immediate child metadata", async () => {
    writeSkill("child-skill", "Child Skill", "A child skill", "Child body");
    const parentDir = join(TEST_DIR, "skills", "parent-with-children");
    mkdirSync(parentDir, { recursive: true });
    writeFileSync(
      join(parentDir, "SKILL.md"),
      '---\nname: "Parent"\ndescription: "Has children"\nmetadata: {"vellum":{"includes":["child-skill"]}}\n---\n\nParent body.\n',
    );
    writeFileSync(
      join(TEST_DIR, "skills", "SKILLS.md"),
      "- parent-with-children\n- child-skill\n",
    );

    const result = await executeSkillLoad({ skill: "parent-with-children" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Included Skills (immediate):");
    expect(result.content).toContain("child-skill: Child Skill");
    expect(result.content).toContain("<loaded_skill");
  });

  test('skill_load output shows "none" when no includes', async () => {
    writeSkill("solo-skill", "Solo", "No children", "Body");
    writeFileSync(join(TEST_DIR, "skills", "SKILLS.md"), "- solo-skill\n");

    const result = await executeSkillLoad({ skill: "solo-skill" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Included Skills (immediate): none");
  });

  test("e2e: load parent with includes shows child metadata and emits markers for parent and included children", async () => {
    // Set up a parent + child fixture using the helpers
    writeSkill(
      "e2e-child",
      "E2E Child",
      "Child for e2e test",
      "Child instructions.",
    );
    writeSkillWithIncludes(
      "e2e-parent",
      "E2E Parent",
      "Parent with includes",
      "Parent instructions.",
      ["e2e-child"],
    );
    writeFileSync(
      join(TEST_DIR, "skills", "SKILLS.md"),
      "- e2e-parent\n- e2e-child\n",
    );

    // Load the parent
    const result = await executeSkillLoad({ skill: "e2e-parent" });

    // Should succeed
    expect(result.isError).toBe(false);

    // Output should contain the immediate children metadata section with the child
    expect(result.content).toContain("Included Skills (immediate):");
    expect(result.content).toContain("e2e-child: E2E Child");

    // Should emit markers for both parent and included child so child tools get projected
    const markers = result.content.match(/<loaded_skill/g) || [];
    expect(markers.length).toBe(2);
    expect(result.content).toMatch(
      /<loaded_skill id="e2e-parent" version="v1:[a-f0-9]{64}" \/>/,
    );
    expect(result.content).toMatch(
      /<loaded_skill id="e2e-child" version="v1:[a-f0-9]{64}" \/>/,
    );
  });

  test("parent skill lists only immediate children, not transitive grandchildren", async () => {
    // 3-level hierarchy: grandparent -> child -> grandchild
    writeSkill(
      "grandchild",
      "Grandchild Skill",
      "Leaf skill",
      "Grandchild body",
    );
    writeSkillWithIncludes("child", "Child Skill", "Mid-level", "Child body", [
      "grandchild",
    ]);
    writeSkillWithIncludes(
      "grandparent",
      "Grandparent Skill",
      "Top-level",
      "Grandparent body",
      ["child"],
    );
    writeFileSync(
      join(TEST_DIR, "skills", "SKILLS.md"),
      "- grandparent\n- child\n- grandchild\n",
    );

    const result = await executeSkillLoad({ skill: "grandparent" });
    expect(result.isError).toBe(false);

    // The immediate children section must list the direct child
    expect(result.content).toContain("Included Skills (immediate):");
    expect(result.content).toContain("child");

    // Extract only the "Included Skills (immediate)" section to verify
    // grandchild is NOT listed there (it's a transitive dependency)
    const immediateSection = result.content.match(
      /Included Skills \(immediate\):[\s\S]*?(?=\n\n|<loaded_skill)/,
    );
    expect(immediateSection).not.toBeNull();
    expect(immediateSection![0]).not.toContain("grandchild");

    // Loaded-skill marker must be present (validation passed)
    expect(result.content).toMatch(
      /<loaded_skill id="grandparent" version="v1:[a-f0-9]{64}" \/>/,
    );
  });

  test("succeeds with diamond dependency and emits markers for root and immediate children", async () => {
    // Diamond: root includes A and B, both A and B include shared-leaf
    writeSkill(
      "shared-leaf",
      "Shared Leaf",
      "Shared dependency",
      "Shared body",
    );
    writeSkillWithIncludes(
      "branch-a",
      "Branch A",
      "First branch",
      "Branch A body",
      ["shared-leaf"],
    );
    writeSkillWithIncludes(
      "branch-b",
      "Branch B",
      "Second branch",
      "Branch B body",
      ["shared-leaf"],
    );
    writeSkillWithIncludes(
      "diamond-root",
      "Diamond Root",
      "Top of diamond",
      "Root body",
      ["branch-a", "branch-b"],
    );
    writeFileSync(
      join(TEST_DIR, "skills", "SKILLS.md"),
      "- diamond-root\n- branch-a\n- branch-b\n- shared-leaf\n",
    );

    const result = await executeSkillLoad({ skill: "diamond-root" });
    expect(result.isError).toBe(false);

    // Immediate children section should list only branch-a and branch-b
    expect(result.content).toContain("Included Skills (immediate):");
    expect(result.content).toContain("branch-a: Branch A");
    expect(result.content).toContain("branch-b: Branch B");

    // shared-leaf is a transitive dependency — must NOT appear in immediate section
    const immediateSection = result.content.match(
      /Included Skills \(immediate\):[\s\S]*?(?=\n\n|<loaded_skill)/,
    );
    expect(immediateSection).not.toBeNull();
    expect(immediateSection![0]).not.toContain("shared-leaf");

    // Markers for root + immediate includes (branch-a and branch-b)
    const markers = result.content.match(/<loaded_skill/g) || [];
    expect(markers.length).toBe(3);
    expect(result.content).toMatch(
      /<loaded_skill id="diamond-root" version="v1:[a-f0-9]{64}" \/>/,
    );
    expect(result.content).toMatch(
      /<loaded_skill id="branch-a" version="v1:[a-f0-9]{64}" \/>/,
    );
    expect(result.content).toMatch(
      /<loaded_skill id="branch-b" version="v1:[a-f0-9]{64}" \/>/,
    );
  });

  test("returns error when skill includes itself (self-cycle)", async () => {
    writeSkillWithIncludes(
      "self-ref",
      "Self Referencing",
      "Includes itself",
      "Body",
      ["self-ref"],
    );
    writeFileSync(join(TEST_DIR, "skills", "SKILLS.md"), "- self-ref\n");

    const result = await executeSkillLoad({ skill: "self-ref" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("circular");
    expect(result.content).not.toContain("<loaded_skill");
  });

  test("skill with references/ directory appends reference file contents", async () => {
    // Create a skill with a references/ subdirectory
    const skillDir = join(TEST_DIR, "skills", "with-refs");
    mkdirSync(skillDir, { recursive: true });
    mkdirSync(join(skillDir, "references"), { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      '---\nname: "With Refs"\ndescription: "Has references"\n---\n\nMain body.\n',
    );
    writeFileSync(
      join(skillDir, "references", "GUIDE.md"),
      "# Guide\n\nDetailed guide content.",
    );
    writeFileSync(
      join(skillDir, "references", "TROUBLESHOOTING.md"),
      "# Troubleshooting\n\nFix things here.",
    );
    writeFileSync(join(TEST_DIR, "skills", "SKILLS.md"), "- with-refs\n");

    const result = await executeSkillLoad({ skill: "with-refs" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Main body.");
    // Reference files should be appended with headers
    expect(result.content).toContain("--- Reference: Guide ---");
    expect(result.content).toContain("Detailed guide content.");
    expect(result.content).toContain("--- Reference: Troubleshooting ---");
    expect(result.content).toContain("Fix things here.");
    // References must be appended in alphabetical order (Guide before Troubleshooting)
    const guideIdx = result.content.indexOf("--- Reference: Guide ---");
    const troubleshootIdx = result.content.indexOf(
      "--- Reference: Troubleshooting ---",
    );
    expect(guideIdx).toBeLessThan(troubleshootIdx);
  });

  test("skill without references/ directory loads normally", async () => {
    writeSkill("no-refs", "No Refs", "No references dir", "Just body.");
    writeFileSync(join(TEST_DIR, "skills", "SKILLS.md"), "- no-refs\n");

    const result = await executeSkillLoad({ skill: "no-refs" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Just body.");
    expect(result.content).not.toContain("--- Reference:");
  });

  test("references/ directory skips symlinked markdown files that escape the skill directory", async () => {
    if (process.platform === "win32") {
      // Symlink creation is not consistently available in Windows test environments.
      return;
    }

    const skillDir = join(TEST_DIR, "skills", "refs-symlink");
    mkdirSync(skillDir, { recursive: true });
    mkdirSync(join(skillDir, "references"), { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      '---\nname: "Refs Symlink"\ndescription: "Skips symlinks"\n---\n\nBody.\n',
    );

    const outsideSecretPath = join(TEST_DIR, "outside-secret.md");
    writeFileSync(outsideSecretPath, "TOP_SECRET_DO_NOT_LOAD");
    symlinkSync(outsideSecretPath, join(skillDir, "references", "secret.md"));

    writeFileSync(join(TEST_DIR, "skills", "SKILLS.md"), "- refs-symlink\n");

    const result = await executeSkillLoad({ skill: "refs-symlink" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Body.");
    expect(result.content).not.toContain("--- Reference: Secret ---");
    expect(result.content).not.toContain("TOP_SECRET_DO_NOT_LOAD");
  });

  test("references/ directory ignores non-markdown files", async () => {
    const skillDir = join(TEST_DIR, "skills", "refs-filter");
    mkdirSync(skillDir, { recursive: true });
    mkdirSync(join(skillDir, "references"), { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      '---\nname: "Refs Filter"\ndescription: "Filters non-md"\n---\n\nBody.\n',
    );
    writeFileSync(
      join(skillDir, "references", "GUIDE.md"),
      "# Guide\n\nGuide content.",
    );
    writeFileSync(
      join(skillDir, "references", "data.json"),
      '{"key": "value"}',
    );
    writeFileSync(join(TEST_DIR, "skills", "SKILLS.md"), "- refs-filter\n");

    const result = await executeSkillLoad({ skill: "refs-filter" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("--- Reference: Guide ---");
    expect(result.content).not.toContain("data.json");
    expect(result.content).not.toContain('"key"');
  });

  test('skill with empty includes array loads successfully as "none"', async () => {
    // Write a skill with `includes: []` directly in frontmatter.
    // The parser normalizes this to undefined, so it should behave identically
    // to a skill with no includes field.
    const skillDir = join(TEST_DIR, "skills", "empty-includes");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      '---\nname: "Empty Includes"\ndescription: "Has empty array"\nmetadata: {"vellum":{"includes":[]}}\n---\n\nBody.\n',
    );
    writeFileSync(join(TEST_DIR, "skills", "SKILLS.md"), "- empty-includes\n");

    const result = await executeSkillLoad({ skill: "empty-includes" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Included Skills (immediate): none");
    expect(result.content).toMatch(
      /<loaded_skill id="empty-includes" version="v1:[a-f0-9]{64}" \/>/,
    );
  });

  test("skill with TOOLS.json includes tool schemas section in output", async () => {
    writeSkill(
      "skill-with-tools",
      "Skill With Tools",
      "Has tools",
      "Main body.",
    );
    writeToolsJson("skill-with-tools", [
      {
        name: "deploy_app",
        description: "Deploy the application to production",
        input_schema: {
          type: "object",
          properties: {
            environment: {
              type: "string",
              description: "Target environment",
            },
            force: {
              type: "boolean",
              description: "Force deploy even if checks fail",
            },
          },
          required: ["environment"],
        },
      },
      {
        name: "rollback_app",
        description: "Rollback to previous version",
        input_schema: {
          type: "object",
          properties: {
            version: {
              type: "string",
              description: "Version to rollback to",
            },
          },
          required: ["version"],
        },
      },
    ]);
    writeFileSync(
      join(TEST_DIR, "skills", "SKILLS.md"),
      "- skill-with-tools\n",
    );

    const result = await executeSkillLoad({ skill: "skill-with-tools" });
    expect(result.isError).toBe(false);

    // Should contain the Available Tools section header
    expect(result.content).toContain("## Available Tools");

    // Should instruct the LLM to use skill_execute
    expect(result.content).toContain(
      "Use `skill_execute` to call these tools.",
    );

    // Should contain tool names as headings
    expect(result.content).toContain("### deploy_app");
    expect(result.content).toContain("### rollback_app");

    // Should contain tool descriptions
    expect(result.content).toContain("Deploy the application to production");
    expect(result.content).toContain("Rollback to previous version");

    // Should list parameters with types and required/optional markers
    expect(result.content).toContain(
      "- environment (string, required): Target environment",
    );
    expect(result.content).toContain(
      "- force (boolean, optional): Force deploy even if checks fail",
    );
    expect(result.content).toContain(
      "- version (string, required): Version to rollback to",
    );
  });

  test("skill without TOOLS.json does not include tool schemas section", async () => {
    writeSkill("no-tools", "No Tools", "No tools manifest", "Body.");
    writeFileSync(join(TEST_DIR, "skills", "SKILLS.md"), "- no-tools\n");

    const result = await executeSkillLoad({ skill: "no-tools" });
    expect(result.isError).toBe(false);
    expect(result.content).not.toContain("## Available Tools");
    expect(result.content).not.toContain("skill_execute");
  });

  test("included child skill with TOOLS.json has its tool schemas in output", async () => {
    writeSkillWithIncludes(
      "parent-tools",
      "Parent Tools",
      "Parent with tooled child",
      "Parent body.",
      ["child-tools"],
    );
    writeSkill("child-tools", "Child Tools", "Child with tools", "Child body.");
    writeToolsJson("child-tools", [
      {
        name: "child_action",
        description: "A child tool action",
        input_schema: {
          type: "object",
          properties: {
            target: {
              type: "string",
              description: "Action target",
            },
          },
          required: ["target"],
        },
      },
    ]);
    writeFileSync(
      join(TEST_DIR, "skills", "SKILLS.md"),
      "- parent-tools\n- child-tools\n",
    );

    const result = await executeSkillLoad({ skill: "parent-tools" });
    expect(result.isError).toBe(false);

    // The child skill's tool schemas should appear (#### level under ### Tools from …)
    expect(result.content).toContain("#### child_action");
    expect(result.content).toContain("A child tool action");
    expect(result.content).toContain(
      "- target (string, required): Action target",
    );
    expect(result.content).toContain(
      "Use `skill_execute` to call these tools.",
    );
  });

  test("auto-installs missing includes from catalog", async () => {
    // Parent includes "dep-a" which is not initially in the catalog
    writeSkillWithIncludes(
      "auto-parent",
      "Auto Parent",
      "Has auto-installable dep",
      "Parent body",
      ["dep-a"],
    );
    writeFileSync(join(TEST_DIR, "skills", "SKILLS.md"), "- auto-parent\n");

    // Mock autoInstallFromCatalog to succeed and write the skill to disk
    mockAutoInstall.mockImplementation((skillId: string) => {
      if (skillId === "dep-a") {
        writeSkill("dep-a", "Dep A", "A dependency", "Dep A body");
        // Add to SKILLS.md so catalog reload finds it
        writeFileSync(
          join(TEST_DIR, "skills", "SKILLS.md"),
          "- auto-parent\n- dep-a\n",
        );
        return Promise.resolve(true);
      }
      return Promise.resolve(false);
    });

    const result = await executeSkillLoad({ skill: "auto-parent" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Skill: Auto Parent");
    expect(result.content).toContain("<loaded_skill");
    expect(mockAutoInstall).toHaveBeenCalledWith("dep-a");
  });

  test("auto-installs transitive missing includes across rounds", async () => {
    // Skill A includes B, B includes C. Neither B nor C in initial catalog.
    writeSkillWithIncludes("trans-a", "Trans A", "Top level", "Body A", [
      "trans-b",
    ]);
    writeFileSync(join(TEST_DIR, "skills", "SKILLS.md"), "- trans-a\n");

    let round = 0;
    mockAutoInstall.mockImplementation((skillId: string) => {
      if (skillId === "trans-b" && round === 0) {
        // First round: install B (which includes C)
        writeSkillWithIncludes("trans-b", "Trans B", "Mid level", "Body B", [
          "trans-c",
        ]);
        writeFileSync(
          join(TEST_DIR, "skills", "SKILLS.md"),
          "- trans-a\n- trans-b\n",
        );
        round++;
        return Promise.resolve(true);
      }
      if (skillId === "trans-c") {
        // Second round: install C
        writeSkill("trans-c", "Trans C", "Leaf", "Body C");
        writeFileSync(
          join(TEST_DIR, "skills", "SKILLS.md"),
          "- trans-a\n- trans-b\n- trans-c\n",
        );
        return Promise.resolve(true);
      }
      return Promise.resolve(false);
    });

    const result = await executeSkillLoad({ skill: "trans-a" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Skill: Trans A");
    expect(result.content).toContain("<loaded_skill");
    expect(mockAutoInstall).toHaveBeenCalledWith("trans-b");
    expect(mockAutoInstall).toHaveBeenCalledWith("trans-c");
  });

  test("returns error when auto-install of missing include fails", async () => {
    writeSkillWithIncludes(
      "fail-parent",
      "Fail Parent",
      "Has failing dep",
      "Body",
      ["dep-x"],
    );
    writeFileSync(join(TEST_DIR, "skills", "SKILLS.md"), "- fail-parent\n");

    // autoInstallFromCatalog throws an error
    mockAutoInstall.mockImplementation((skillId: string) => {
      if (skillId === "dep-x") {
        return Promise.reject(new Error("Network error"));
      }
      return Promise.resolve(false);
    });

    const result = await executeSkillLoad({ skill: "fail-parent" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("dep-x");
    expect(result.content).toContain("not found");
    expect(result.content).not.toContain("<loaded_skill");
  });

  test("stops after MAX_INSTALL_ROUNDS", async () => {
    // Pathological case: each install round reveals a new missing dep
    writeSkillWithIncludes("loop-root", "Loop Root", "Infinite deps", "Body", [
      "loop-dep-0",
    ]);
    writeFileSync(join(TEST_DIR, "skills", "SKILLS.md"), "- loop-root\n");

    let installCount = 0;
    mockAutoInstall.mockImplementation((skillId: string) => {
      const id = skillId;
      if (id.startsWith("loop-dep-")) {
        installCount++;
        const nextDepId = `loop-dep-${installCount}`;
        // Install the requested dep, but it includes yet another missing dep
        writeSkillWithIncludes(
          id,
          `Loop Dep ${installCount}`,
          "Generated dep",
          "Body",
          [nextDepId],
        );
        // Update SKILLS.md to include all installed deps so far
        const entries = ["- loop-root\n"];
        for (let i = 0; i < installCount; i++) {
          entries.push(`- loop-dep-${i}\n`);
        }
        writeFileSync(join(TEST_DIR, "skills", "SKILLS.md"), entries.join(""));
        return Promise.resolve(true);
      }
      return Promise.resolve(false);
    });

    const result = await executeSkillLoad({ skill: "loop-root" });
    // Should terminate with an error (the final dep is still missing)
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found");
    // Should have terminated — installCount should be bounded by MAX_INSTALL_ROUNDS (5)
    expect(installCount).toBeLessThanOrEqual(5);
  });
});
