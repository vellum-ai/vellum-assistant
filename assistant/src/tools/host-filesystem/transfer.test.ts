import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, mock, test } from "bun:test";

import type { ToolContext } from "../types.js";

// ---------------------------------------------------------------------------
// Singleton mock — must precede the tool import so bun's module mock applies.
// ---------------------------------------------------------------------------

let mockProxyAvailable = false;
const toSandboxCalls: Array<{ sourcePath: string; destPath: string }> = [];
const toHostCalls: Array<{ sourcePath: string; destPath: string }> = [];

mock.module("../../daemon/host-transfer-proxy.js", () => ({
  HostTransferProxy: {
    get instance() {
      return {
        isAvailable: () => mockProxyAvailable,
        requestToSandbox: (args: { sourcePath: string; destPath: string; overwrite?: boolean; conversationId: string }) => {
          toSandboxCalls.push({ sourcePath: args.sourcePath, destPath: args.destPath });
          return Promise.resolve({ content: "ok", isError: false });
        },
        requestToHost: (args: { sourcePath: string; destPath: string; overwrite: boolean; conversationId: string }) => {
          toHostCalls.push({ sourcePath: args.sourcePath, destPath: args.destPath });
          return Promise.resolve({ content: "ok", isError: false });
        },
      };
    },
  },
}));

const { hostFileTransferTool } = await import("./transfer.js");

const testDirs: string[] = [];

afterEach(() => {
  mockProxyAvailable = false;
  toSandboxCalls.length = 0;
  toHostCalls.length = 0;
  for (const dir of testDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "xfer-test-")));
  testDirs.push(dir);
  return dir;
}

function makeContext(workingDir: string): ToolContext {
  return { workingDir, conversationId: "test-conv", trustClass: "guardian" };
}

// ---------------------------------------------------------------------------
// Local-mode tests (proxy unavailable — falls back to local copy)
// ---------------------------------------------------------------------------

describe("host_file_transfer local mode", () => {
  test("relative path resolves to workingDir", async () => {
    const workingDir = makeTempDir();
    const srcDir = makeTempDir();
    const srcFile = join(srcDir, "source.md");
    writeFileSync(srcFile, "hello world");

    const result = await hostFileTransferTool.execute(
      {
        source_path: srcFile,
        dest_path: "scratch/out.md",
        direction: "to_sandbox",
      },
      makeContext(workingDir),
    );

    expect(result.isError).toBe(false);
    const expectedDest = join(workingDir, "scratch", "out.md");
    expect(existsSync(expectedDest)).toBe(true);
  });

  test("absolute in-bounds path succeeds", async () => {
    const workingDir = makeTempDir();
    const srcDir = makeTempDir();
    const srcFile = join(srcDir, "source.txt");
    writeFileSync(srcFile, "content");

    const destFile = join(workingDir, "out.md");

    const result = await hostFileTransferTool.execute(
      {
        source_path: srcFile,
        dest_path: destFile,
        direction: "to_sandbox",
      },
      makeContext(workingDir),
    );

    expect(result.isError).toBe(false);
    expect(existsSync(destFile)).toBe(true);
  });

  test("out-of-bounds path is rejected", async () => {
    const workingDir = makeTempDir();
    const srcDir = makeTempDir();
    const srcFile = join(srcDir, "source.txt");
    writeFileSync(srcFile, "content");

    const result = await hostFileTransferTool.execute(
      {
        source_path: srcFile,
        dest_path: "../../etc/shadow",
        direction: "to_sandbox",
      },
      makeContext(workingDir),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Invalid destination path");
  });

  test("/workspace remap: dest_path /workspace/out.md maps to workingDir when workingDir is not /workspace", async () => {
    const workingDir = makeTempDir();
    // workingDir is a temp dir, not under /workspace, so remapping should occur
    const srcDir = makeTempDir();
    const srcFile = join(srcDir, "source.txt");
    writeFileSync(srcFile, "content");

    const result = await hostFileTransferTool.execute(
      {
        source_path: srcFile,
        dest_path: "/workspace/out.md",
        direction: "to_sandbox",
      },
      makeContext(workingDir),
    );

    expect(result.isError).toBe(false);
    const expectedDest = join(workingDir, "out.md");
    expect(existsSync(expectedDest)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Local-mode to_host tests (source normalization)
// ---------------------------------------------------------------------------

describe("host_file_transfer local mode to_host", () => {
  test("relative source_path resolves to workingDir", async () => {
    const workingDir = makeTempDir();
    const srcFile = join(workingDir, "report.pdf");
    writeFileSync(srcFile, "pdf content");
    const destDir = makeTempDir();
    const destFile = join(destDir, "report.pdf");

    const result = await hostFileTransferTool.execute(
      {
        source_path: "report.pdf",
        dest_path: destFile,
        direction: "to_host",
      },
      makeContext(workingDir),
    );

    expect(result.isError).toBe(false);
    expect(existsSync(destFile)).toBe(true);
  });

  test("out-of-bounds source_path is rejected", async () => {
    const workingDir = makeTempDir();
    const destDir = makeTempDir();
    const destFile = join(destDir, "out.txt");

    const result = await hostFileTransferTool.execute(
      {
        source_path: "../../etc/passwd",
        dest_path: destFile,
        direction: "to_host",
      },
      makeContext(workingDir),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Invalid source path");
    expect(existsSync(destFile)).toBe(false);
  });

  test("/workspace remap: source_path /workspace/data.txt maps to workingDir", async () => {
    const workingDir = makeTempDir();
    writeFileSync(join(workingDir, "data.txt"), "some data");
    const destDir = makeTempDir();
    const destFile = join(destDir, "data.txt");

    const result = await hostFileTransferTool.execute(
      {
        source_path: "/workspace/data.txt",
        dest_path: destFile,
        direction: "to_host",
      },
      makeContext(workingDir),
    );

    expect(result.isError).toBe(false);
    expect(existsSync(destFile)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Managed-mode tests (singleton proxy available)
// ---------------------------------------------------------------------------

describe("host_file_transfer managed mode", () => {
  test("relative path is pre-resolved before proxy call", async () => {
    mockProxyAvailable = true;
    const workingDir = makeTempDir();
    const srcDir = makeTempDir();
    const srcFile = join(srcDir, "source.txt");
    writeFileSync(srcFile, "content");

    await hostFileTransferTool.execute(
      {
        source_path: srcFile,
        dest_path: "relative/file.txt",
        direction: "to_sandbox",
      },
      makeContext(workingDir),
    );

    expect(toSandboxCalls.length).toBe(1);
    expect(toSandboxCalls[0].destPath).toBe(join(workingDir, "relative", "file.txt"));
  });

  test("to_host relative source is pre-resolved before proxy call", async () => {
    mockProxyAvailable = true;
    const workingDir = makeTempDir();
    writeFileSync(join(workingDir, "doc.md"), "content");

    await hostFileTransferTool.execute(
      {
        source_path: "doc.md",
        dest_path: "/Users/someone/Desktop/doc.md",
        direction: "to_host",
      },
      makeContext(workingDir),
    );

    expect(toHostCalls.length).toBe(1);
    expect(toHostCalls[0].sourcePath).toBe(join(workingDir, "doc.md"));
  });

  test("out-of-bounds path rejected before proxy call", async () => {
    mockProxyAvailable = true;
    const workingDir = makeTempDir();
    const srcDir = makeTempDir();
    const srcFile = join(srcDir, "source.txt");
    writeFileSync(srcFile, "content");

    const result = await hostFileTransferTool.execute(
      {
        source_path: srcFile,
        dest_path: "/etc/passwd",
        direction: "to_sandbox",
      },
      makeContext(workingDir),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Invalid destination path");
    expect(toSandboxCalls.length).toBe(0);
  });
});
