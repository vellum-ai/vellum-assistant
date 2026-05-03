import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, mock, test } from "bun:test";

import type { HostFileInput } from "../daemon/host-file-proxy.js";
import type { ToolExecutionResult } from "../tools/types.js";

// Mock HostFileProxy singleton so proxy delegation tests can control it.
let mockFileProxyAvailable = false;
let mockFileProxyRequestFn: (
  input: HostFileInput,
  conversationId: string,
  signal?: AbortSignal,
) => Promise<ToolExecutionResult> = () => Promise.resolve({ content: "", isError: false });

mock.module("../daemon/host-file-proxy.js", () => ({
  HostFileProxy: {
    get instance() {
      return {
        isAvailable: () => mockFileProxyAvailable,
        request: mockFileProxyRequestFn,
      };
    },
  },
}));

import { hostFileWriteTool } from "../tools/host-filesystem/write.js";
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
  mockFileProxyAvailable = false;
  mockFileProxyRequestFn = () => Promise.resolve({ content: "", isError: false });
});

describe("host_file_write tool", () => {
  test("rejects relative paths", async () => {
    const result = await hostFileWriteTool.execute(
      { path: "relative.txt", content: "hi" },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("must be absolute");
  });

  test("rejects non-string content", async () => {
    const dir = mkdtempSync(join(tmpdir(), "host-file-write-test-"));
    testDirs.push(dir);
    const filePath = join(dir, "out.txt");

    const result = await hostFileWriteTool.execute(
      { path: filePath, content: 42 },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "content is required and must be a string",
    );
  });

  test("writes new file and returns diff", async () => {
    const dir = mkdtempSync(join(tmpdir(), "host-file-write-test-"));
    testDirs.push(dir);
    const filePath = join(dir, "nested", "new.txt");

    const result = await hostFileWriteTool.execute(
      { path: filePath, content: "new content" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, "utf-8")).toBe("new content");
    expect(result.diff).toEqual({
      filePath,
      oldContent: "",
      newContent: "new content",
      isNewFile: true,
    });
  });

  test("overwrites existing file and returns previous content in diff", async () => {
    const dir = mkdtempSync(join(tmpdir(), "host-file-write-test-"));
    testDirs.push(dir);
    const filePath = join(dir, "existing.txt");

    await hostFileWriteTool.execute(
      { path: filePath, content: "old" },
      makeContext(),
    );
    const result = await hostFileWriteTool.execute(
      { path: filePath, content: "updated" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(readFileSync(filePath, "utf-8")).toBe("updated");
    expect(result.diff).toEqual({
      filePath,
      oldContent: "old",
      newContent: "updated",
      isNewFile: false,
    });
  });

  test("rejects missing path parameter", async () => {
    const result = await hostFileWriteTool.execute(
      { content: "data" },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("path is required");
  });

  test("rejects non-string path", async () => {
    const result = await hostFileWriteTool.execute(
      { path: 123, content: "data" },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("path is required and must be a string");
  });

  test("success message contains the file path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "host-file-write-test-"));
    testDirs.push(dir);
    const filePath = join(dir, "msg-check.txt");

    const result = await hostFileWriteTool.execute(
      { path: filePath, content: "check" },
      makeContext(),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain(`Successfully wrote to ${filePath}`);
  });

  test("new file message includes line count", async () => {
    const dir = mkdtempSync(join(tmpdir(), "host-file-write-test-"));
    testDirs.push(dir);
    const filePath = join(dir, "lines.txt");

    const result = await hostFileWriteTool.execute(
      {
        path: filePath,
        content: "line1\nline2\nline3",
      },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("new file");
    expect(result.content).toContain("3 lines");
  });

  test("writes empty string content", async () => {
    const dir = mkdtempSync(join(tmpdir(), "host-file-write-test-"));
    testDirs.push(dir);
    const filePath = join(dir, "empty.txt");

    const result = await hostFileWriteTool.execute(
      { path: filePath, content: "" },
      makeContext(),
    );
    expect(result.isError).toBe(false);
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, "utf-8")).toBe("");
  });

  test("creates nested parent directories", async () => {
    const dir = mkdtempSync(join(tmpdir(), "host-file-write-test-"));
    testDirs.push(dir);
    const filePath = join(dir, "a", "b", "c", "deep.txt");

    const result = await hostFileWriteTool.execute(
      { path: filePath, content: "deep" },
      makeContext(),
    );
    expect(result.isError).toBe(false);
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, "utf-8")).toBe("deep");
  });

  test("passes target_client_id to HostFileProxy.instance.request", async () => {
    const capturedInputs: HostFileInput[] = [];
    mockFileProxyAvailable = true;
    mockFileProxyRequestFn = async (input) => {
      capturedInputs.push(input);
      return { content: "proxied write", isError: false };
    };

    await hostFileWriteTool.execute(
      { path: "/host/output.txt", content: "hello", target_client_id: "client-x" },
      makeContext(),
    );

    expect(capturedInputs).toHaveLength(1);
    expect(capturedInputs[0].targetClientId).toBe("client-x");
  });
});
