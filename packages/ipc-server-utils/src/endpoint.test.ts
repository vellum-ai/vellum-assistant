import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isNamedPipePath,
  removeIpcEndpointFile,
  resolveIpcEndpoint,
  WINDOWS_NAMED_PIPE_MAX_PATH_CHARS,
} from "./endpoint.js";

function windowsEndpoint(
  socketName: string,
  workspaceDir: string,
  env: Record<string, string | undefined> = {},
) {
  return resolveIpcEndpoint(socketName, { workspaceDir, platform: "win32", env });
}

describe("resolveIpcEndpoint", () => {
  test("preserves POSIX workspace and override paths", () => {
    expect(
      resolveIpcEndpoint("gateway", {
        workspaceDir: "/var/lib/vellum/workspace",
        platform: "linux",
        env: {},
      }),
    ).toEqual({
      path: "/var/lib/vellum/workspace/gateway.sock",
      source: "workspace",
      kind: "unix-socket",
    });
    expect(
      resolveIpcEndpoint("gateway", {
        workspaceDir: "/ignored",
        platform: "darwin",
        env: { GATEWAY_IPC_SOCKET_DIR: "/run/gateway-ipc" },
      }),
    ).toEqual({
      path: "/run/gateway-ipc/gateway.sock",
      source: "env-override",
      kind: "unix-socket",
    });
  });

  test("preserves deterministic POSIX long-path fallbacks", () => {
    const options = {
      workspaceDir: `/tmp/${"a".repeat(120)}`,
      platform: "darwin" as const,
      env: {},
      tmpDir: "/tmp",
    };
    const first = resolveIpcEndpoint("assistant", options);
    const second = resolveIpcEndpoint("assistant", options);
    expect(first).toEqual(second);
    expect(["tmp-hash", "tmp-short-hash"]).toContain(first.source);
    expect(Buffer.byteLength(first.path, "utf8")).toBeLessThanOrEqual(103);
  });

  test("returns deterministic bounded Windows named pipes", () => {
    const workspace = `C:\\Users\\Example\\${"deep\\".repeat(100)}`;
    const first = windowsEndpoint("assistant", workspace);
    const second = windowsEndpoint("assistant", workspace);
    expect(first).toEqual(second);
    expect(first.kind).toBe("named-pipe");
    expect(first.source).toBe("windows-named-pipe");
    expect(isNamedPipePath(first.path)).toBe(true);
    expect(first.path.length).toBeLessThanOrEqual(
      WINDOWS_NAMED_PIPE_MAX_PATH_CHARS,
    );
  });

  test("isolates Windows endpoints by workspace, service, and override", () => {
    const first = windowsEndpoint("assistant", "C:\\one");
    const otherWorkspace = windowsEndpoint("assistant", "C:\\two");
    const otherService = windowsEndpoint("gateway", "C:\\one");
    const overridden = windowsEndpoint("assistant", "C:\\one", {
      ASSISTANT_IPC_SOCKET_DIR: "instance-two",
    });
    expect(
      new Set([first.path, otherWorkspace.path, otherService.path]).size,
    ).toBe(3);
    expect(overridden.path).not.toBe(first.path);
    expect(overridden.source).toBe("env-override");
  });

  test("rejects unsafe endpoint names", () => {
    for (const name of ["../assistant", "assistant/socket", "UPPER", ""]) {
      expect(() => windowsEndpoint(name, "C:\\workspace")).toThrow(
        "Invalid IPC endpoint name",
      );
    }
  });

  test("cleans up socket files and skips named pipes", () => {
    const dir = mkdtempSync(join(tmpdir(), "vellum-ipc-cleanup-"));
    const socketPath = join(dir, "assistant.sock");
    try {
      writeFileSync(socketPath, "stale");
      removeIpcEndpointFile(socketPath);
      expect(existsSync(socketPath)).toBe(false);
      expect(() =>
        removeIpcEndpointFile("\\\\.\\pipe\\vellum-assistant-test"),
      ).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
