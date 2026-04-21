import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

/**
 * Smoke test that validates the meet-bot package can boot.
 *
 * Real Meet-join, audio capture, and Chrome/extension orchestration land in
 * later PRs of the meet-phase-1 plan; for now we only confirm that
 * `bun src/main.ts` runs to completion, exits 0, and emits the expected boot
 * marker on stdout.
 */
describe("meet-bot boot", () => {
  test("runs src/main.ts and logs the boot marker", () => {
    const pkgRoot = join(import.meta.dir, "..");
    const result = spawnSync("bun", ["run", "src/main.ts"], {
      cwd: pkgRoot,
      encoding: "utf8",
      // PulseAudio is not available on macOS dev machines / typical CI
      // runners; SKIP_PULSE=1 short-circuits the setup call in main.ts so the
      // smoke test can still verify the boot path.
      env: { ...process.env, SKIP_PULSE: "1" },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("meet-bot booted");
  });
});
