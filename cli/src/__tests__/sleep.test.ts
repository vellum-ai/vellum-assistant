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

// Create a temp directory and set VELLUM_LOCKFILE_DIR so the real
// assistant-config module reads/writes the lockfile here instead of ~/.
const testDir = mkdtempSync(join(tmpdir(), "sleep-command-test-"));
const assistantRootDir = join(testDir, ".vellum");
process.env.VELLUM_LOCKFILE_DIR = testDir;

const stopProcessByPidFileMock = mock(async () => true);
const isProcessAliveMock = mock((): { alive: boolean; pid: number | null } => ({
  alive: false,
  pid: null,
}));

const realProcess = { ...(await import("../lib/process.js")) };

mock.module("../lib/process.js", () => ({
  isProcessAlive: isProcessAliveMock,
  stopProcessByPidFile: stopProcessByPidFileMock,
}));

// Mock the drain phase and the guardian-token loader so `--wait` tests can
// steer outcomes without a live daemon. Both spread the real module so
// untouched exports keep working (parseWaitDuration stays real).
import type { DrainOptions, DrainOutcome } from "../lib/drain.js";

const drainAssistantMock = mock(
  async (_opts: DrainOptions): Promise<DrainOutcome> => "drained",
);
const realDrain = { ...(await import("../lib/drain.js")) };
mock.module("../lib/drain.js", () => ({
  ...realDrain,
  drainAssistant: drainAssistantMock,
}));

const realGuardianToken = { ...(await import("../lib/guardian-token.js")) };
const loadGuardianTokenMock = mock(
  (_assistantId: string) =>
    ({ accessToken: "test-guardian-token" }) as unknown as ReturnType<
      typeof realGuardianToken.loadGuardianToken
    >,
);
mock.module("../lib/guardian-token.js", () => ({
  ...realGuardianToken,
  loadGuardianToken: loadGuardianTokenMock,
}));

// Stub the token-refresh helper without importing the real client module
// (it drags in the interactive chat client's dependency graph). Pass-through
// by default: the stored token is returned as-is.
const resolveFreshBearerTokenMock = mock(
  async (
    _runtimeUrl: string,
    _assistantId: string,
    bearerToken: string | undefined,
    _cloud: string | undefined,
  ) => bearerToken,
);
mock.module("../commands/client.js", () => ({
  resolveFreshBearerToken: resolveFreshBearerTokenMock,
}));

// Restore the real modules once this file finishes so the mocks do not leak
// into other test files in the same `bun test` run.
afterAll(() => {
  mock.module("../lib/process.js", () => realProcess);
  mock.module("../lib/drain.js", () => realDrain);
  mock.module("../lib/guardian-token.js", () => realGuardianToken);
});

import { sleep } from "../commands/sleep.js";
import {
  DEFAULT_DAEMON_PORT,
  DEFAULT_GATEWAY_PORT,
  DEFAULT_QDRANT_PORT,
} from "../lib/constants.js";

// Write a lockfile entry so the real resolveTargetAssistant() finds our test
// assistant without needing to mock the entire assistant-config module.
function writeLockfile(extraEntryFields: Record<string, unknown> = {}): void {
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
            },
            ...extraEntryFields,
          },
        ],
        activeAssistant: "sleep-test",
      },
      null,
      2,
    ),
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
      2,
    ),
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
    drainAssistantMock.mockReset();
    drainAssistantMock.mockResolvedValue("drained");
    loadGuardianTokenMock.mockReset();
    loadGuardianTokenMock.mockReturnValue({
      accessToken: "test-guardian-token",
    } as unknown as ReturnType<typeof realGuardianToken.loadGuardianToken>);
    resolveFreshBearerTokenMock.mockReset();
    resolveFreshBearerTokenMock.mockImplementation(
      async (_url, _id, bearerToken, _cloud) => bearerToken,
    );
    rmSync(assistantRootDir, { recursive: true, force: true });
    writeLockfile();
  });

  afterAll(() => {
    process.argv = originalArgv;
    rmSync(testDir, { recursive: true, force: true });
    delete process.env.VELLUM_LOCKFILE_DIR;
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

    // assistant + gateway + CES sibling
    expect(stopProcessByPidFileMock).toHaveBeenCalledTimes(3);
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

    expect(stopProcessByPidFileMock).toHaveBeenCalledTimes(3);
    // The assistant stop passes a generous 120s grace so the daemon's WAL
    // checkpoint completes before any SIGKILL (default 2s would truncate it).
    expect(stopProcessByPidFileMock).toHaveBeenNthCalledWith(
      1,
      join(assistantRootDir, "workspace", "vellum.pid"),
      "assistant",
      undefined,
      120_000,
    );
    expect(stopProcessByPidFileMock).toHaveBeenNthCalledWith(
      2,
      join(assistantRootDir, "gateway.pid"),
      "gateway",
      undefined,
      7000,
    );
    // The CES sibling is stopped by its PID file; a no-op when absent.
    expect(stopProcessByPidFileMock).toHaveBeenNthCalledWith(
      3,
      join(assistantRootDir, "ces.pid"),
      "credential-executor",
    );
  });

  describe("--wait", () => {
    test("runs the drain phase against localUrl before stopping", async () => {
      writeLockfile({ localUrl: "http://127.0.0.1:9999" });
      isProcessAliveMock.mockReturnValue({ alive: true, pid: 4321 });
      process.argv = ["bun", "vellum", "sleep", "sleep-test", "--wait"];

      const consoleLog = spyOn(console, "log").mockImplementation(() => {});
      try {
        await sleep();
      } finally {
        consoleLog.mockRestore();
      }

      expect(drainAssistantMock).toHaveBeenCalledTimes(1);
      const opts = drainAssistantMock.mock.calls[0]![0];
      expect(opts.baseUrl).toBe("http://127.0.0.1:9999");
      expect(opts.token).toBe("test-guardian-token");
      // Bare --wait waits as long as it takes.
      expect(opts.deadlineAt).toBeNull();
      expect(stopProcessByPidFileMock).toHaveBeenCalledTimes(3);
    });

    test("a duration bounds the wait with a deadline", async () => {
      isProcessAliveMock.mockReturnValue({ alive: true, pid: 4321 });
      process.argv = ["bun", "vellum", "sleep", "sleep-test", "--wait", "90s"];

      const consoleLog = spyOn(console, "log").mockImplementation(() => {});
      const before = Date.now();
      try {
        await sleep();
      } finally {
        consoleLog.mockRestore();
      }

      const opts = drainAssistantMock.mock.calls[0]![0];
      expect(opts.deadlineAt).toBeGreaterThanOrEqual(before + 89_000);
      expect(opts.deadlineAt).toBeLessThanOrEqual(Date.now() + 91_000);
      expect(stopProcessByPidFileMock).toHaveBeenCalledTimes(3);
    });

    test("cancelled drain exits 130 without stopping anything", async () => {
      isProcessAliveMock.mockReturnValue({ alive: true, pid: 4321 });
      drainAssistantMock.mockResolvedValue("cancelled");
      process.argv = ["bun", "vellum", "sleep", "sleep-test", "--wait"];

      const consoleLog = spyOn(console, "log").mockImplementation(() => {});
      const exitMock = mock((code?: number) => {
        throw new Error(`process.exit:${code}`);
      });
      const originalExit = process.exit;
      process.exit = exitMock as unknown as typeof process.exit;
      try {
        await expect(sleep()).rejects.toThrow("process.exit:130");
      } finally {
        process.exit = originalExit;
        consoleLog.mockRestore();
      }

      expect(stopProcessByPidFileMock).not.toHaveBeenCalled();
    });

    test("skips the drain when the assistant is not running", async () => {
      isProcessAliveMock.mockReturnValue({ alive: false, pid: null });
      process.argv = ["bun", "vellum", "sleep", "sleep-test", "--wait"];

      const consoleLog = spyOn(console, "log").mockImplementation(() => {});
      try {
        await sleep();
      } finally {
        consoleLog.mockRestore();
      }

      expect(drainAssistantMock).not.toHaveBeenCalled();
      expect(stopProcessByPidFileMock).toHaveBeenCalledTimes(3);
    });

    test("stops without waiting when no guardian token is available", async () => {
      isProcessAliveMock.mockReturnValue({ alive: true, pid: 4321 });
      loadGuardianTokenMock.mockReturnValue(null);
      process.argv = ["bun", "vellum", "sleep", "sleep-test", "--wait"];

      const consoleLog = spyOn(console, "log").mockImplementation(() => {});
      try {
        await sleep();
      } finally {
        consoleLog.mockRestore();
      }

      expect(drainAssistantMock).not.toHaveBeenCalled();
      expect(stopProcessByPidFileMock).toHaveBeenCalledTimes(3);
    });

    test("rejects an invalid --wait duration", async () => {
      process.argv = ["bun", "vellum", "sleep", "sleep-test", "--wait=abc"];

      const consoleError = spyOn(console, "error").mockImplementation(() => {});
      const exitMock = mock((code?: number) => {
        throw new Error(`process.exit:${code}`);
      });
      const originalExit = process.exit;
      process.exit = exitMock as unknown as typeof process.exit;
      try {
        await expect(sleep()).rejects.toThrow("process.exit:1");
        expect(consoleError).toHaveBeenCalledWith(
          expect.stringContaining("invalid --wait duration"),
        );
      } finally {
        process.exit = originalExit;
        consoleError.mockRestore();
      }

      expect(stopProcessByPidFileMock).not.toHaveBeenCalled();
    });
  });
});
