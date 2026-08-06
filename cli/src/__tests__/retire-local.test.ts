import {
  afterAll,
  beforeAll,
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

import type { AssistantEntry } from "../lib/assistant-config.js";

const testDir = mkdtempSync(join(tmpdir(), "retire-local-test-"));
const originalLockfileDir = process.env.VELLUM_LOCKFILE_DIR;

// Snapshot the real modules before mocking so the module-scoped `afterAll`
// below can restore them. Bun runs every test file in one process with a
// shared loader, and `mock.restore()` does not undo `mock.module()`. Without
// restoring, the `retire-archive.js` mock in particular leaks its hardcoded
// `test-assistant.*` paths into sibling files (e.g. `recover.test.ts`), which
// then fail to find their own archives.
const realProcess = { ...(await import("../lib/process.js")) };
const realNginxIngress = { ...(await import("../lib/nginx-ingress.js")) };
const realRetireArchive = { ...(await import("../lib/retire-archive.js")) };

const stopProcessByPidFileMock = mock(
  async (_pidFile: string, _label: string): Promise<boolean> => true,
);
const stopOrphanedDaemonProcessesMock = mock(
  async (): Promise<boolean> => false,
);
const stopIngressNginxMock = mock(async (): Promise<boolean> => false);

mock.module("../lib/process.js", () => ({
  stopProcessByPidFile: stopProcessByPidFileMock,
  stopOrphanedDaemonProcesses: stopOrphanedDaemonProcessesMock,
}));

mock.module("../lib/nginx-ingress.js", () => ({
  stopIngressNginx: stopIngressNginxMock,
}));

// Keep archive paths on the same filesystem as the test dir so rename doesn't
// hit EXDEV (cross-device link).
const retiredStagingDir = join(testDir, "retired");
mock.module("../lib/retire-archive.js", () => ({
  getArchivePath: () => join(retiredStagingDir, "test-assistant.tar.gz"),
  getMetadataPath: () => join(retiredStagingDir, "test-assistant.meta.json"),
}));

// Restore the real modules once this file finishes so the mocks above do not
// leak into other test files in the same `bun test` run.
afterAll(() => {
  mock.module("../lib/process.js", () => realProcess);
  mock.module("../lib/nginx-ingress.js", () => realNginxIngress);
  mock.module("../lib/retire-archive.js", () => realRetireArchive);
});

import { retireLocal } from "../lib/retire-local.js";

const instanceDir = join(testDir, "test-instance");
const vellumDir = join(instanceDir, ".vellum");

function makeEntry(assistantId: string): AssistantEntry {
  return {
    assistantId,
    runtimeUrl: "http://127.0.0.1:7801",
    cloud: "local",
    resources: {
      instanceDir,
      daemonPort: 7801,
      gatewayPort: 7831,
      qdrantPort: 6334,
      cesPort: 7790,
    },
  };
}

function writeLockfile(entries: AssistantEntry[]): void {
  writeFileSync(
    join(testDir, ".vellum.lock.json"),
    JSON.stringify({ assistants: entries }, null, 2) + "\n",
  );
}

describe("retireLocal — CES sibling stop", () => {
  beforeAll(() => {
    process.env.VELLUM_LOCKFILE_DIR = testDir;
  });

  beforeEach(() => {
    stopProcessByPidFileMock.mockReset();
    stopProcessByPidFileMock.mockResolvedValue(true);
    stopOrphanedDaemonProcessesMock.mockReset();
    stopOrphanedDaemonProcessesMock.mockResolvedValue(false);
    stopIngressNginxMock.mockReset();
    stopIngressNginxMock.mockResolvedValue(false);

    rmSync(instanceDir, { recursive: true, force: true });
    rmSync(join(testDir, "retired"), { recursive: true, force: true });
    mkdirSync(vellumDir, { recursive: true });
    writeLockfile([makeEntry("test-assistant")]);

    // Suppress console output from the lifecycle reporter.
    spyOn(console, "log").mockImplementation(() => {});
    spyOn(console, "warn").mockImplementation(() => {});
  });

  afterAll(() => {
    if (originalLockfileDir === undefined) {
      delete process.env.VELLUM_LOCKFILE_DIR;
    } else {
      process.env.VELLUM_LOCKFILE_DIR = originalLockfileDir;
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  test("stops the CES sibling alongside daemon and gateway", async () => {
    const entry = makeEntry("test-assistant");
    await retireLocal("test-assistant", entry, {
      progress: () => {},
      log: () => {},
      warn: () => {},
      error: () => {},
    });

    // Verify CES PID file is among the stop calls.
    const cesStopCall = stopProcessByPidFileMock.mock.calls.find(
      ([pidFile, label]) =>
        pidFile === join(vellumDir, "ces.pid") &&
        label === "credential-executor",
    );
    expect(cesStopCall).toBeDefined();

    // Also verify daemon and gateway are still stopped (sanity).
    const daemonStopCall = stopProcessByPidFileMock.mock.calls.find(
      ([, label]) => label === "daemon",
    );
    expect(daemonStopCall).toBeDefined();

    const gatewayStopCall = stopProcessByPidFileMock.mock.calls.find(
      ([, label]) => label === "gateway",
    );
    expect(gatewayStopCall).toBeDefined();
  });

  test("CES stop is a no-op when ces.pid is absent", async () => {
    // stopProcessByPidFile returns false when the PID file doesn't exist.
    // retireLocal should still complete successfully — the CES stop is best-effort.
    stopProcessByPidFileMock.mockImplementation(
      async (pidFile: string): Promise<boolean> => {
        if (pidFile.includes("ces.pid")) return false;
        return true;
      },
    );

    const entry = makeEntry("test-assistant");
    await retireLocal("test-assistant", entry, {
      progress: () => {},
      log: () => {},
      warn: () => {},
      error: () => {},
    });

    // The CES stop was attempted (PID file checked) but returned false.
    const cesStopCall = stopProcessByPidFileMock.mock.calls.find(
      ([pidFile, label]) =>
        pidFile === join(vellumDir, "ces.pid") &&
        label === "credential-executor",
    );
    expect(cesStopCall).toBeDefined();
  });
});
