/**
 * PulseAudio setup/teardown helpers for the meet-bot container.
 *
 * The audio plumbing (null-sinks and a virtual-source) is created by
 * `pulse-setup.sh`; this module just shells out to the script at container
 * boot so the TypeScript side has a single `await setupPulseAudio()` entry
 * point to call from `main.ts`.
 *
 * The script is idempotent — calling `setupPulseAudio` multiple times in the
 * same container is a no-op after the first invocation.
 */

import { join } from "node:path";

const SCRIPT_PATH = join(import.meta.dir, "pulse-setup.sh");

/**
 * Run `pulse-setup.sh` to bring up PulseAudio and the virtual devices the
 * bot needs. Resolves on exit code 0, rejects with a descriptive error on
 * any non-zero exit.
 *
 * The test suite injects a spawn shim via the optional argument so it can
 * verify invocation without actually running PulseAudio.
 */
export async function setupPulseAudio(
  spawn: typeof Bun.spawn = Bun.spawn,
): Promise<void> {
  const proc = spawn(["bash", SCRIPT_PATH], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stderrText, exitCode] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    const trimmed = stderrText.trim();
    const detail = trimmed.length > 0 ? `: ${trimmed}` : "";
    throw new Error(
      `pulse-setup.sh failed with exit code ${exitCode}${detail}`,
    );
  }
}

/**
 * Best-effort teardown. Called on container shutdown paths; we don't want a
 * failure here (e.g. the daemon already gone) to mask the real exit cause.
 */
export async function teardownPulseAudio(
  spawn: typeof Bun.spawn = Bun.spawn,
): Promise<void> {
  try {
    const proc = spawn(["pulseaudio", "--kill"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
  } catch {
    // Intentional: teardown is best-effort.
  }
}

/**
 * Exported for tests — the absolute path of the shell script this module
 * invokes. Not part of the public runtime surface.
 */
export const PULSE_SETUP_SCRIPT_PATH = SCRIPT_PATH;
