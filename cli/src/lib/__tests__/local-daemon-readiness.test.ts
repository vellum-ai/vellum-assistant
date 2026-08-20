import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { logFreshSpawnReadiness } from "../local.js";

// Above every platform default pid ceiling, so no live process owns it.
const DEAD_PID = 999999;

describe("logFreshSpawnReadiness", () => {
  let tempDir: string;
  let pidFile: string;
  let logSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "vellum-readiness-"));
    pidFile = join(tempDir, "daemon.pid");
    logSpy = spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("reports the readiness of a live daemon", () => {
    /**
     * Tests that a daemon which survived its spawn has its probed state
     * reported.
     */

    // GIVEN the spawned daemon is alive
    writeFileSync(pidFile, String(process.pid), "utf-8");

    // WHEN its readiness is reported
    logFreshSpawnReadiness(pidFile, "ready");

    // THEN the probed state reaches the operator
    expect(logSpy).toHaveBeenCalledWith("   Assistant ready\n");
  });

  test("reports a startup failure instead of a probe answered by a foreign listener", () => {
    /**
     * Tests that a daemon which aborted during startup is reported as not
     * running, even when the probe reports it as up.
     */

    // GIVEN the spawned daemon is gone, while a foreign listener holding its
    // runtime HTTP port answers the readiness probe in its place
    writeFileSync(pidFile, String(DEAD_PID), "utf-8");

    // WHEN its readiness is reported
    logFreshSpawnReadiness(pidFile, "migrating");

    // THEN the failure is reported rather than the probe's optimistic state
    expect(logSpy).toHaveBeenCalledWith(
      "   ⚠️  Assistant exited during startup and is not running\n",
    );
    expect(logSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("database migrations still running"),
    );
  });

  test("throws for a dead daemon when the caller requires readiness", () => {
    /**
     * Tests that callers which cannot continue without a running assistant
     * (hatch) fail rather than proceeding on a foreign listener's probe.
     */

    // GIVEN the spawned daemon is gone and the caller requires readiness
    writeFileSync(pidFile, String(DEAD_PID), "utf-8");

    // WHEN its readiness is reported
    const report = () => logFreshSpawnReadiness(pidFile, "ready", true);

    // THEN startup fails loudly
    expect(report).toThrow("exited during startup");
  });
});
