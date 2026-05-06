/**
 * Tests for `handleRemember` routing between v1 (PKB) and v2 (memory/).
 *
 * Routing follows `config.memory.v2.enabled`: when true, writes go to
 * memory/; otherwise they fall back to v1 PKB.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

let tmpWorkspace: string;
let previousWorkspaceEnv: string | undefined;

// Shared mock state for the PKB enqueue helper. Module-scoped so the
// hoisted mock.module factory can close over it.
const enqueueCalls: Array<{
  pkbRoot: string;
  absPath: string;
  memoryScopeId: string;
}> = [];

mock.module("../../jobs/embed-pkb-file.js", () => ({
  enqueuePkbIndexJob: (input: {
    pkbRoot: string;
    absPath: string;
    memoryScopeId: string;
  }) => {
    enqueueCalls.push(input);
    return "job-mock-id";
  },
}));

beforeAll(() => {
  tmpWorkspace = mkdtempSync(join(tmpdir(), "handle-remember-v2-test-"));
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

// Imports are deferred to after the env var is set so any internal use of
// `getWorkspaceDir()` resolves to the tmpdir.
const { handleRemember } = await import("../tool-handlers.js");
const { applyNestedDefaults } = await import("../../../config/loader.js");

const CONFIG = applyNestedDefaults({});
const CONFIG_V2_OFF = {
  ...CONFIG,
  memory: { ...CONFIG.memory, v2: { ...CONFIG.memory.v2, enabled: false } },
};

beforeEach(() => {
  enqueueCalls.length = 0;
  // Reset to a clean workspace for each test so file existence assertions
  // don't depend on prior-test side effects.
  rmSync(join(tmpWorkspace, "pkb"), { recursive: true, force: true });
  rmSync(join(tmpWorkspace, "memory"), { recursive: true, force: true });
});

function todaysArchiveBasename(now: Date = new Date()): string {
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}.md`;
}

describe("handleRemember — memory.v2.enabled on", () => {
  test("writes to memory/buffer.md and memory/archive/<today>.md", () => {
    const result = handleRemember(
      { content: "Alice prefers VS Code over Vim" },
      "conv-test-1",
      "default",
      CONFIG,
    );

    expect(result.success).toBe(true);

    const memoryDir = join(tmpWorkspace, "memory");
    const bufferPath = join(memoryDir, "buffer.md");
    const archivePath = join(memoryDir, "archive", todaysArchiveBasename());

    const buffer = readFileSync(bufferPath, "utf-8");
    expect(buffer).toContain("Alice prefers VS Code over Vim");

    const archive = readFileSync(archivePath, "utf-8");
    expect(archive).toContain("Alice prefers VS Code over Vim");

    // v2 must NOT touch the PKB tree.
    expect(existsSync(join(tmpWorkspace, "pkb"))).toBe(false);
  });

  test("does not enqueue any PKB re-index jobs", () => {
    const result = handleRemember(
      { content: "Bob lives in Austin" },
      "conv-test-2",
      "default",
      CONFIG,
    );

    expect(result.success).toBe(true);
    expect(enqueueCalls).toEqual([]);
  });

  test("seeds the daily archive header on first write", () => {
    handleRemember(
      { content: "First entry of the day" },
      "conv-test-3",
      "default",
      CONFIG,
    );

    const archivePath = join(
      tmpWorkspace,
      "memory",
      "archive",
      todaysArchiveBasename(),
    );
    const archive = readFileSync(archivePath, "utf-8");
    // Header is "# <Mon> <D>, <YYYY>" — assert just the prefix to avoid
    // hard-coding the locale-formatted month name in the test.
    expect(archive.startsWith("# ")).toBe(true);
    expect(archive).toContain("First entry of the day");
  });

  test("appends multiple entries to the same buffer", () => {
    handleRemember({ content: "first" }, "c", "default", CONFIG);
    handleRemember({ content: "second" }, "c", "default", CONFIG);

    const buffer = readFileSync(
      join(tmpWorkspace, "memory", "buffer.md"),
      "utf-8",
    );
    expect(buffer).toContain("first");
    expect(buffer).toContain("second");
  });

  test("rejects empty content without writing", () => {
    const result = handleRemember(
      { content: "   " },
      "conv-test-4",
      "default",
      CONFIG,
    );

    expect(result.success).toBe(false);
    expect(existsSync(join(tmpWorkspace, "memory", "buffer.md"))).toBe(false);
    expect(enqueueCalls).toEqual([]);
  });
});

describe("handleRemember — memory.v2.enabled off (v1 PKB path)", () => {
  test("writes to pkb/buffer.md and pkb/archive/<today>.md", () => {
    const result = handleRemember(
      { content: "v1 path still works" },
      "conv-v1-1",
      "default",
      CONFIG_V2_OFF,
    );

    expect(result.success).toBe(true);

    const pkbDir = join(tmpWorkspace, "pkb");
    const bufferPath = join(pkbDir, "buffer.md");
    const archivePath = join(pkbDir, "archive", todaysArchiveBasename());

    expect(readFileSync(bufferPath, "utf-8")).toContain("v1 path still works");
    expect(readFileSync(archivePath, "utf-8")).toContain("v1 path still works");

    // v1 must NOT touch the v2 memory/ tree.
    expect(existsSync(join(tmpWorkspace, "memory"))).toBe(false);
  });

  test("enqueues PKB re-index jobs for both buffer and archive", () => {
    const result = handleRemember(
      { content: "index me" },
      "conv-v1-2",
      "default",
      CONFIG_V2_OFF,
    );

    expect(result.success).toBe(true);

    const pkbDir = join(tmpWorkspace, "pkb");
    const bufferPath = join(pkbDir, "buffer.md");
    const archivePath = join(pkbDir, "archive", todaysArchiveBasename());

    expect(enqueueCalls).toHaveLength(2);
    expect(enqueueCalls[0]?.absPath).toBe(bufferPath);
    expect(enqueueCalls[1]?.absPath).toBe(archivePath);
    for (const call of enqueueCalls) {
      expect(call.pkbRoot).toBe(pkbDir);
    }
  });
});
