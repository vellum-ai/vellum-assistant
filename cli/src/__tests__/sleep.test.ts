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

const testDir = mkdtempSync(join(tmpdir(), "sleep-command-test-"));
const assistantRootDir = join(testDir, ".vellum");

const stopProcessByPidFileMock = mock(async () => true);

const mockEntry = {
  assistantId: "sleep-test",
  runtimeUrl: "http://127.0.0.1:7777",
  cloud: "local",
  resources: {
    instanceDir: testDir,
    daemonPort: 7777,
    gatewayPort: 7830,
    qdrantPort: 6333,
    socketPath: join(assistantRootDir, "vellum.sock"),
    pidFile: join(assistantRootDir, "vellum.pid"),
  },
};

mock.module("../lib/assistant-config.js", () => ({
  defaultLocalResources: () => mockEntry.resources,
  resolveTargetAssistant: () => mockEntry,
}));

mock.module("../lib/process.js", () => ({
  stopProcessByPidFile: stopProcessByPidFileMock,
}));

import { sleep } from "../commands/sleep.js";

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
      2,
    ),
  );
}

describe("sleep command", () => {
  let originalArgv: string[];

  beforeEach(() => {
    originalArgv = [...process.argv];
    stopProcessByPidFileMock.mockReset();
    stopProcessByPidFileMock.mockResolvedValue(true);
    rmSync(assistantRootDir, { recursive: true, force: true });
  });

  afterAll(() => {
    process.argv = originalArgv;
    rmSync(testDir, { recursive: true, force: true });
  });

  test("refuses normal sleep while an active call lease exists", async () => {
    writeLeaseFile(["call-active-1", "call-active-2"]);
    process.argv = ["bun", "vellum", "sleep", "sleep-test"];

    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    const exitMock = mock((code?: number) => {
      throw new Error(`process.exit:${code}`);
    });
    const originalExit = process.exit;
    process.exit = exitMock as unknown as typeof process.exit;

    try {
      await expect(sleep()).rejects.toThrow("process.exit:1");
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("vellum sleep --force"),
      );
    } finally {
      process.exit = originalExit;
      consoleError.mockRestore();
    }

    expect(stopProcessByPidFileMock).not.toHaveBeenCalled();
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
      [join(assistantRootDir, "vellum.sock")],
    );
    expect(stopProcessByPidFileMock).toHaveBeenNthCalledWith(
      2,
      join(assistantRootDir, "gateway.pid"),
      "gateway",
      undefined,
      7000,
    );
  });
});
