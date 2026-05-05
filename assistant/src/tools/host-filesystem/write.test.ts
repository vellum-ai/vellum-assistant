import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, mock, test } from "bun:test";

import type { ToolContext } from "../types.js";

// ---------------------------------------------------------------------------
// Singleton mocks — must precede the tool import so bun's module mock applies.
// ---------------------------------------------------------------------------

let mockProxyAvailable = false;

mock.module("../../daemon/host-file-proxy.js", () => ({
  HostFileProxy: {
    get instance() {
      return {
        isAvailable: () => mockProxyAvailable,
        request: () => Promise.resolve({ content: "ok", isError: false }),
      };
    },
  },
}));

mock.module("../../runtime/assistant-event-hub.js", () => ({
  assistantEventHub: {
    listClientsByCapability: () => [],
  },
}));

const { hostFileWriteTool } = await import("./write.js");

const testDirs: string[] = [];

afterEach(() => {
  mockProxyAvailable = false;
  for (const dir of testDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "host-write-test-")));
  testDirs.push(dir);
  return dir;
}

function makeContext(
  workingDir: string,
  transportInterface: ToolContext["transportInterface"],
): ToolContext {
  return {
    workingDir,
    conversationId: "test-conv",
    trustClass: "guardian",
    transportInterface,
  };
}

describe("host_file_write cross-client guards", () => {
  test("returns 'no client' error on web transport when proxy unavailable and no targetClientId", async () => {
    const workingDir = makeTempDir();
    const result = await hostFileWriteTool.execute(
      { path: "/some/host/path.txt", content: "hello" },
      makeContext(workingDir, "web"),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "no client with host_file capability is connected",
    );
  });

  test("returns 'specified client disconnected' error when targetClientId set but proxy unavailable on web", async () => {
    const workingDir = makeTempDir();
    const result = await hostFileWriteTool.execute(
      {
        path: "/some/host/path.txt",
        content: "hello",
        target_client_id: "abc-123",
      },
      makeContext(workingDir, "web"),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      'target client "abc-123" is no longer connected',
    );
  });

  test("falls through to local fs on macos transport when proxy unavailable", async () => {
    const workingDir = makeTempDir();
    const destFile = join(workingDir, "out.txt");
    const result = await hostFileWriteTool.execute(
      { path: destFile, content: "hello" },
      makeContext(workingDir, "macos"),
    );
    // Proves the guard did NOT fire on macOS — local write succeeded.
    expect(result.isError).toBe(false);
    expect(existsSync(destFile)).toBe(true);
  });
});
