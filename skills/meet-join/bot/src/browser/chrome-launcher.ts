/**
 * chrome-launcher: spawns google-chrome-stable as a PLAIN USER PROCESS.
 *
 * Deliberately does NOT use CDP, Playwright, Puppeteer, or any of:
 *   --remote-debugging-port
 *   --remote-debugging-pipe
 *   --enable-automation
 *
 * Google Meet's BotGuard (as of 2026-04) detects CDP attachment and rejects
 * anonymous joiners with "You can't join this video call" before the prejoin
 * surface renders. The empirical reproduction lives in the Phase 1.11 plan
 * at .private/plans/archived/meet-phase-1-11-chrome-extension.md. Browser
 * control happens via a Chrome extension loaded with --load-extension that
 * communicates with this bot process via Chrome Native Messaging; it does
 * NOT depend on CDP.
 */

import {
  spawn as nodeSpawn,
  type ChildProcess,
} from "node:child_process";

export interface ChromeLauncherLogger {
  info: (message: string) => void;
  error: (message: string) => void;
}

export interface LaunchChromeOptions {
  /** Meet URL the browser should open on startup. */
  meetingUrl: string;
  /** X display string for the Xvfb server (e.g. ":99"). */
  displayNumber: string;
  /** Absolute path to the loaded Chrome extension directory. */
  extensionPath: string;
  /** Absolute path to the Chrome user-data directory for this session. */
  userDataDir: string;
  /**
   * Chrome binary path. Defaults to `/usr/bin/google-chrome-stable` (installed
   * by the bot container). Override in tests.
   */
  chromeBinary?: string;
  /**
   * Logger for stdout/stderr piped from Chrome. Defaults to a no-op. Chrome is
   * noisy (benign DBus warnings, etc.) so tests can override; production does
   * NOT suppress output — full logs are useful when debugging join failures.
   */
  logger?: ChromeLauncherLogger;
  /**
   * `spawn` function to invoke. Defaults to `node:child_process`'s `spawn`.
   * Override is for tests.
   */
  spawn?: typeof nodeSpawn;
  /**
   * Milliseconds to wait between SIGTERM and SIGKILL during `stop()`. Defaults
   * to 5000 (the value production uses). Tests override to avoid 5s waits.
   */
  sigkillGraceMs?: number;
}

export interface ChromeProcessHandle {
  /** PID of the spawned Chrome process. */
  pid: number;
  /**
   * Gracefully stop Chrome. Sends SIGTERM, then escalates to SIGKILL after 5
   * seconds if the child hasn't exited. Idempotent — calling twice only
   * signals once. Resolves when the child has actually exited.
   */
  stop: () => Promise<void>;
  /** Resolves with Chrome's exit code whenever it exits. */
  exitPromise: Promise<number>;
}

/** Default grace period between SIGTERM and SIGKILL during `stop()`. */
const DEFAULT_SIGKILL_GRACE_MS = 5_000;

/** No-op logger used when caller doesn't supply one. */
const NOOP_LOGGER: ChromeLauncherLogger = {
  info: () => {},
  error: () => {},
};

/**
 * Build the argv list we pass to google-chrome-stable.
 *
 * The set below is the empirically validated working configuration from the
 * Phase 1.11 debugging pass. Do NOT add any CDP-related flag here
 * (`--remote-debugging-port`, `--remote-debugging-pipe`, `--enable-automation`)
 * — their absence is the whole point of this launcher.
 */
function buildChromeArgs(opts: {
  meetingUrl: string;
  extensionPath: string;
  userDataDir: string;
}): string[] {
  return [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-setuid-sandbox",
    "--disable-background-networking",
    "--disable-breakpad",
    "--window-size=1280,720",
    "--window-position=0,0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-default-apps",
    "--use-fake-ui-for-media-stream",
    `--user-data-dir=${opts.userDataDir}`,
    `--load-extension=${opts.extensionPath}`,
    opts.meetingUrl,
  ];
}

/**
 * Spawn google-chrome-stable with the extension loaded and return a handle.
 *
 * The caller owns lifecycle: they must invoke `stop()` when done, or await
 * `exitPromise` if Chrome exits on its own (expected when the meeting ends).
 */
export async function launchChrome(
  opts: LaunchChromeOptions,
): Promise<ChromeProcessHandle> {
  const chromeBinary = opts.chromeBinary ?? "/usr/bin/google-chrome-stable";
  const logger = opts.logger ?? NOOP_LOGGER;
  const spawnFn = opts.spawn ?? nodeSpawn;
  const sigkillGraceMs = opts.sigkillGraceMs ?? DEFAULT_SIGKILL_GRACE_MS;

  const args = buildChromeArgs({
    meetingUrl: opts.meetingUrl,
    extensionPath: opts.extensionPath,
    userDataDir: opts.userDataDir,
  });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DISPLAY: opts.displayNumber,
    PULSE_SOURCE: "bot_mic",
    PULSE_SINK: "meet_capture",
  };

  const child: ChildProcess = spawnFn(chromeBinary, args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Forward stdout/stderr through the logger. Chrome emits many benign
  // warnings (DBus, etc.); we route everything to `info` rather than split
  // stderr into `error`, because the split is noisy and not useful in
  // production. Tests override the logger to capture or silence.
  const forward = (chunk: Buffer | string): void => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    for (const line of text.split(/\r?\n/)) {
      if (line.length === 0) continue;
      logger.info(`[chrome] ${line}`);
    }
  };
  child.stdout?.on("data", forward);
  child.stderr?.on("data", forward);

  // `pid` is typed `number | undefined` on ChildProcess even though it's set
  // synchronously on successful spawn. Guard so we fail loudly rather than
  // silently handing back `pid: 0` or `NaN`.
  const pid = child.pid;
  if (typeof pid !== "number") {
    throw new Error(
      `launchChrome: spawn returned a child with no pid (binary=${chromeBinary})`,
    );
  }

  const exitPromise = new Promise<number>((resolve) => {
    child.on("exit", (code) => {
      // `code` is null when the process was killed by a signal. Report 0 in
      // that case so downstream callers can treat "clean shutdown" uniformly.
      resolve(typeof code === "number" ? code : 0);
    });
  });

  let stopCalled = false;
  const stop = async (): Promise<void> => {
    if (stopCalled) {
      // Still await the original exit — idempotent `stop()` must wait for
      // the first invocation's cleanup to complete.
      await exitPromise;
      return;
    }
    stopCalled = true;

    // If the child has already exited, nothing to do.
    if (child.exitCode !== null || child.signalCode !== null) {
      await exitPromise;
      return;
    }

    try {
      child.kill("SIGTERM");
    } catch (err) {
      // Process may have died between our check and the kill call. Fall
      // through to the exit wait.
      logger.error(
        `[chrome] SIGTERM failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Race the exit against the grace timer. If Chrome hasn't exited in 5s,
    // escalate to SIGKILL.
    const timer = new Promise<"timeout">((resolve) => {
      setTimeout(() => resolve("timeout"), sigkillGraceMs);
    });
    const raced = await Promise.race([
      exitPromise.then(() => "exited" as const),
      timer,
    ]);

    if (raced === "timeout") {
      try {
        child.kill("SIGKILL");
      } catch (err) {
        logger.error(
          `[chrome] SIGKILL failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      await exitPromise;
    }
  };

  return { pid, stop, exitPromise };
}
