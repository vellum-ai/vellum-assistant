/**
 * Tests the main DB's read-only connection mode — the resource monitor
 * process's posture — via a spawned subprocess (`main-db-readonly-probe.ts`)
 * with its own temp workspace. Read-only mode and the connection singletons
 * are process-global, so exercising them in the shared test-runner process
 * would poison every later test file in the same invocation.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { assertNotLiveDb } from "../../__tests__/assert-not-live-db.js";

describe("main DB read-only mode (resource monitor posture)", () => {
  test("probe subprocess: reads work, main writes fail, telemetry stays writable", () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "readonly-probe-"));
    try {
      const probePath = join(import.meta.dir, "main-db-readonly-probe.ts");
      const result = Bun.spawnSync({
        cmd: ["bun", probePath],
        env: { ...process.env, VELLUM_WORKSPACE_DIR: workspaceDir },
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = result.stdout.toString();
      const stderr = result.stderr.toString();
      expect(`${stdout}\n${stderr}`).toContain("READONLY_PROBE_OK");
      expect(result.exitCode).toBe(0);
    } finally {
      assertNotLiveDb(join(workspaceDir, "data", "db", "assistant.db"));
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  }, 60_000);
});
