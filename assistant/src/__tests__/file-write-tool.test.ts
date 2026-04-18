import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  mock,
  test,
} from "bun:test";

// Track calls to enqueuePkbIndexJob across tests. Captured via mock.module
// below; individual tests clear and inspect the array.
const enqueueCalls: Array<{
  pkbRoot: string;
  absPath: string;
  memoryScopeId: string;
}> = [];
let enqueueThrows = false;

mock.module("../memory/jobs/embed-pkb-file.js", () => ({
  enqueuePkbIndexJob: (input: {
    pkbRoot: string;
    absPath: string;
    memoryScopeId: string;
  }) => {
    if (enqueueThrows) {
      throw new Error("simulated enqueue failure");
    }
    enqueueCalls.push(input);
    return "job-id";
  },
}));

// Override workspace dir via VELLUM_WORKSPACE_DIR so PKB-root detection
// targets a temp directory without having to mock platform.js wholesale
// (which would destabilize the rest of the tool registry's dependency tree).
function setWorkspaceDir(dir: string): void {
  process.env.VELLUM_WORKSPACE_DIR = dir;
}

import { getTool } from "../tools/registry.js";
import type { Tool, ToolContext } from "../tools/types.js";

let fileWriteTool: Tool;
const testDirs: string[] = [];

beforeAll(async () => {
  await import("../tools/filesystem/write.js");
  fileWriteTool = getTool("file_write")!;
});

function makeContext(workingDir: string): ToolContext {
  return {
    workingDir,
    conversationId: "test-conversation",
    trustClass: "guardian",
  };
}

afterEach(() => {
  for (const dir of testDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const originalWorkspaceDirEnv = process.env.VELLUM_WORKSPACE_DIR;

beforeEach(() => {
  enqueueCalls.length = 0;
  enqueueThrows = false;
  // Reset to a stable tmp path so the sandbox tests (which don't use pkb/)
  // deterministically land outside any configured PKB root.
  process.env.VELLUM_WORKSPACE_DIR = tmpdir();
});

afterEach(() => {
  if (originalWorkspaceDirEnv === undefined) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = originalWorkspaceDirEnv;
  }
});

function makeTempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "file-write-test-")));
  testDirs.push(dir);
  return dir;
}

describe("file_write tool (sandbox)", () => {
  test("creates a new file", async () => {
    const dir = makeTempDir();

    const result = await fileWriteTool.execute(
      { path: "new.txt", content: "hello world" },
      makeContext(dir),
    );

    expect(result.isError).toBe(false);
    const filePath = join(dir, "new.txt");
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, "utf-8")).toBe("hello world");
    expect(result.diff?.isNewFile).toBe(true);
  });

  test("overwrites existing file and returns diff", async () => {
    const dir = makeTempDir();
    const filePath = join(dir, "existing.txt");
    writeFileSync(filePath, "old content");

    const result = await fileWriteTool.execute(
      { path: "existing.txt", content: "new content" },
      makeContext(dir),
    );

    expect(result.isError).toBe(false);
    expect(readFileSync(filePath, "utf-8")).toBe("new content");
    expect(result.diff).toEqual({
      filePath,
      oldContent: "old content",
      newContent: "new content",
      isNewFile: false,
    });
  });

  test("creates nested directories", async () => {
    const dir = makeTempDir();

    const result = await fileWriteTool.execute(
      { path: "a/b/c/deep.txt", content: "deep content" },
      makeContext(dir),
    );

    expect(result.isError).toBe(false);
    const filePath = join(dir, "a", "b", "c", "deep.txt");
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, "utf-8")).toBe("deep content");
  });

  test("blocks path traversal escape", async () => {
    const dir = makeTempDir();

    const result = await fileWriteTool.execute(
      { path: "../../escape.txt", content: "escaped" },
      makeContext(dir),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("outside the working directory");
  });

  test("blocks oversize content", async () => {
    const dir = makeTempDir();

    // Create content that exceeds the 100 MB limit
    const oversizeContent = "x".repeat(101 * 1024 * 1024);

    const result = await fileWriteTool.execute(
      { path: "big.txt", content: oversizeContent },
      makeContext(dir),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("exceeds");
  });
});

describe("file_write tool PKB re-index hook", () => {
  test("enqueues a PKB re-index job when writing under pkb/", async () => {
    const workingDir = makeTempDir();
    setWorkspaceDir(workingDir);
    mkdirSync(join(workingDir, "pkb"), { recursive: true });

    const result = await fileWriteTool.execute(
      { path: "pkb/note.md", content: "# hello\nworld\n" },
      makeContext(workingDir),
    );

    expect(result.isError).toBe(false);
    expect(enqueueCalls).toHaveLength(1);
    expect(enqueueCalls[0]).toEqual({
      pkbRoot: join(workingDir, "pkb"),
      absPath: join(workingDir, "pkb", "note.md"),
      memoryScopeId: "default",
    });
  });

  test("forwards memoryScopeId from context when present", async () => {
    const workingDir = makeTempDir();
    setWorkspaceDir(workingDir);
    mkdirSync(join(workingDir, "pkb"), { recursive: true });

    const ctx: ToolContext = {
      ...makeContext(workingDir),
      memoryScopeId: "private:abc123",
    };

    const result = await fileWriteTool.execute(
      { path: "pkb/private.md", content: "secret\n" },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(enqueueCalls).toHaveLength(1);
    expect(enqueueCalls[0]?.memoryScopeId).toBe("private:abc123");
  });

  test("does NOT enqueue when writing outside pkb/", async () => {
    const workingDir = makeTempDir();
    setWorkspaceDir(workingDir);

    const result = await fileWriteTool.execute(
      { path: "notes.md", content: "# not pkb\n" },
      makeContext(workingDir),
    );

    expect(result.isError).toBe(false);
    expect(enqueueCalls).toHaveLength(0);
  });

  test("does NOT enqueue for a sibling directory whose name is a pkb prefix", async () => {
    // Guard against `<root>/pkbsomethingelse` being treated as inside `<root>/pkb`.
    const workingDir = makeTempDir();
    setWorkspaceDir(workingDir);
    mkdirSync(join(workingDir, "pkbsibling"), { recursive: true });

    const result = await fileWriteTool.execute(
      { path: "pkbsibling/file.md", content: "not pkb\n" },
      makeContext(workingDir),
    );

    expect(result.isError).toBe(false);
    expect(enqueueCalls).toHaveLength(0);
  });

  test("enqueue failure is swallowed and write result stays successful", async () => {
    const workingDir = makeTempDir();
    setWorkspaceDir(workingDir);
    mkdirSync(join(workingDir, "pkb"), { recursive: true });
    enqueueThrows = true;

    const result = await fileWriteTool.execute(
      { path: "pkb/oops.md", content: "still writes\n" },
      makeContext(workingDir),
    );

    expect(result.isError).toBe(false);
    // The mock throws, so nothing gets pushed to enqueueCalls. The critical
    // behavior is that the thrown error never surfaces through execute().
    expect(enqueueCalls).toHaveLength(0);
    expect(
      existsSync(join(workingDir, "pkb", "oops.md")),
    ).toBe(true);
  });
});
