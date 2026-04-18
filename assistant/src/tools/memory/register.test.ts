import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import type { ToolContext } from "../types.js";

let tmpWorkspace: string;
let previousWorkspaceEnv: string | undefined;

// Track calls to enqueuePkbIndexJob so we can assert remember wires writes
// through to the re-index queue. Declared at module scope so the mock.module
// factory (hoisted) can close over it.
const enqueueCalls: Array<{
  pkbRoot: string;
  absPath: string;
  memoryScopeId: string;
}> = [];
let enqueueShouldThrow = false;

mock.module("../../memory/jobs/embed-pkb-file.js", () => ({
  enqueuePkbIndexJob: (input: {
    pkbRoot: string;
    absPath: string;
    memoryScopeId: string;
  }) => {
    enqueueCalls.push(input);
    if (enqueueShouldThrow) {
      throw new Error("simulated enqueue failure");
    }
    return "job-mock-id";
  },
}));

beforeAll(() => {
  tmpWorkspace = mkdtempSync(join(tmpdir(), "remember-tool-test-"));
  previousWorkspaceEnv = process.env.VELLUM_WORKSPACE_DIR;
  process.env.VELLUM_WORKSPACE_DIR = tmpWorkspace;
});

afterAll(() => {
  if (previousWorkspaceEnv === undefined) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = previousWorkspaceEnv;
  }
  rmSync(tmpWorkspace, { recursive: true, force: true });
});

// Import after the env var is set so getWorkspaceDir() resolves to the tmpdir.
const { rememberTool } = await import("./register.js");

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDir: tmpWorkspace,
    conversationId: "test-conversation",
    trustClass: "guardian",
    ...overrides,
  };
}

describe("rememberTool.execute — finish_turn", () => {
  test("omits yieldToUser when finish_turn is not provided", async () => {
    const result = await rememberTool.execute(
      { content: "no finish_turn provided" },
      makeContext(),
    );
    expect(result.isError).toBe(false);
    expect(result.yieldToUser).toBeUndefined();
  });

  test("omits yieldToUser when finish_turn is false", async () => {
    const result = await rememberTool.execute(
      { content: "finish_turn=false", finish_turn: false },
      makeContext(),
    );
    expect(result.isError).toBe(false);
    expect(result.yieldToUser).toBeUndefined();
  });

  test("sets yieldToUser=true when finish_turn is true", async () => {
    const result = await rememberTool.execute(
      { content: "finish_turn=true", finish_turn: true },
      makeContext(),
    );
    expect(result.isError).toBe(false);
    expect(result.yieldToUser).toBe(true);
  });

  test("sets yieldToUser=true even when the write fails (empty content)", async () => {
    const result = await rememberTool.execute(
      { content: "", finish_turn: true },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.yieldToUser).toBe(true);
  });
});

describe("rememberTool.execute — PKB re-index enqueue", () => {
  beforeEach(() => {
    enqueueCalls.length = 0;
    enqueueShouldThrow = false;
  });

  test("enqueues re-index jobs for both buffer and daily archive paths", async () => {
    const result = await rememberTool.execute(
      { content: "index me please" },
      makeContext({ memoryScopeId: "scope-enqueue" }),
    );
    expect(result.isError).toBe(false);

    const pkbRoot = join(tmpWorkspace, "pkb");
    const bufferPath = join(pkbRoot, "buffer.md");

    // Archive path is dated; derive from today's date the same way
    // handleRemember does.
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const archivePath = join(pkbRoot, "archive", `${yyyy}-${mm}-${dd}.md`);

    expect(enqueueCalls).toHaveLength(2);
    expect(enqueueCalls[0]).toEqual({
      pkbRoot,
      absPath: bufferPath,
      memoryScopeId: "scope-enqueue",
    });
    expect(enqueueCalls[1]).toEqual({
      pkbRoot,
      absPath: archivePath,
      memoryScopeId: "scope-enqueue",
    });
  });

  test("does not enqueue when content is empty (write was skipped)", async () => {
    const result = await rememberTool.execute(
      { content: "   " },
      makeContext({ memoryScopeId: "scope-empty" }),
    );
    expect(result.isError).toBe(true);
    expect(enqueueCalls).toHaveLength(0);
  });

  test("thrown enqueue does not surface; remember still writes files", async () => {
    enqueueShouldThrow = true;

    const result = await rememberTool.execute(
      { content: "enqueue will throw" },
      makeContext({ memoryScopeId: "scope-throw" }),
    );

    // Remember call succeeded despite enqueue throwing for each write.
    expect(result.isError).toBe(false);

    // Both writes attempted their enqueue.
    expect(enqueueCalls).toHaveLength(2);

    // Files were written correctly.
    const pkbRoot = join(tmpWorkspace, "pkb");
    const bufferPath = join(pkbRoot, "buffer.md");
    const bufferContents = readFileSync(bufferPath, "utf-8");
    expect(bufferContents).toContain("enqueue will throw");

    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const archivePath = join(pkbRoot, "archive", `${yyyy}-${mm}-${dd}.md`);
    const archiveContents = readFileSync(archivePath, "utf-8");
    expect(archiveContents).toContain("enqueue will throw");
  });
});
