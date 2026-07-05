import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

import { startCes } from "../local.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Capture spawn calls so we can assert on cmd/env.
let lastSpawnCall: {
  cmd: string[];
  options: { detached?: boolean; env?: Record<string, string | undefined>; cwd?: string };
} | null = null;

mock.module("node:child_process", () => ({
  spawn: mock((cmd: string, args: string[], options: object) => {
    lastSpawnCall = { cmd: [cmd, ...args], options };
    // Return a fake subprocess with a pid and no-op methods.
    return {
      pid: 42,
      unref: () => {},
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      on: () => {},
    };
  }),
  execSync: () => "",
  execFileSync: () => "",
  spawnSync: () => ({ status: 0, stdout: "", stderr: "" }),
}));

// Mock xdg-log so we don't open real log files.
mock.module("../xdg-log.js", () => ({
  openLogFile: mock(() => 42),
  pipeToLogFile: mock(() => {}),
}));

// Mock process helpers so stopProcessByPidFile is a no-op.
mock.module("../process.js", () => ({
  stopProcessByPidFile: mock(async () => {}),
  isProcessAlive: mock(() => false),
  stopProcessGracefully: mock(async () => {}),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("startCes", () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ces-test-"));
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("spawns CES with correct env vars and writes PID file", async () => {
    // Create the socket path before calling startCes so the wait loop exits.
    // startCes unlinks it first, then waits for it to reappear. We create it
    // after a short delay to simulate CES binding the socket.
    const resources = {
      instanceDir: tempDir,
      name: "test-assistant",
    } as any;

    // Create the socket file asynchronously after startCes unlinks it.
    // We use a small setTimeout to create it during the wait loop.
    const vellumDir = join(tempDir, ".vellum");
    mkdirSync(vellumDir, { recursive: true });

    // Pre-create the socket so it exists when startCes checks after unlinking.
    // startCes unlinks the stale socket, then polls for it. We create it with
    // a slight delay so the poll catches it.
    setTimeout(() => {
      const socketDir = join(vellumDir, "workspace");
      mkdirSync(socketDir, { recursive: true });
      writeFileSync(join(socketDir, "ces.sock"), "");
    }, 50);

    lastSpawnCall = null;
    await startCes(false, resources);

    // Verify spawn was called
    expect(lastSpawnCall).not.toBeNull();
    expect(lastSpawnCall!.options.detached).toBe(true);

    // Verify env vars
    const env = lastSpawnCall!.options.env!;
    expect(env["CES_STANDALONE"]).toBe("1");
    expect(env["CES_LOCAL_SOCKET"]).toBeDefined();
    expect(env["CREDENTIAL_SECURITY_DIR"]).toBeDefined();
    expect(env["VELLUM_WORKSPACE_DIR"]).toBeDefined();

    // Verify PID file was written
    const cesPidFile = join(vellumDir, "ces.pid");
    expect(existsSync(cesPidFile)).toBe(true);
  }, 15_000);
});
