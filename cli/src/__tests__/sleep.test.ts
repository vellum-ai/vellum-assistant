import {
  afterAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Create a temp directory and set BASE_DATA_DIR so the real assistant-config
// module reads the lockfile from here instead of ~/.vellum. The lockfile
// includes full resources, so we never need to mock homedir() — avoiding
// process-global os mocks that leak into other test files (e.g. multi-local).
const testDir = mkdtempSync(join(tmpdir(), "sleep-command-test-"));
const assistantRootDir = join(testDir, ".vellum");
process.env.BASE_DATA_DIR = testDir;

const stopProcessByPidFileMock = mock(async () => true);
const isProcessAliveMock = mock((): { alive: boolean; pid: number | null } => ({
  alive: false,
  pid: null,
}));

mock.module("../lib/process.js", () => ({
  isProcessAlive: isProcessAliveMock,
  stopProcessByPidFile: stopProcessByPidFileMock,
}));

import { sleep } from "../commands/sleep.js";
import {
  DEFAULT_DAEMON_PORT,
  DEFAULT_GATEWAY_PORT,
  DEFAULT_QDRANT_PORT,
} from "../lib/constants.js";

// Write a lockfile entry so the real resolveTargetAssistant() finds our test
// assistant without needing to mock the entire assistant-config module.
function writeLockfile(): void {
  writeFileSync(
    join(testDir, ".vellum.lock.json"),
    JSON.stringify(
      {
        assistants: [
          {
            assistantId: "sleep-test",
            runtimeUrl: `http://127.0.0.1:${DEFAULT_DAEMON_PORT}`,
            cloud: "local",
            resources: {
              instanceDir: testDir,
              daemonPort: DEFAULT_DAEMON_PORT,
              gatewayPort: DEFAULT_GATEWAY_PORT,
              qdrantPort: DEFAULT_QDRANT_PORT,
              socketPath: join(assistantRootDir, "vellum.sock"),
              pidFile: join(assistantRootDir, "vellum.pid"),
            },
          },
        ],
        activeAssistant: "sleep-test",
      },
      null,
      2
    )
  );
}

function writeLeaseFile(callSessionIds: string[]): void {
  mkdirSync(assistantRootDir, { recursive: true });
  writeFileSync(
    join(assistantRootDir, "active-call-leases.json"),
    JSON.stringify(
      {
        version: 1,
        leases: callSessionIds.map((callSessionId) => ({
          callSessionId,
          providerCallSid: null,
          updatedAt: Date.now(),
        })),
      },
      null,
      2
    )
  );
}

describe("sleep command", () => {
  let originalArgv: string[];

  beforeEach(() => {
    originalArgv = [...process.argv];
    isProcessAliveMock.mockReset();
    isProcessAliveMock.mockReturnValue({ alive: false, pid: null });
    stopProcessByPidFileMock.mockReset();
    stopProcessByPidFileMock.mockResolvedValue(true);
    rmSync(assistantRootDir, { recursive: true, force: true });
    writeLockfile();
  });

  afterAll(() => {
    process.argv = originalArgv;
    rmSync(testDir, { recursive: true, force: true });
    delete process.env.BASE_DATA_DIR;
  });

  test("refuses normal sleep while an active call lease exists", async () => {
    isProcessAliveMock.mockReturnValue({ alive: true, pid: 12345 });
    writeLeaseFile(["call-active-1", "call-active-2"]);
    process.argv = ["bun", "vellum", "sleep", "sleep-test"];

    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    const exitMock = mock((code?: number) => {
      throw new Error(`process.exit:${code}`);
    });
    const originalExit = process.exit;
    process.exit = (exitMock as unknown) as typeof process.exit;

    try {
      await expect(sleep()).rejects.toThrow("process.exit:1");
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("vellum sleep --force")
      );
    } finally {
      process.exit = originalExit;
      consoleError.mockRestore();
    }

    expect(stopProcessByPidFileMock).not.toHaveBeenCalled();
  });

  test("proceeds when assistant is not running even with stale lease file", async () => {
    isProcessAliveMock.mockReturnValue({ alive: false, pid: null });
    writeLeaseFile(["call-stale-1"]);
    process.argv = ["bun", "vellum", "sleep", "sleep-test"];

    const consoleLog = spyOn(console, "log").mockImplementation(() => {});

    try {
      await sleep();
    } finally {
      consoleLog.mockRestore();
    }

    expect(stopProcessByPidFileMock).toHaveBeenCalledTimes(2);
  });

  test("force stops the assistant even when an active call lease exists", async () => {
    writeLeaseFile(["call-active-1"]);
    process.argv = ["bun", "vellum", "sleep", "sleep-test", "--force"];

    const consoleLog = spyOn(console, "log").mockImplementation(() => {});

    try {
      await sleep();
    } finally {
      consoleLog.mockRestore();
    }

    expect(stopProcessByPidFileMock).toHaveBeenCalledTimes(2);
    expect(stopProcessByPidFileMock).toHaveBeenNthCalledWith(
      1,
      join(assistantRootDir, "vellum.pid"),
      "assistant",
      [join(assistantRootDir, "vellum.sock")]
    );
    expect(stopProcessByPidFileMock).toHaveBeenNthCalledWith(
      2,
      join(assistantRootDir, "gateway.pid"),
      "gateway",
      undefined,
      7000
    );
  });
});
