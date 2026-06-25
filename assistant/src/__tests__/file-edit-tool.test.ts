import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";

import { getTool } from "../tools/registry.js";
import type { Tool, ToolContext } from "../tools/types.js";

let fileEditTool: Tool;
const testDirs: string[] = [];

beforeAll(async () => {
  await import("../tools/filesystem/edit.js");
  fileEditTool = getTool("file_edit")!;
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

function makeTempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "file-edit-test-")));
  testDirs.push(dir);
  return dir;
}

describe("file_edit tool (sandbox)", () => {
  test("performs unique replacement", async () => {
    const dir = makeTempDir();
    const filePath = join(dir, "sample.txt");
    writeFileSync(filePath, "hello world\n");

    const result = await fileEditTool.execute(
      { path: "sample.txt", old_string: "hello world", new_string: "updated" },
      makeContext(dir),
    );

    expect(result.isError).toBe(false);
    expect(readFileSync(filePath, "utf-8")).toBe("updated\n");
    expect(result.diff?.isNewFile).toBe(false);
  });

  test("replace_all replaces all occurrences", async () => {
    const dir = makeTempDir();
    const filePath = join(dir, "sample.txt");
    writeFileSync(filePath, "x\ny\nx\n");

    const result = await fileEditTool.execute(
      {
        path: "sample.txt",
        old_string: "x",
        new_string: "z",
        replace_all: true,
      },
      makeContext(dir),
    );

    expect(result.isError).toBe(false);
    expect(readFileSync(filePath, "utf-8")).toBe("z\ny\nz\n");
    expect(result.content).toContain("Successfully replaced 2 occurrences");
  });

  test("returns ambiguity error when old_string appears multiple times", async () => {
    const dir = makeTempDir();
    const filePath = join(dir, "sample.txt");
    writeFileSync(filePath, "repeat\nrepeat\n");

    const result = await fileEditTool.execute(
      { path: "sample.txt", old_string: "repeat", new_string: "new" },
      makeContext(dir),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("appears multiple times");
  });

  test("fuzzy match includes similarity percentage in message", async () => {
    const dir = makeTempDir();
    const filePath = join(dir, "sample.txt");
    writeFileSync(filePath, "function fooo() {\n  return 1;\n}\n");

    const result = await fileEditTool.execute(
      {
        path: "sample.txt",
        old_string: "function foo() {\n  return 1;\n}",
        new_string: "function bar() {\n  return 2;\n}",
      },
      makeContext(dir),
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("fuzzy matched");
    expect(result.content).toMatch(/\d+% similar/);
  });

  test("returns error when old_string is not found", async () => {
    const dir = makeTempDir();
    const filePath = join(dir, "sample.txt");
    writeFileSync(filePath, "some content\n");

    const result = await fileEditTool.execute(
      {
        path: "sample.txt",
        old_string: "nonexistent",
        new_string: "replacement",
      },
      makeContext(dir),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("old_string not found");
  });

  test("blocks path traversal escape", async () => {
    const dir = makeTempDir();

    const result = await fileEditTool.execute(
      { path: "../../../etc/hosts", old_string: "a", new_string: "b" },
      makeContext(dir),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("outside the working directory");
  });
});
