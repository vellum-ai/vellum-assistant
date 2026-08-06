import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
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
  test,
} from "bun:test";

import { finalizeTool } from "../tools/tool-defaults.js";
import type { Tool, ToolContext } from "../tools/types.js";

let fileReadTool: Tool;
let fileWriteTool: Tool;

beforeAll(async () => {
  const [read, write] = await Promise.all([
    import("../tools/filesystem/read.js"),
    import("../tools/filesystem/write.js"),
  ]);
  fileReadTool = finalizeTool(read.fileReadTool, "file_read");
  fileWriteTool = finalizeTool(write.fileWriteTool, "file_write");
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
 * A skill installed outside the workspace, mirroring a bundled skill in the
 * container's install tree (`/app/assistant/src/config/bundled-skills/<id>`).
 * Skill bodies point the model at these reference files by absolute path.
 */
function makeInstalledSkill(id: string): string {
  const installTree = makeTempDir("container-install-");
  const directoryPath = join(installTree, id);
  mkdirSync(join(directoryPath, "references"), { recursive: true });
  writeFileSync(join(directoryPath, "SKILL.md"), `# ${id}\n`);
  return directoryPath;
}

beforeEach(() => {
  // The read allowance only changes behavior where the boundary is hard: on
  // non-containerized installs out-of-workspace reads already fall back to
  // host-style validation.
  process.env.IS_CONTAINERIZED = "true";
});

afterEach(() => {
  delete process.env.IS_CONTAINERIZED;
  delete process.env.GATEWAY_SECURITY_DIR;
  for (const dir of testDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("file_read outside the workspace in a container", () => {
  test("reads a reference file from the install tree", async () => {
    const workspace = makeTempDir("container-workspace-");
    const skillDir = makeInstalledSkill("image-studio");
    const referencePath = join(skillDir, "references", "guide.md");
    writeFileSync(referencePath, "# Guide\nreference body\n");

    const result = await fileReadTool.execute(
      { path: referencePath },
      makeContext(workspace),
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("reference body");
  });

  test("denies the service security directory", async () => {
    const workspace = makeTempDir("container-workspace-");
    const securityDir = makeTempDir("container-security-");
    writeFileSync(join(securityDir, "trust.json"), "trust body\n");
    process.env.GATEWAY_SECURITY_DIR = securityDir;

    const result = await fileReadTool.execute(
      { path: join(securityDir, "trust.json") },
      makeContext(workspace),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("service security directory");
    expect(result.content).not.toContain("trust body");
  });

  test("denies the daemon's own process environment", async () => {
    const workspace = makeTempDir("container-workspace-");

    const result = await fileReadTool.execute(
      { path: "/proc/self/environ" },
      makeContext(workspace),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("process environment");
  });

  test("denies file_write outside the workspace", async () => {
    const workspace = makeTempDir("container-workspace-");
    const skillDir = makeInstalledSkill("image-studio");
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
