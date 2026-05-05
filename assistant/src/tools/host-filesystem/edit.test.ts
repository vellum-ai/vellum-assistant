import { mkdtempSync, realpathSync, rmSync } from "node:fs";
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

const { hostFileEditTool } = await import("./edit.js");

const testDirs: string[] = [];

afterEach(() => {
  mockProxyAvailable = false;
  for (const dir of testDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "host-edit-test-")));
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

describe("host_file_edit cross-client guards", () => {
  test("returns 'no client' error on web transport when proxy unavailable and no targetClientId", async () => {
    const workingDir = makeTempDir();
    const result = await hostFileEditTool.execute(
      {
        path: "/some/host/path.txt",
        old_string: "foo",
        new_string: "bar",
      },
      makeContext(workingDir, "web"),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "no client with host_file capability is connected",
    );
  });

  test("returns 'specified client disconnected' error when targetClientId set but proxy unavailable on web", async () => {
    const workingDir = makeTempDir();
    const result = await hostFileEditTool.execute(
      {
        path: "/some/host/path.txt",
        old_string: "foo",
        new_string: "bar",
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
    const result = await hostFileEditTool.execute(
      {
        path: "/nonexistent/x.txt",
        old_string: "foo",
        new_string: "bar",
      },
      makeContext(workingDir, "macos"),
    );
    // Proves the guard did NOT fire on macOS — instead we got the
    // local FileSystemOps error path (file not found / IO error).
    expect(result.isError).toBe(true);
    expect(result.content.toLowerCase()).toMatch(/not found|enoent|editing/);
  });

  test("does NOT reject on macos transport with a stale target_client_id when proxy unavailable (regression: P2 fix)", async () => {
    const workingDir = makeTempDir();
    const result = await hostFileEditTool.execute(
      {
        path: "/nonexistent/x.txt",
        old_string: "foo",
        new_string: "bar",
        target_client_id: "stale-mac",
      },
      makeContext(workingDir, "macos"),
    );
    // The disconnected-target guard is scoped to non-host-proxy transports
    // (!supportsHostProxy). On macos, a stale target_client_id auto-filled
    // from a prior cross-client turn must be silently ignored and the call
    // must fall through to local FileSystemOps, NOT reject with "target
    // client ... is no longer connected".
    expect(result.isError).toBe(true);
    expect(result.content).not.toContain("is no longer connected");
    expect(result.content.toLowerCase()).toMatch(/not found|enoent|editing/);
  });

  test("rejects when target_client_id is set but transport metadata is missing (legacy/backwards-compat path)", async () => {
    const workingDir = makeTempDir();
    const result = await hostFileEditTool.execute(
      {
        path: "/some/host/path.txt",
        old_string: "foo",
        new_string: "bar",
        target_client_id: "abc-123",
      },
      // transportInterface intentionally undefined (legacy callers).
      makeContext(workingDir, undefined),
    );
    // Without transport metadata, falling through to local fs would
    // silently target the daemon container. The guard fires for undefined
    // transport AND non-host-proxy transports — only macos turns skip it.
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      'target client "abc-123" is no longer connected',
    );
  });
});
