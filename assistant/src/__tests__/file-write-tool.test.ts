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
}> = [];
let enqueueThrows = false;

mock.module("../plugins/defaults/memory/jobs/embed-pkb-file.js", () => ({
  enqueuePkbIndexJob: (input: { pkbRoot: string; absPath: string }) => {
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

import { finalizeTool } from "../tools/tool-defaults.js";
import type { Tool, ToolContext } from "../tools/types.js";

let fileWriteTool: Tool;
const testDirs: string[] = [];

beforeAll(async () => {
  const { fileWriteTool: definition } =
    await import("../tools/filesystem/write.js");
  fileWriteTool = finalizeTool(definition, "file_write");
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
    });
  });

  test("payload identifies the file alone — the PKB index is workspace-shared", async () => {
    const workingDir = makeTempDir();
    setWorkspaceDir(workingDir);
    mkdirSync(join(workingDir, "pkb"), { recursive: true });

    const result = await fileWriteTool.execute(
      { path: "pkb/private.md", content: "secret\n" },
      { ...makeContext(workingDir), conversationId: "another-conversation" },
    );

    expect(result.isError).toBe(false);
    expect(enqueueCalls).toHaveLength(1);
    // All conversations share one PKB index — the job payload carries no
    // conversation or scope discriminator.
    expect(Object.keys(enqueueCalls[0]!).sort()).toEqual([
      "absPath",
      "pkbRoot",
    ]);
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
    expect(existsSync(join(workingDir, "pkb", "oops.md"))).toBe(true);
  });
});

describe("file_write artifact-HTML guard", () => {
  test("rejects a self-contained interactive HTML visualization", async () => {
    const dir = makeTempDir();
    const html =
      "<!doctype html><html><head><title>Food Market</title></head>" +
      "<body><canvas id='c'></canvas><script>" +
      "const data=[{x:1,y:2}];".padEnd(4000, "/") +
      "new Chart(document.getElementById('c'), {data});</script></body></html>";

    const result = await fileWriteTool.execute(
      { path: "food-market-stats.html", content: html },
      makeContext(dir),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('skill: "app-builder"');
    expect(existsSync(join(dir, "food-market-stats.html"))).toBe(false);
  });

  test("allows app-builder's thin shell index.html (external module script)", async () => {
    const dir = makeTempDir();
    const shell =
      "<!doctype html><html><head>" +
      "<link rel='stylesheet' href='/src/styles.css'>".padEnd(3200, " ") +
      "</head><body><div id='app'></div>" +
      "<script type='module' src='/src/main.tsx'></script></body></html>";

    const result = await fileWriteTool.execute(
      { path: "src/index.html", content: shell },
      makeContext(dir),
    );

    expect(result.isError).toBe(false);
    expect(existsSync(join(dir, "src", "index.html"))).toBe(true);
  });

  test("allows a small/static HTML snippet", async () => {
    const dir = makeTempDir();
    const result = await fileWriteTool.execute(
      { path: "note.html", content: "<html><body><h1>Hi</h1></body></html>" },
      makeContext(dir),
    );

    expect(result.isError).toBe(false);
    expect(existsSync(join(dir, "note.html"))).toBe(true);
  });

  test("allows a non-HTML file even with inline script-like content", async () => {
    const dir = makeTempDir();
    const result = await fileWriteTool.execute(
      {
        path: "notes.md",
        content:
          "<script>" + "x".padEnd(2000, "x") + "</script>" + "\n# notes\n",
      },
      makeContext(dir),
    );

    expect(result.isError).toBe(false);
    expect(existsSync(join(dir, "notes.md"))).toBe(true);
  });
});
