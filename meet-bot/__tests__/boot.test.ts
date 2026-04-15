import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

/**
 * Smoke test that validates the meet-bot package can boot.
 *
 * Real Meet-join, audio capture, and Playwright orchestration land in later
 * PRs of the meet-phase-1 plan; for now we only confirm that `bun src/main.ts`
 * runs to completion, exits 0, and emits the expected boot marker on stdout.
 */
describe("meet-bot boot", () => {
  test("runs src/main.ts and logs the boot marker", () => {
    const pkgRoot = join(import.meta.dir, "..");
    const result = spawnSync("bun", ["run", "src/main.ts"], {
      cwd: pkgRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("meet-bot booted");
  });
});
