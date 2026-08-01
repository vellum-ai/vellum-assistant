import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeIpcEndpointFile, resolveIpcEndpoint } from "./endpoint.js";
const windowsEndpoint = (name: string, workspaceDir: string) => resolveIpcEndpoint(name, { workspaceDir, platform: "win32" });
describe("resolveIpcEndpoint", () => {
  test("keeps long POSIX fallbacks deterministic and bounded", () => {
    const options = {
      workspaceDir: `/tmp/${"a".repeat(120)}`,
      platform: "darwin" as const,
    };
    const endpoint = resolveIpcEndpoint("assistant", options);
    expect(resolveIpcEndpoint("assistant", options)).toEqual(endpoint);
    expect(Buffer.byteLength(endpoint.path)).toBeLessThanOrEqual(103);
  });
  test("returns normalized, isolated, bounded Windows pipes", () => {
    const first = windowsEndpoint("assistant", "C:\\one");
    expect(resolveIpcEndpoint("assistant", { workspaceDir: "c:\\ONE\\", platform: "win32", env: { ASSISTANT_IPC_SOCKET_DIR: "C:\\ignored" } })).toEqual(first);
    expect(first.path.length).toBeLessThanOrEqual(256);
    expect(windowsEndpoint("assistant", "C:\\two").path).not.toBe(first.path);
    expect(windowsEndpoint("gateway", "C:\\one").path).not.toBe(first.path);
  });
  test("cleans socket files but skips named pipes", () => {
    const dir = mkdtempSync(join(tmpdir(), "vellum-ipc-cleanup-"));
    const socketPath = join(dir, "assistant.sock");
    try {
      writeFileSync(socketPath, "stale");
      removeIpcEndpointFile(socketPath);
      expect(existsSync(socketPath)).toBe(false);
      removeIpcEndpointFile("\\\\.\\pipe\\vellum-assistant-test");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
