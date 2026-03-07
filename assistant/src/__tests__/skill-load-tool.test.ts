import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
  getSocketPath: () => join(TEST_DIR, "vellum.sock"),
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
  getIpcBlobDir: () => join(TEST_DIR, "blobs"),
  getSandboxRootDir: () => join(TEST_DIR, "sandbox"),
  getSandboxWorkingDir: () => join(TEST_DIR, "sandbox", "work"),
  getHistoryPath: () => join(TEST_DIR, "history"),
  getSessionTokenPath: () => join(TEST_DIR, "session-token"),
  readSessionToken: () => null,
  getClipboardCommand: () => null,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getPlatformName: () => process.platform,
  removeSocketFile: () => {},
};
mock.module("../util/platform.js", () => platformOverrides);

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
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
    `---\nname: "${name}"\ndescription: "${description}"\nincludes: ${JSON.stringify(
      includes,
    )}\n---\n\n${body}\n`,
  );
}

async function executeSkillLoad(
  input: Record<string, unknown>,
): Promise<{ content: string; isError: boolean }> {
  const tool = getTool("skill_load");
  if (!tool) throw new Error("skill_load tool was not registered");

  const result = await tool.execute(input, {
    workingDir: "/tmp",
    sessionId: "session-1",
    conversationId: "conversation-1",
    trustClass: "guardian",
  });
  return { content: result.content, isError: result.isError };
}

describe("skill_load tool", () => {
  beforeEach(() => {
    mkdirSync(join(TEST_DIR, "skills"), { recursive: true });
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
      '---\nname: "Marker Missing"\ndescription: "test"\nincludes: ["nonexistent"]\n---\n\nBody.\n',
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
      '---\nname: "Cycle A"\ndescription: "test"\nincludes: ["cycle-b"]\n---\n\nBody A.\n',
    );
    writeFileSync(
      join(dirB, "SKILL.md"),
      '---\nname: "Cycle B"\ndescription: "test"\nincludes: ["cycle-a"]\n---\n\nBody B.\n',
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
      '---\nname: "Parent"\ndescription: "Has children"\nincludes: ["child-skill"]\n---\n\nParent body.\n',
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

  test('skill with empty includes array loads successfully as "none"', async () => {
    // Write a skill with `includes: []` directly in frontmatter.
    // The parser normalizes this to undefined, so it should behave identically
    // to a skill with no includes field.
    const skillDir = join(TEST_DIR, "skills", "empty-includes");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      '---\nname: "Empty Includes"\ndescription: "Has empty array"\nincludes: []\n---\n\nBody.\n',
    );
    writeFileSync(join(TEST_DIR, "skills", "SKILLS.md"), "- empty-includes\n");

    const result = await executeSkillLoad({ skill: "empty-includes" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Included Skills (immediate): none");
    expect(result.content).toMatch(
      /<loaded_skill id="empty-includes" version="v1:[a-f0-9]{64}" \/>/,
    );
  });
});
