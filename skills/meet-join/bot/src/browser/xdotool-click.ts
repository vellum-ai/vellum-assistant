/**
 * xdotool-click: dispatches a REAL X-server mouse click inside the bot
 * container.
 *
 * Google Meet gates several critical buttons (the prejoin admission button
 * in particular) on `event.isTrusted === true`. A content script's
 * `element.click()` produces `isTrusted: false` and Meet silently ignores
 * it — verified empirically against a live Meet URL during Phase 1.11
 * smoke-testing. xdotool dispatches events through the X server, which
 * stamps them with `isTrusted: true`, so Meet processes them as real user
 * interactions.
 *
 * Invocation shape (one process per click — `mousemove` and `click` are
 * fused into a single argv so the pointer doesn't have a visible "dwell"
 * frame between the two):
 *
 *     DISPLAY=:99 xdotool mousemove X Y click 1
 *
 * Callers pass screen-space coordinates (the extension is responsible for
 * translating `clientX/clientY` via `window.screenX/screenY + chromeOffset`
 * before emitting the `trusted_click` native-messaging frame).
 */

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";

/** Logger shape matching the one used by `chrome-launcher`. */
export interface XdotoolClickLogger {
  info: (message: string) => void;
  error: (message: string) => void;
}

const NOOP_LOGGER: XdotoolClickLogger = {
  info: () => undefined,
  error: () => undefined,
};

/**
 * Minimal shape of Node's `spawn` used by this module — kept structural so
 * tests can inject a mock without depending on Node internals.
 */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv },
) => ChildProcess;

export interface XdotoolClickOptions {
  /** Screen-space X coordinate on the Xvfb virtual display. */
  x: number;
  /** Screen-space Y coordinate on the Xvfb virtual display. */
  y: number;
  /** X display string (e.g. ":99"). Passed as the `DISPLAY` env var. */
  display: string;
  /**
   * xdotool binary path. Defaults to `/usr/bin/xdotool` (installed by the
   * bot container). Override in tests.
   */
  binary?: string;
  /** `node:child_process.spawn` override for tests. */
  spawn?: SpawnFn;
  /** Logger for visibility into invocation + failures. Defaults to no-op. */
  logger?: XdotoolClickLogger;
  /**
   * How long to wait for xdotool to exit before rejecting. xdotool itself
   * is a very short-lived process (single mousemove + click on the local
   * X server), so this is a safety net rather than a normal-path timer.
   */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Dispatch a single trusted left-click at `(x, y)` on the Xvfb display.
 *
 * Resolves on clean exit (code 0). Rejects on non-zero exit, spawn failure,
 * or timeout. The promise intentionally does NOT resolve with any payload —
 * success is observed by the extension via subsequent DOM transitions (the
 * waitForSelector for `INGAME_LEAVE_BUTTON` is the authoritative signal).
 */
export async function xdotoolClick(opts: XdotoolClickOptions): Promise<void> {
  const binary = opts.binary ?? "/usr/bin/xdotool";
  const spawnFn = opts.spawn ?? nodeSpawn;
  const logger = opts.logger ?? NOOP_LOGGER;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Fuse mousemove + click into a single argv so the pointer doesn't hover
  // visibly between the two invocations, and so we only pay one fork/exec
  // cost per click. `click 1` is the X-server button number for left click.
  const args = ["mousemove", String(opts.x), String(opts.y), "click", "1"];

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };

    const child = spawnFn(binary, args, {
      env: { ...process.env, DISPLAY: opts.display },
    });

    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });

    child.on("error", (err) => {
      logger.error(`xdotool spawn failed: ${err.message}`);
      settle(err);
    });

    child.on("exit", (code, signal) => {
      if (code === 0) {
        logger.info(`xdotool click at (${opts.x},${opts.y}) ok`);
        settle();
        return;
      }
      const reason = signal
        ? `killed by signal ${signal}`
        : `exit code ${code}`;
      const detail = stderr.trim() ? ` stderr="${stderr.trim()}"` : "";
      settle(new Error(`xdotool click failed: ${reason}${detail}`));
    });

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // best effort; the timeout-reject below is what callers observe.
      }
      settle(
        new Error(
          `xdotool click timed out after ${timeoutMs}ms at (${opts.x},${opts.y})`,
        ),
      );
    }, timeoutMs);
  });
}
