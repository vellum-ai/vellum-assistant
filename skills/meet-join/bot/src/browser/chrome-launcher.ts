/**
 * chrome-launcher: spawns chromium as a PLAIN USER PROCESS.
 *
 * We launch Debian's `chromium` package rather than `google-chrome-stable`
 * because Chrome 128+ silently strips the `--load-extension` command-line
 * flag ("--load-extension is not allowed in Google Chrome, ignoring"),
 * which blocks our extension-based architecture. Chromium still honors
 * the flag and is otherwise indistinguishable to Meet's BotGuard when
 * launched as a plain subprocess.
 *
 * Deliberately does NOT use CDP or any CDP-based automation framework.
 * The launcher also does NOT pass any of:
 *   --remote-debugging-port
 *   --remote-debugging-pipe
 *   --enable-automation
 *
 * Google Meet's BotGuard (as of 2026-04) detects CDP attachment and rejects
 * anonymous joiners with "You can't join this video call" before the prejoin
 * surface renders. The empirical reproduction lives in the Phase 1.11 plan
 * at .private/plans/archived/meet-phase-1-11-chrome-extension.md. Browser
 * control happens via a loaded extension that communicates with this bot
 * process via Chrome Native Messaging; it does NOT depend on CDP.
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
   * Browser binary path. Defaults to `/usr/bin/chromium` (Debian's chromium
   * package, installed by the bot container). Override in tests.
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
  /**
   * When `true`, append the Phase 4 avatar flags so Chrome uses the
   * v4l2loopback virtual camera as its getUserMedia video source:
   *
   *   --use-fake-device-for-media-stream
   *   --use-file-for-fake-video-capture=<avatarDevicePath>
   *
   * Chromium on Linux accepts a v4l2 character-device path in place of a
   * file when the loopback driver is loaded with `exclusive_caps=1` — see
   * PR 2's host-setup docs in `skills/meet-join/bot/README.md`.
   *
   * Defaults to `false`, which preserves the pre-PR-3 argv byte-for-byte.
   */
  avatarEnabled?: boolean;
  /**
   * Absolute path to the v4l2loopback character-device node consumed when
   * `avatarEnabled` is true. Defaults to {@link DEFAULT_AVATAR_DEVICE_PATH}
   * (`/dev/video10`), matching PR 2's `DEFAULT_VIDEO_DEVICE_PATH` in
   * `src/media/video-device.ts` and the CLI's `VELLUM_MEET_AVATAR_DEVICE`
   * default (see `cli/src/lib/docker.ts:resolveMeetAvatarDevicePath`).
   * Only consulted when `avatarEnabled` is true.
   */
  avatarDevicePath?: string;
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

/**
 * Default v4l2loopback device path consumed when `avatarEnabled` is true.
 *
 * Kept as a local constant rather than imported from
 * `src/media/video-device.ts` so the launcher stays independent of the
 * video-device module's `node:fs` / `v4l2-ctl` surface. The two modules
 * must agree on the string; see {@link LaunchChromeOptions.avatarDevicePath}
 * and `DEFAULT_VIDEO_DEVICE_PATH` in `video-device.ts` for the mirror.
 */
export const DEFAULT_AVATAR_DEVICE_PATH = "/dev/video10";

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
 *
 * Avatar mode (Phase 4 PR 3): when `avatarEnabled` is true, two extra
 * flags are inserted immediately after the always-on
 * `--use-fake-ui-for-media-stream` so the camera-source toggles live
 * adjacent to the permission-prompt toggle. The insertion is at a fixed
 * position rather than the tail so the argv shape stays deterministic
 * regardless of the meeting URL. When `avatarEnabled` is false, the argv
 * is byte-identical to the pre-PR-3 baseline.
 */
function buildChromeArgs(opts: {
  meetingUrl: string;
  extensionPath: string;
  userDataDir: string;
  avatarEnabled: boolean;
  avatarDevicePath: string;
}): string[] {
  const avatarArgs = opts.avatarEnabled
    ? [
        "--use-fake-device-for-media-stream",
        `--use-file-for-fake-video-capture=${opts.avatarDevicePath}`,
      ]
    : [];
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
    ...avatarArgs,
    "--enable-logging=stderr",
    "--v=0",
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
  const chromeBinary = opts.chromeBinary ?? "/usr/bin/chromium";
  const logger = opts.logger ?? NOOP_LOGGER;
  const spawnFn = opts.spawn ?? nodeSpawn;
  const sigkillGraceMs = opts.sigkillGraceMs ?? DEFAULT_SIGKILL_GRACE_MS;

  const args = buildChromeArgs({
    meetingUrl: opts.meetingUrl,
    extensionPath: opts.extensionPath,
    userDataDir: opts.userDataDir,
    avatarEnabled: opts.avatarEnabled === true,
    avatarDevicePath: opts.avatarDevicePath ?? DEFAULT_AVATAR_DEVICE_PATH,
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
