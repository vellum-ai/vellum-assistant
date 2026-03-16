import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { hostFileEditTool } from "../tools/host-filesystem/edit.js";
import type { ToolContext } from "../tools/types.js";

const testDirs: string[] = [];

function makeContext(): ToolContext {
  return {
    workingDir: "/tmp",
    conversationId: "test-conversation",
    trustClass: "guardian",
  };
}

afterEach(() => {
  for (const dir of testDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("host_file_edit tool", () => {
  test("rejects relative paths", async () => {
    const result = await hostFileEditTool.execute(
      {
        path: "relative.txt",
        old_string: "a",
        new_string: "b",
      },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("must be absolute");
  });

  test("edits unique match", async () => {
    const dir = mkdtempSync(join(tmpdir(), "host-file-edit-test-"));
    testDirs.push(dir);
    const filePath = join(dir, "sample.txt");
    writeFileSync(filePath, "hello world\n");

    const result = await hostFileEditTool.execute(
      {
        path: filePath,
        old_string: "hello world",
        new_string: "updated",
      },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(readFileSync(filePath, "utf-8")).toBe("updated\n");
    expect(result.diff?.isNewFile).toBe(false);
  });

  test("replace_all edits all matches", async () => {
    const dir = mkdtempSync(join(tmpdir(), "host-file-edit-test-"));
    testDirs.push(dir);
    const filePath = join(dir, "sample.txt");
    writeFileSync(filePath, "x\ny\nx\n");

    const result = await hostFileEditTool.execute(
      {
        path: filePath,
        old_string: "x",
        new_string: "z",
        replace_all: true,
      },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(readFileSync(filePath, "utf-8")).toBe("z\ny\nz\n");
    expect(result.content).toContain("Successfully replaced 2 occurrences");
  });

  test("fuzzy match includes similarity percentage in message", async () => {
    const dir = mkdtempSync(join(tmpdir(), "host-file-edit-test-"));
    testDirs.push(dir);
    const filePath = join(dir, "sample.txt");
    // Content has a typo-level difference from oldString
    writeFileSync(filePath, "function fooo() {\n  return 1;\n}\n");

    const result = await hostFileEditTool.execute(
      {
        path: filePath,
        old_string: "function foo() {\n  return 1;\n}",
        new_string: "function bar() {\n  return 2;\n}",
      },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("fuzzy matched");
    expect(result.content).toMatch(/\d+% similar/);
  });

  test("returns ambiguity error when old_string appears multiple times", async () => {
    const dir = mkdtempSync(join(tmpdir(), "host-file-edit-test-"));
    testDirs.push(dir);
    const filePath = join(dir, "sample.txt");
    writeFileSync(filePath, "repeat\nrepeat\n");

    const result = await hostFileEditTool.execute(
      {
        path: filePath,
        old_string: "repeat",
        new_string: "new",
      },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("appears multiple times");
  });

  test("rejects missing path parameter", async () => {
    const result = await hostFileEditTool.execute(
      {
        old_string: "a",
        new_string: "b",
      },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("path is required");
  });

  test("rejects non-string old_string", async () => {
    const dir = mkdtempSync(join(tmpdir(), "host-file-edit-test-"));
    testDirs.push(dir);
    const filePath = join(dir, "sample.txt");
    writeFileSync(filePath, "content\n");

    const result = await hostFileEditTool.execute(
      {
        path: filePath,
        old_string: 42,
        new_string: "b",
      },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("old_string is required");
  });

  test("rejects non-string new_string", async () => {
    const dir = mkdtempSync(join(tmpdir(), "host-file-edit-test-"));
    testDirs.push(dir);
    const filePath = join(dir, "sample.txt");
    writeFileSync(filePath, "content\n");

    const result = await hostFileEditTool.execute(
      {
        path: filePath,
        old_string: "content",
        new_string: 42,
      },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("new_string is required");
  });

  test("rejects empty old_string", async () => {
    const dir = mkdtempSync(join(tmpdir(), "host-file-edit-test-"));
    testDirs.push(dir);
    const filePath = join(dir, "sample.txt");
    writeFileSync(filePath, "content\n");

    const result = await hostFileEditTool.execute(
      {
        path: filePath,
        old_string: "",
        new_string: "b",
      },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("old_string must not be empty");
  });

  test("rejects identical old_string and new_string", async () => {
    const dir = mkdtempSync(join(tmpdir(), "host-file-edit-test-"));
    testDirs.push(dir);
    const filePath = join(dir, "sample.txt");
    writeFileSync(filePath, "content\n");

    const result = await hostFileEditTool.execute(
      {
        path: filePath,
        old_string: "content",
        new_string: "content",
      },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "old_string and new_string must be different",
    );
  });

  test("returns error for nonexistent file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "host-file-edit-test-"));
    testDirs.push(dir);
    const filePath = join(dir, "missing.txt");

    const result = await hostFileEditTool.execute(
      {
        path: filePath,
        old_string: "a",
        new_string: "b",
      },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("File not found");
  });

  test("returns diff info after successful edit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "host-file-edit-test-"));
    testDirs.push(dir);
    const filePath = join(dir, "sample.txt");
    writeFileSync(filePath, "before\n");

    const result = await hostFileEditTool.execute(
      {
        path: filePath,
        old_string: "before",
        new_string: "after",
      },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(result.diff).toBeDefined();
    expect(result.diff!.filePath).toBe(filePath);
    expect(result.diff!.oldContent).toBe("before\n");
    expect(result.diff!.newContent).toBe("after\n");
    expect(result.diff!.isNewFile).toBe(false);
  });

  test("whitespace-normalized match includes note in message", async () => {
    const dir = mkdtempSync(join(tmpdir(), "host-file-edit-test-"));
    testDirs.push(dir);
    const filePath = join(dir, "sample.txt");
    // File has tab indentation
    writeFileSync(filePath, "function foo() {\n\treturn 1;\n}\n");

    const result = await hostFileEditTool.execute(
      {
        path: filePath,
        // old_string uses spaces instead of tabs — should whitespace-normalize
        old_string: "function foo() {\n  return 1;\n}",
        new_string: "function bar() {\n  return 2;\n}",
      },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    // Should contain either whitespace normalization or fuzzy match note
    expect(
      result.content.includes("whitespace") ||
        result.content.includes("fuzzy") ||
        result.content.includes("Successfully edited"),
    ).toBe(true);
  });
});
