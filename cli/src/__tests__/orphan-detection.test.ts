import { describe, test, expect, beforeEach, afterAll, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Redirect lockfile reads/writes to a scratch directory so the test never
// touches the real `~/.vellum.lock.json`.
const testDir = mkdtempSync(join(tmpdir(), "cli-orphan-detection-test-"));
process.env.VELLUM_LOCKFILE_DIR = testDir;

// Mock homedir() so `join(homedir(), ".vellum")` inside orphan-detection
// resolves under the scratch directory — the legacy fallback scan is part
// of the behavior under test and we need to keep it off the real filesystem.
const realOs = await import("node:os");
const fakeHome = mkdtempSync(join(tmpdir(), "cli-orphan-detection-home-"));
mock.module("node:os", () => ({
  ...realOs,
  homedir: () => fakeHome,
}));
mock.module("os", () => ({
  ...realOs,
  homedir: () => fakeHome,
}));

// Stub execOutput so the process-table scan never shells out to `ps`.
// The PID-file scan is the surface we want to exercise here.
mock.module("../lib/step-runner", () => ({
  execOutput: () => Promise.resolve(""),
  exec: () => Promise.resolve(undefined),
}));

// Every detected PID claims to be a live process so the scan surfaces it.
const originalKill = process.kill;
process.kill = ((pid: number, signal?: string | number) => {
  if (signal === 0) return true;
  return originalKill.call(process, pid, signal);
}) as typeof process.kill;

import { detectOrphanedProcesses } from "../lib/orphan-detection.js";
import {
  saveAssistantEntry,
  type AssistantEntry,
  type LocalInstanceResources,
} from "../lib/assistant-config.js";
import {
  DEFAULT_CES_PORT,
  DEFAULT_DAEMON_PORT,
  DEFAULT_GATEWAY_PORT,
  DEFAULT_QDRANT_PORT,
} from "../lib/constants.js";

afterAll(() => {
  process.kill = originalKill;
  rmSync(testDir, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
  delete process.env.VELLUM_LOCKFILE_DIR;
});

function resetLockfile(): void {
  for (const name of [".vellum.lock.json", ".vellum.lockfile.json"]) {
    try {
      rmSync(join(testDir, name));
    } catch {
      // file may not exist
    }
  }
}

function resetFakeHome(): void {
  rmSync(fakeHome, { recursive: true, force: true });
  mkdirSync(fakeHome, { recursive: true });
}

function makeResources(
  instanceDir: string,
  ports: Partial<LocalInstanceResources> = {},
): LocalInstanceResources {
  return {
    instanceDir,
    daemonPort: ports.daemonPort ?? DEFAULT_DAEMON_PORT,
    gatewayPort: ports.gatewayPort ?? DEFAULT_GATEWAY_PORT,
    qdrantPort: ports.qdrantPort ?? DEFAULT_QDRANT_PORT,
    cesPort: ports.cesPort ?? DEFAULT_CES_PORT,
    pidFile: join(instanceDir, ".vellum", "vellum.pid"),
  };
}

function makeEntry(
  id: string,
  instanceDir: string,
  extra?: Partial<AssistantEntry>,
): AssistantEntry {
  return {
    assistantId: id,
    runtimeUrl: `http://localhost:${DEFAULT_GATEWAY_PORT}`,
    cloud: "local",
    resources: makeResources(instanceDir),
    ...extra,
  };
}

function writePidFile(
  instanceDir: string,
  name: "vellum" | "gateway" | "qdrant",
  pid: number,
): void {
  const dir = join(instanceDir, ".vellum");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.pid`), String(pid));
}

describe("detectOrphanedProcesses", () => {
  beforeEach(() => {
    resetLockfile();
    resetFakeHome();
  });

  test("scans every local entry's instanceDir/.vellum and reports each PID", async () => {
    // GIVEN two local entries in the lockfile, each pointing at its own
    // instance directory with a stale PID file
    const instanceA = mkdtempSync(join(tmpdir(), "orphan-instance-a-"));
    const instanceB = mkdtempSync(join(tmpdir(), "orphan-instance-b-"));
    try {
      saveAssistantEntry(makeEntry("alpha", instanceA));
      saveAssistantEntry(
        makeEntry("beta", instanceB, {
          runtimeUrl: "http://localhost:8821",
        }),
      );
      writePidFile(instanceA, "vellum", 111111);
      writePidFile(instanceB, "gateway", 222222);

      // WHEN we run orphan detection
      const orphans = await detectOrphanedProcesses();

      // THEN both containers are scanned and each PID is surfaced
      const pidFileOrphans = orphans.filter((o) => o.source === "pid file");
      const pids = pidFileOrphans.map((o) => o.pid);
      expect(pids).toContain("111111");
      expect(pids).toContain("222222");

      const byName = new Map(pidFileOrphans.map((o) => [o.pid, o.name]));
      expect(byName.get("111111")).toBe("assistant");
      expect(byName.get("222222")).toBe("gateway");
    } finally {
      rmSync(instanceA, { recursive: true, force: true });
      rmSync(instanceB, { recursive: true, force: true });
    }
  });

  test("still scans legacy ~/.vellum/ when no lockfile entry covers it", async () => {
    // GIVEN no local entries in the lockfile but a stale PID file in the
    // legacy `~/.vellum/` root (pre-upgrade install)
    resetLockfile();
    writePidFile(fakeHome, "vellum", 333333);

    // WHEN we run orphan detection
    const orphans = await detectOrphanedProcesses();

    // THEN the legacy root is still scanned and the PID surfaces
    const pids = orphans
      .filter((o) => o.source === "pid file")
      .map((o) => o.pid);
    expect(pids).toContain("333333");
  });

  test("legacy ~/.vellum/ is scanned alongside multi-instance entries", async () => {
    // GIVEN a local entry AND a legacy `~/.vellum/` PID file at the same time
    const instanceA = mkdtempSync(join(tmpdir(), "orphan-instance-coexist-"));
    try {
      saveAssistantEntry(makeEntry("alpha", instanceA));
      writePidFile(instanceA, "vellum", 444444);
      writePidFile(fakeHome, "gateway", 555555);

      // WHEN we run orphan detection
      const orphans = await detectOrphanedProcesses();

      // THEN both the entry's instance dir and the legacy root are scanned
      const pids = orphans
        .filter((o) => o.source === "pid file")
        .map((o) => o.pid);
      expect(pids).toContain("444444");
      expect(pids).toContain("555555");
    } finally {
      rmSync(instanceA, { recursive: true, force: true });
    }
  });

  test("ignores remote entries — only local entries with resources are scanned", async () => {
    // GIVEN a remote entry (no resources) alongside a local entry
    const instanceA = mkdtempSync(join(tmpdir(), "orphan-instance-local-"));
    try {
      saveAssistantEntry({
        assistantId: "cloud-box",
        runtimeUrl: "http://10.0.0.1:7821",
        cloud: "gcp",
      });
      saveAssistantEntry(makeEntry("alpha", instanceA));
      writePidFile(instanceA, "qdrant", 666666);

      // WHEN we run orphan detection
      const orphans = await detectOrphanedProcesses();

      // THEN the local entry's PID still surfaces (the remote entry is
      // silently skipped)
      const pids = orphans
        .filter((o) => o.source === "pid file")
        .map((o) => o.pid);
      expect(pids).toContain("666666");
    } finally {
      rmSync(instanceA, { recursive: true, force: true });
    }
  });
});
