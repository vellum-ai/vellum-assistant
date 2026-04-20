/**
 * xdotool-type: dispatches REAL X-server keystrokes inside the bot
 * container.
 *
 * Google Meet (and other browser-based UIs) gate certain text-input
 * behaviors on `event.isTrusted === true`. A content script that writes
 * directly to `input.value` produces synthetic input events with
 * `isTrusted: false`, which some framework-driven fields (e.g. React
 * controlled components behind Meet's prejoin name field) silently
 * reject or immediately overwrite. `xdotool type` dispatches keypress
 * events through the X server so the browser sees them as trusted user
 * input.
 *
 * Invocation shape (one process per type call — the text is passed as
 * a single argv token, NOT shell-interpolated, so arbitrary user content
 * is safe):
 *
 *     DISPLAY=:99 xdotool type --delay 25 --clearmodifiers -- "hello world"
 *
 * Callers are responsible for ensuring the target element has keyboard
 * focus before invoking (e.g. via a prior `xdotoolClick` to focus the
 * field).
 */

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";

/** Logger shape matching the one used by `chrome-launcher`. */
export interface XdotoolTypeLogger {
  info: (message: string) => void;
  error: (message: string) => void;
}

const NOOP_LOGGER: XdotoolTypeLogger = {
  info: () => undefined,
  error: () => undefined,
};

/**
 * Minimal shape of Node's `spawn` used by this module — kept structural so
 * tests can inject a mock without depending on Node internals. Redeclared
 * here (not imported from xdotool-click.ts) so the two primitives remain
 * independently testable and independently evolvable.
 */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv },
) => ChildProcess;

export interface XdotoolTypeOptions {
  /** Literal text to type. Passed via argv — NOT shell-interpreted. */
  text: string;
  /** X display string (e.g. ":99"). Passed as the `DISPLAY` env var. */
  display: string;
  /** xdotool --delay value. Defaults to 25ms per keystroke. */
  delayMs?: number;
  /**
   * xdotool binary path. Defaults to `/usr/bin/xdotool` (installed by the
   * bot container). Override in tests.
   */
  binary?: string;
  /** `node:child_process.spawn` override for tests. */
  spawn?: SpawnFn;
  /** Logger for visibility into invocation + failures. Defaults to no-op. */
  logger?: XdotoolTypeLogger;
  /**
   * How long to wait for xdotool to exit before rejecting. Long text
   * combined with the per-keystroke delay means typing legitimately can
   * take a second or two — default 15s is a safety net, not a normal-path
   * timer.
   */
  timeoutMs?: number;
}

const DEFAULT_DELAY_MS = 25;
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Type `opts.text` as trusted keystrokes on the Xvfb display.
 *
 * Resolves on clean exit (code 0). Rejects on non-zero exit, spawn failure,
 * or timeout. The promise does NOT resolve with any payload — success is
 * observed by the extension via subsequent DOM transitions on the focused
 * input element.
 */
export async function xdotoolType(opts: XdotoolTypeOptions): Promise<void> {
  const binary = opts.binary ?? "/usr/bin/xdotool";
  const spawnFn = opts.spawn ?? nodeSpawn;
  const logger = opts.logger ?? NOOP_LOGGER;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const delayMs = opts.delayMs ?? DEFAULT_DELAY_MS;

  // `--clearmodifiers` ensures we don't accidentally inherit a stuck
  // modifier key (Shift/Ctrl/Alt) from a prior input event. The `--`
  // end-of-options marker is required before `text` so that arbitrary
  // content starting with `-` (e.g. a negative number like `-14.7873`)
  // is not re-parsed by xdotool as an option flag. `text` is passed as
  // a single argv entry so the shell is never involved and arbitrary
  // content (including quotes, spaces, backticks) is handled safely.
  const args = [
    "type",
    "--delay",
    String(delayMs),
    "--clearmodifiers",
    "--",
    opts.text,
  ];

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
        logger.info(`xdotool type (${opts.text.length} chars) ok`);
        settle();
        return;
      }
      const reason = signal
        ? `killed by signal ${signal}`
        : `exit code ${code}`;
      const detail = stderr.trim() ? ` stderr="${stderr.trim()}"` : "";
      settle(new Error(`xdotool type failed: ${reason}${detail}`));
    });

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // best effort; the timeout-reject below is what callers observe.
      }
      settle(new Error(`xdotool type timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
}
