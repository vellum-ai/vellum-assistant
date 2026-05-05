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

// Mirror read/write/edit test files: stub the event hub so the multi-client
// guard at line ~100 of transfer.ts is exercised against an isolated stub
// rather than the live process-wide singleton.
mock.module("../../runtime/assistant-event-hub.js", () => ({
  assistantEventHub: {
    listClientsByCapability: () => [],
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

function makeContext(
  workingDir: string,
  transportInterface?: ToolContext["transportInterface"],
): ToolContext {
  return {
    workingDir,
    conversationId: "test-conv",
    trustClass: "guardian",
    transportInterface,
  };
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

// ---------------------------------------------------------------------------
// Cross-client guard tests
// ---------------------------------------------------------------------------

describe("host_file_transfer cross-client guards", () => {
  test("returns 'no client' error on web transport when proxy unavailable and no targetClientId", async () => {
    // mockProxyAvailable defaults to false.
    const workingDir = makeTempDir();
    const srcDir = makeTempDir();
    const srcFile = join(srcDir, "source.txt");
    writeFileSync(srcFile, "content");

    const result = await hostFileTransferTool.execute(
      {
        source_path: srcFile,
        dest_path: "out.txt",
        direction: "to_sandbox",
      },
      makeContext(workingDir, "web"),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "no client with host_file capability is connected",
    );
    expect(toSandboxCalls.length).toBe(0);
  });

  test("returns 'specified client disconnected' error when targetClientId set but proxy unavailable on web", async () => {
    const workingDir = makeTempDir();
    const srcDir = makeTempDir();
    const srcFile = join(srcDir, "source.txt");
    writeFileSync(srcFile, "content");

    const result = await hostFileTransferTool.execute(
      {
        source_path: srcFile,
        dest_path: "out.txt",
        direction: "to_sandbox",
        target_client_id: "abc-123",
      },
      makeContext(workingDir, "web"),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      'target client "abc-123" is no longer connected',
    );
    expect(toSandboxCalls.length).toBe(0);
  });

  test("rejects when target_client_id is set but transport metadata is missing (legacy/backwards-compat path)", async () => {
    const workingDir = makeTempDir();
    const srcDir = makeTempDir();
    const srcFile = join(srcDir, "source.txt");
    writeFileSync(srcFile, "content");
    const destFile = join(workingDir, "should-not-exist.txt");

    const result = await hostFileTransferTool.execute(
      {
        source_path: srcFile,
        dest_path: destFile,
        direction: "to_sandbox",
        target_client_id: "abc-123",
      },
      // transportInterface intentionally omitted (legacy callers).
      makeContext(workingDir),
    );

    // Without transport metadata, falling through to executeLocal would
    // silently target the daemon container. The guard fires for undefined
    // transport AND non-host-proxy transports — only macos turns skip it.
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      'target client "abc-123" is no longer connected',
    );
    expect(existsSync(destFile)).toBe(false);
    expect(toSandboxCalls.length).toBe(0);
  });

  test("does NOT reject on macos transport with a stale target_client_id when proxy unavailable (regression: Devin-flagged scope drift fix)", async () => {
    const workingDir = makeTempDir();
    const srcDir = makeTempDir();
    const srcFile = join(srcDir, "source.txt");
    writeFileSync(srcFile, "content");
    const destFile = join(workingDir, "stale-target.txt");

    const result = await hostFileTransferTool.execute(
      {
        source_path: srcFile,
        dest_path: destFile,
        direction: "to_sandbox",
        target_client_id: "stale-mac",
      },
      makeContext(workingDir, "macos"),
    );

    // The disconnected-target guard is scoped to non-host-proxy transports
    // (!supportsHostProxy). On macos, a stale target_client_id auto-filled
    // from a prior cross-client turn must be silently ignored and the local
    // copy must succeed, NOT reject with "target client ... is no longer
    // connected" or the older "target_client_id was specified but no host
    // client is available" message.
    expect(result.isError).toBe(false);
    expect(existsSync(destFile)).toBe(true);
  });
});
