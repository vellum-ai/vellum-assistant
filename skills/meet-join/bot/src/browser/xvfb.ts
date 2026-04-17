/**
 * Xvfb (X Virtual Framebuffer) lifecycle helpers.
 *
 * The meet-bot runs inside a Linux container without a real display; Xvfb
 * provides a headless X server that Chromium can render into. We keep
 * Chromium non-headless because Meet's bot-detection is friendlier toward
 * browsers that have a window manager and a real display, and Xvfb lets us
 * do that without a GPU.
 *
 * These helpers are intentionally small:
 *
 *   - `startXvfb(display)` spawns `Xvfb :99 -screen 0 1280x720x24` and waits
 *     for the corresponding X lock file (`/tmp/.X<N>-lock`) to appear before
 *     resolving. If the lock file is already present we assume Xvfb is up and
 *     return a no-op handle without spawning a second server.
 *   - `stopXvfb(handle)` sends SIGTERM, then escalates to SIGKILL after 2s.
 *
 * Everything heavier (integration against real Xvfb + Chromium) is gated
 * behind `XVFB_TEST=1` in the test suite so CI and macOS developers don't
 * accidentally try to exec a Linux binary.
 */

import type { Subprocess } from "bun";
import { existsSync, readFileSync, unlinkSync } from "node:fs";

/** Opaque handle returned by `startXvfb`, consumed by `stopXvfb`. */
export interface XvfbHandle {
  /** The X display string we started on, e.g. `":99"`. */
  readonly display: string;
  /**
   * The Xvfb child process, or `null` if we detected an existing server via
   * the lock file and skipped spawning our own.
   */
  readonly process: Subprocess | null;
}

const LOCK_WAIT_TIMEOUT_MS = 10_000;
const LOCK_POLL_INTERVAL_MS = 100;
const SIGKILL_GRACE_MS = 2_000;

/**
 * Parse the numeric display index out of an X display string.
 *
 * Accepts `":99"`, `"99"`, or `":99.0"`-style inputs. Throws on anything we
 * can't parse cleanly rather than guessing — a bad display string will hang
 * Chromium later in a way that's much harder to debug.
 */
function parseDisplayIndex(display: string): number {
  const trimmed = display.startsWith(":") ? display.slice(1) : display;
  // Strip optional screen suffix (e.g. ":99.0" -> "99").
  const [head] = trimmed.split(".");
  const n = Number.parseInt(head ?? "", 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`startXvfb: invalid display string: ${display}`);
  }
  return n;
}

/** Path Xvfb uses for its per-display lock file. */
function lockFilePath(displayIndex: number): string {
  return `/tmp/.X${displayIndex}-lock`;
}

function parseLockPid(lockPath: string): number | null {
  try {
    const content = readFileSync(lockPath, "utf8").trim();
    const pid = Number.parseInt(content, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Start Xvfb on `display` (default `":99"`) and wait for its lock file to
 * appear. If the lock file already exists we assume another process owns
 * Xvfb on this display and return a handle with `process: null` — `stopXvfb`
 * will then be a no-op.
 */
export async function startXvfb(display = ":99"): Promise<XvfbHandle> {
  const displayIndex = parseDisplayIndex(display);
  const lockPath = lockFilePath(displayIndex);

  if (existsSync(lockPath)) {
    // Verify the lock holder is still alive. If Xvfb died uncleanly its
    // lock file lingers and prevents respawning.
    const pid = parseLockPid(lockPath);
    if (pid !== null && isProcessAlive(pid)) {
      return { display, process: null };
    }
    // Stale lock — remove it so we can respawn.
    try {
      unlinkSync(lockPath);
    } catch {
      // Race with another cleanup; fine.
    }
  }

  const canonicalDisplay = `:${displayIndex}`;
  const proc = Bun.spawn(["Xvfb", canonicalDisplay, "-screen", "0", "1280x720x24"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });

  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (existsSync(lockPath)) {
      return { display: canonicalDisplay, process: proc };
    }
    // If Xvfb died during startup, bail out with a useful error instead of
    // spinning until the timeout.
    if (proc.exitCode !== null) {
      const stderr = proc.stderr ? await new Response(proc.stderr).text() : "";
      throw new Error(
        `startXvfb: Xvfb exited during startup (code=${proc.exitCode}): ${stderr.trim()}`,
      );
    }
    await sleep(LOCK_POLL_INTERVAL_MS);
  }

  // Timed out — try to kill what we spawned so we don't leak a process.
  try {
    proc.kill("SIGKILL");
  } catch {
    // Best effort; the process may have already exited.
  }
  throw new Error(
    `startXvfb: lock file ${lockPath} did not appear within ${LOCK_WAIT_TIMEOUT_MS}ms`,
  );
}

/**
 * Stop an Xvfb instance started by `startXvfb`. Sends SIGTERM first, then
 * SIGKILL after a short grace period if the process hasn't exited. A no-op
 * when the handle represents an externally-owned Xvfb (`process: null`).
 */
export async function stopXvfb(handle: XvfbHandle): Promise<void> {
  const proc = handle.process;
  if (!proc) return;
  if (proc.exitCode !== null) return;

  try {
    proc.kill("SIGTERM");
  } catch {
    // Ignore — process may have already exited between the exitCode check
    // and the kill call.
  }

  // Wait up to SIGKILL_GRACE_MS for a clean shutdown.
  const deadline = Date.now() + SIGKILL_GRACE_MS;
  while (Date.now() < deadline && proc.exitCode === null) {
    await sleep(50);
  }

  if (proc.exitCode === null) {
    try {
      proc.kill("SIGKILL");
    } catch {
      // Ditto — best effort.
    }
  }

  // Let `exited` settle so we don't leak the Subprocess promise.
  try {
    await proc.exited;
  } catch {
    // Ignored — we only care that the process is no longer running.
  }
}
