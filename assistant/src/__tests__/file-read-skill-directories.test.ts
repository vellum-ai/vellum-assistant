import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import type { SkillSummary } from "../config/skills.js";

// Skill directories are enumerated from the catalog. The stub stands in for
// skills installed outside the workspace (bundled skills in the install tree,
// plugin-resident skills), which is where the allowance matters.
let catalogStub: SkillSummary[] = [];

const actualSkills = await import("../config/skills.js");
mock.module("../config/skills.js", () => ({
  ...actualSkills,
  loadSkillCatalog: () => catalogStub,
}));

import { finalizeTool } from "../tools/tool-defaults.js";
import type { Tool, ToolContext } from "../tools/types.js";

let fileReadTool: Tool;
let fileWriteTool: Tool;
let invalidateSkillDirectoriesCache: () => void;

beforeAll(async () => {
  const [read, write, skillDirectories] = await Promise.all([
    import("../tools/filesystem/read.js"),
    import("../tools/filesystem/write.js"),
    import("../tools/shared/filesystem/skill-directories.js"),
  ]);
  fileReadTool = finalizeTool(read.fileReadTool, "file_read");
  fileWriteTool = finalizeTool(write.fileWriteTool, "file_write");
  invalidateSkillDirectoriesCache =
    skillDirectories.invalidateSkillDirectoriesCache;
});

const testDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  testDirs.push(dir);
  return dir;
}

function makeContext(workingDir: string): ToolContext {
  return {
    workingDir,
    conversationId: "test-conversation",
    trustClass: "guardian",
  };
}

/**
 * Create a skill directory outside the workspace and register it in the
 * catalog stub, mirroring a bundled skill in the install tree.
 */
function makeSkillDirectory(id: string): string {
  const installTree = makeTempDir("skill-dirs-install-");
  const directoryPath = join(installTree, id);
  mkdirSync(join(directoryPath, "references"), { recursive: true });
  writeFileSync(join(directoryPath, "SKILL.md"), `# ${id}\n`);
  catalogStub = [
    ...catalogStub,
    {
      id,
      directoryPath,
      skillFilePath: join(directoryPath, "SKILL.md"),
    } as SkillSummary,
  ];
  invalidateSkillDirectoriesCache();
  return directoryPath;
}

beforeEach(() => {
  // The allowance only changes behavior where the boundary is hard: on
  // non-containerized installs out-of-workspace reads already fall back to
  // host-style validation.
  process.env.IS_CONTAINERIZED = "true";
  catalogStub = [];
  invalidateSkillDirectoriesCache();
});

afterEach(() => {
  delete process.env.IS_CONTAINERIZED;
  catalogStub = [];
  invalidateSkillDirectoriesCache();
  for (const dir of testDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("file_read skill directory allowance", () => {
  test("reads a reference file inside a bundled skill directory", async () => {
    const workspace = makeTempDir("skill-dirs-workspace-");
    const skillDir = makeSkillDirectory("image-studio");
    const referencePath = join(skillDir, "references", "guide.md");
    writeFileSync(referencePath, "# Guide\nreference body\n");

    const result = await fileReadTool.execute(
      { path: referencePath },
      makeContext(workspace),
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("reference body");
  });

  test("denies a symlink inside a skill directory that points outside it", async () => {
    const workspace = makeTempDir("skill-dirs-workspace-");
    const skillDir = makeSkillDirectory("image-studio");
    const secretDir = makeTempDir("skill-dirs-secret-");
    const secretPath = join(secretDir, "secret.md");
    writeFileSync(secretPath, "secret body\n");
    const escapePath = join(skillDir, "references", "escape.md");
    symlinkSync(secretPath, escapePath);

    const result = await fileReadTool.execute(
      { path: escapePath },
      makeContext(workspace),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("outside the working directory");
    expect(result.content).not.toContain("secret body");
  });

  test("keeps the original error for a path outside both the workspace and skill directories", async () => {
    const workspace = makeTempDir("skill-dirs-workspace-");
    makeSkillDirectory("image-studio");
    const outsideDir = makeTempDir("skill-dirs-outside-");
    const outsidePath = join(outsideDir, "notes.md");
    writeFileSync(outsidePath, "outside body\n");

    const result = await fileReadTool.execute(
      { path: outsidePath },
      makeContext(workspace),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("outside the working directory");
    expect(result.content).toContain(
      "To read files outside the workspace, use the host_file_read tool instead.",
    );
  });

  test("denies file_write into a skill directory", async () => {
    const workspace = makeTempDir("skill-dirs-workspace-");
    const skillDir = makeSkillDirectory("image-studio");
    const targetPath = join(skillDir, "references", "injected.md");

    const result = await fileWriteTool.execute(
      { path: targetPath, content: "injected body\n" },
      makeContext(workspace),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("outside the working directory");
    expect(existsSync(targetPath)).toBe(false);
  });
});
