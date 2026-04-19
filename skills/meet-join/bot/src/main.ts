/**
 * meet-bot entry point.
 *
 * Bootstrap sequence for the container-side process that joins a Google
 * Meet on behalf of an assistant. The boot path is deliberately linear:
 *
 *   1. Bring up PulseAudio virtual devices (null-sinks + virtual source).
 *      Skipped under `SKIP_PULSE=1` so the boot smoke test can run on
 *      macOS developer machines.
 *   2. Start Xvfb (virtual display) for Chrome to render into.
 *   3. Start the NMH Unix-socket server the extension's native-messaging
 *      shim will connect to.
 *   4. Launch google-chrome-stable as a plain user process with the
 *      controller extension loaded via `--load-extension`. Chrome must NOT
 *      be driven via CDP — Meet's bot detection rejects CDP-attached
 *      joiners. Extension-side DOM work happens via Chrome Native
 *      Messaging rather than via any CDP-based automation library.
 *   5. Instantiate `DaemonClient` and wait for the extension handshake
 *      (`{ type: "ready" }`) to land on the socket server.
 *   6. Publish `lifecycle:joining` and send the `join` command to the
 *      extension over the socket. The extension drives the Meet prejoin
 *      UI and, on success, emits `lifecycle:joined` over the same pipe —
 *      which we forward to the daemon client.
 *   7. Start the audio capture pipeline (`startAudioCapture`) so PCM is
 *      shipped to the daemon over the Unix socket.
 *   8. Stand up the HTTP control surface so the daemon can issue `/leave`,
 *      `/send_chat` (routes through the socket with requestId correlation),
 *      `/play_audio` (Phase 3).
 *
 * `SIGTERM`, `SIGINT`, and an inbound `POST /leave` all converge on a
 * single graceful-shutdown path. We guard against re-entry so multiple
 * signals or an API-triggered leave overlapping with SIGTERM can't
 * double-stop the subsystems.
 *
 * Failures in the boot path publish a `lifecycle:error` to the daemon
 * (best-effort — the daemon client may not be up yet), flush, and
 * `process.exit(1)`.
 *
 * ## Testability
 *
 * Every subsystem is injected through `runBot(deps)` so the main-test
 * suite can verify the boot order, the shutdown order, and the error
 * paths without touching PulseAudio / Xvfb / Chrome / real sockets.
 * `defaultDeps()` returns the real wiring; `runBot(defaultDeps())` is
 * what `void main()` invokes at the bottom of this file.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

import type {
  LifecycleEvent,
  LifecycleState,
  MeetBotEvent,
} from "../../contracts/index.js";
import type {
  BotToExtensionMessage,
  ExtensionToBotMessage,
} from "../../contracts/native-messaging.js";

import {
  launchChrome,
  type ChromeProcessHandle,
  type LaunchChromeOptions,
} from "./browser/chrome-launcher.js";
import { startXvfb, stopXvfb, type XvfbHandle } from "./browser/xvfb.js";
import { DaemonClient } from "./control/daemon-client.js";
import {
  createHttpServer,
  type HttpServerCallbacks,
  type HttpServerHandle,
} from "./control/http-server.js";
import { BotState } from "./control/state.js";
import {
  startAudioCapture,
  type AudioCaptureHandle,
  type AudioCaptureOptions,
} from "./media/audio-capture.js";
import { setupPulseAudio } from "./media/pulse.js";
import {
  createNmhSocketServer,
  type NmhSocketServer,
  type NmhSocketServerOptions,
} from "./native-messaging/socket-server.js";

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------

/**
 * Runtime configuration pulled from the environment. `main.ts` reads the
 * env once at top of `runBot` so tests can pass their own config through
 * `deps.env()` without mutating `process.env`.
 */
interface BotEnv {
  meetUrl: string | undefined;
  meetingId: string | undefined;
  joinName: string | undefined;
  consentMessage: string | undefined;
  daemonUrl: string | undefined;
  botApiToken: string | undefined;
  /** Directory containing `audio.sock` — defaults to `/sockets`. */
  socketDir: string;
  /** When "1", skip PulseAudio setup — used by the boot smoke test. */
  skipPulse: boolean;
  /** Bind port for the HTTP control surface. Defaults to 3000. */
  httpPort: number;
  /** Absolute path to the loaded Chrome extension directory. */
  extensionPath: string;
  /** Unix socket path the NMH shim connects to. */
  nmhSocketPath: string;
  /** X display string Xvfb listens on. */
  xvfbDisplay: string;
  /** User-data directory root for Chrome — suffixed with meetingId per launch. */
  chromeUserDataRoot: string;
}

function readEnv(env: NodeJS.ProcessEnv = process.env): BotEnv {
  return {
    meetUrl: env.MEET_URL,
    meetingId: env.MEETING_ID,
    joinName: env.JOIN_NAME,
    consentMessage: env.CONSENT_MESSAGE,
    daemonUrl: env.DAEMON_URL,
    botApiToken: env.BOT_API_TOKEN,
    socketDir: env.SOCKET_DIR ?? "/sockets",
    skipPulse: env.SKIP_PULSE === "1",
    httpPort: env.HTTP_PORT ? Number(env.HTTP_PORT) : 3000,
    extensionPath: env.EXTENSION_PATH ?? "/app/ext",
    nmhSocketPath: env.NMH_SOCKET_PATH ?? "/run/nmh.sock",
    xvfbDisplay: env.XVFB_DISPLAY ?? ":99",
    chromeUserDataRoot: env.CHROME_USER_DATA_ROOT ?? "/tmp/chrome-profile",
  };
}

// ---------------------------------------------------------------------------
// Dep injection
// ---------------------------------------------------------------------------

/**
 * Factories the main wiring calls through. Keeping them on a single
 * `BotDeps` object lets tests override any subset with mocks while
 * leaving the rest at their real implementations.
 */
export interface BotDeps {
  env: () => BotEnv;
  setupPulseAudio: () => Promise<void>;
  /** Start Xvfb on the requested display. */
  startXvfb: (display: string) => Promise<XvfbHandle>;
  /** Tear down an Xvfb handle. */
  stopXvfb: (handle: XvfbHandle) => Promise<void>;
  /** Create (but do not start) the NMH socket server. */
  createNmhSocketServer: (opts: NmhSocketServerOptions) => NmhSocketServer;
  /** Spawn google-chrome-stable. Returns a handle with exitPromise + stop. */
  launchChrome: (opts: LaunchChromeOptions) => Promise<ChromeProcessHandle>;
  startAudioCapture: (opts: AudioCaptureOptions) => Promise<AudioCaptureHandle>;
  createDaemonClient: (opts: {
    daemonUrl: string;
    meetingId: string;
    botApiToken: string;
    onError: (err: Error) => void;
  }) => DaemonClientLike;
  createHttpServer: (
    opts: HttpServerCallbacks & { apiToken: string },
  ) => HttpServerHandle;
  /**
   * Ensure a directory exists (recursive). Exposed as a dep so tests can
   * intercept filesystem writes — prod calls `fs.mkdirSync(..., recursive: true)`.
   */
  ensureDir: (path: string) => void;
  /**
   * Signal handler hooks. The test harness stubs these out so the
   * Bun/Node signal machinery isn't wired up during unit tests.
   */
  onSignal: (signal: "SIGTERM" | "SIGINT", handler: () => void) => () => void;
  /**
   * Short settle delay between `lifecycle:joining` and `lifecycle:joined`.
   * Retained as a dep for backward-compat with tests that pass 0.
   */
  joinedSettleMs: number;
  /** Sleep shim — tests can substitute a tick-accurate implementation. */
  sleep: (ms: number) => Promise<void>;
  /** Process exit — overridable so tests don't actually terminate. */
  exit: (code: number) => never;
  /** Logger — routed to console in production. Keep separate hooks so tests can capture. */
  logInfo: (msg: string) => void;
  logError: (msg: string) => void;
  /** Milliseconds to wait for the extension's `ready` handshake. */
  extensionReadyTimeoutMs: number;
  /**
   * Milliseconds to wait for the extension to reach `lifecycle:joined` (or
   * emit `lifecycle:error`) after the bot dispatches the `join` command.
   * If nothing arrives in this window, assume Chrome never landed on a
   * Meet tab (restore-session dialog, redirect loop, non-Meet URL, etc.)
   * and shut down with `lifecycle:error` rather than sitting in
   * `phase=joining` indefinitely.
   *
   * The default (120s) gives the prejoin flow enough slack for the Meet
   * "ask to join" → host admission cycle, on top of the separate 30s
   * `extensionReadyTimeoutMs` that bounds the earlier handshake.
   */
  extensionJoinedTimeoutMs: number;
  /** Milliseconds before a `send_chat` request times out with a failure. */
  sendChatTimeoutMs: number;
  /** Grace period after sending `leave` for the extension to animate out. */
  leaveGraceMs: number;
  /** Factory for correlation ids on outbound `send_chat` commands. */
  generateRequestId: () => string;
}

/** Minimal slice of `DaemonClient` the main wiring depends on. */
export interface DaemonClientLike {
  enqueue(event: MeetBotEvent): void;
  flush(): Promise<void>;
  stop(): Promise<void>;
}

/** Real wiring — every factory forwards to the imported implementation. */
export function defaultDeps(): BotDeps {
  return {
    env: () => readEnv(process.env),
    setupPulseAudio,
    startXvfb,
    stopXvfb,
    createNmhSocketServer: (opts) => createNmhSocketServer(opts),
    launchChrome: (opts) => launchChrome(opts),
    startAudioCapture,
    createDaemonClient: (opts) =>
      new DaemonClient({
        daemonUrl: opts.daemonUrl,
        meetingId: opts.meetingId,
        botApiToken: opts.botApiToken,
        onError: (err) => opts.onError(err),
      }),
    createHttpServer,
    ensureDir: (path) => mkdirSync(path, { recursive: true }),
    onSignal: (signal, handler) => {
      process.on(signal, handler);
      return () => {
        process.off(signal, handler);
      };
    },
    joinedSettleMs: 2_000,
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    exit: (code) => process.exit(code),
    logInfo: (msg) => console.log(msg),
    logError: (msg) => console.error(msg),
    extensionReadyTimeoutMs: 30_000,
    extensionJoinedTimeoutMs: 120_000,
    sendChatTimeoutMs: 10_000,
    leaveGraceMs: 2_000,
    generateRequestId: () => randomUUID(),
  };
}

// ---------------------------------------------------------------------------
// runBot
// ---------------------------------------------------------------------------

/** Publish a lifecycle event, falling back to a log if no client is up yet. */
function publishLifecycle(
  client: DaemonClientLike | null,
  meetingId: string,
  state: LifecycleState,
  deps: BotDeps,
  detail?: string,
): void {
  if (!client) {
    deps.logError(
      `meet-bot: lifecycle:${state} (no daemon client yet)${detail ? `: ${detail}` : ""}`,
    );
    return;
  }
  const event: LifecycleEvent = {
    type: "lifecycle",
    meetingId,
    timestamp: new Date().toISOString(),
    state,
    ...(detail !== undefined ? { detail } : {}),
  };
  client.enqueue(event);
}

/**
 * Boot the meet-bot. Returns a promise that settles when the bot has
 * exited the meeting cleanly. In production the top-level `main()` at
 * the bottom of this file kicks it off and wires the real subsystems.
 * Tests call it directly with their own `deps`.
 */
export async function runBot(deps: BotDeps): Promise<void> {
  const env = deps.env();

  // -------------------------------------------------------------------------
  // Step 0 — PulseAudio (unless skipped).
  // -------------------------------------------------------------------------

  if (!env.skipPulse) {
    try {
      await deps.setupPulseAudio();
    } catch (err) {
      deps.logError(`meet-bot: PulseAudio setup failed: ${errMsg(err)}`);
      deps.exit(1);
      return; // unreachable in production but keeps TS happy in tests.
    }
  }

  deps.logInfo("meet-bot booted");

  // -------------------------------------------------------------------------
  // Smoke-test short-circuit.
  //
  // The boot smoke test (`boot.test.ts`) runs the package with `SKIP_PULSE=1`
  // and no MEET_URL; it just needs to see the boot marker and exit 0. Any
  // missing required env falls into the same "bail out cleanly" bucket — we
  // only enter full wiring when EVERY value is set.
  // -------------------------------------------------------------------------

  const hasFullEnv =
    env.meetUrl &&
    env.meetingId &&
    env.joinName &&
    env.consentMessage &&
    env.daemonUrl &&
    env.botApiToken;

  if (!hasFullEnv) {
    return;
  }

  // TypeScript narrowing — `hasFullEnv` already verified these.
  const meetingId = env.meetingId!;
  const joinName = env.joinName!;
  const consentMessage = env.consentMessage!;
  const daemonUrl = env.daemonUrl!;
  const botApiToken = env.botApiToken!;
  const meetUrl = env.meetUrl!;

  BotState.setMeeting(meetingId);

  // Shared shutdown state — read by signal handlers, `/leave`, and boot
  // error paths. We construct it up-front so the error-reporting path can
  // still produce a usable shutdown even if the daemon client never gets
  // instantiated.
  type Subsystems = {
    xvfb: XvfbHandle | null;
    socketServer: NmhSocketServer | null;
    chrome: ChromeProcessHandle | null;
    daemonClient: DaemonClientLike | null;
    audioCapture: AudioCaptureHandle | null;
    httpServer: HttpServerHandle | null;
  };
  const subsystems: Subsystems = {
    xvfb: null,
    socketServer: null,
    chrome: null,
    daemonClient: null,
    audioCapture: null,
    httpServer: null,
  };

  // Pending `send_chat` requests, correlated by requestId so the extension's
  // `send_chat_result` can resolve the awaiting HTTP route.
  const pendingSendChat = new Map<
    string,
    {
      resolve: () => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  // Dedup guard: signals, HTTP /leave, daemon-error flaps, and boot errors
  // can all race to trigger shutdown. Only the first one wins.
  let shutdownInProgress = false;
  let shutdownDonePromise: Promise<void> | null = null;

  // Timer armed after `join` is dispatched that trips shutdown if the
  // extension never reaches `lifecycle:joined` / `lifecycle:error`. Cleared
  // from the lifecycle-message handler and on shutdown. See the timer
  // setup site below for full rationale.
  let extensionJoinedTimer: ReturnType<typeof setTimeout> | null = null;
  const clearExtensionJoinedTimer = (): void => {
    if (extensionJoinedTimer) {
      clearTimeout(extensionJoinedTimer);
      extensionJoinedTimer = null;
    }
  };

  /**
   * Graceful shutdown. Tears down subsystems in the reverse order of
   * startup: HTTP → tell the extension to leave → Chrome → audio →
   * Xvfb → socket server → daemon client (flushed last so
   * `lifecycle:left`/`error` is delivered). Safe to call multiple times.
   */
  async function shutdown(
    finalState: "left" | "error",
    detail?: string,
  ): Promise<void> {
    if (shutdownInProgress && shutdownDonePromise) {
      await shutdownDonePromise;
      return;
    }
    shutdownInProgress = true;
    shutdownDonePromise = (async () => {
      BotState.setPhase(finalState === "error" ? "error" : "leaving");

      // Any in-flight join-deadline timer is now moot.
      clearExtensionJoinedTimer();

      // Reject any pending send_chat promises so the HTTP handlers unblock
      // with a clear error rather than hanging until their own timer fires.
      for (const [requestId, pending] of pendingSendChat.entries()) {
        clearTimeout(pending.timer);
        pending.reject(
          new Error(`send_chat: bot shutting down (requestId=${requestId})`),
        );
      }
      pendingSendChat.clear();

      /** Run a subsystem teardown without letting its failure poison the rest. */
      const stopSafely = async (
        label: string,
        fn: (() => void | Promise<void>) | null,
      ): Promise<void> => {
        if (!fn) return;
        try {
          await fn();
        } catch (err) {
          deps.logError(`meet-bot: ${label} stop failed: ${errMsg(err)}`);
        }
      };

      // Teardown order (reverse of boot):
      //   1. HTTP first so no new commands arrive.
      //   2. Best-effort `leave` to the extension so it animates out.
      //   3. Chrome (SIGTERM → SIGKILL after 5s).
      //   4. Audio capture (parec sees EOF before Pulse tears down).
      //   5. Xvfb (no more rendering to do).
      //   6. Socket server (closes the listener, unlinks the socket).
      //   7. Daemon client (flushed last so the terminal lifecycle event
      //      gets delivered).
      await stopSafely(
        "http server",
        subsystems.httpServer
          ? () => subsystems.httpServer!.stop()
          : null,
      );
      // Send `leave` best-effort; swallow errors because the extension
      // may already be gone. Give it a short grace period to animate out.
      if (subsystems.socketServer) {
        try {
          subsystems.socketServer.sendToExtension({
            type: "leave",
            reason: detail ?? (finalState === "error" ? "error" : "shutdown"),
          });
          await deps.sleep(deps.leaveGraceMs);
        } catch (err) {
          // Extension may already be disconnected; fine.
          deps.logError(
            `meet-bot: leave command to extension failed: ${errMsg(err)}`,
          );
        }
      }
      await stopSafely(
        "chrome",
        subsystems.chrome ? () => subsystems.chrome!.stop() : null,
      );
      await stopSafely(
        "audio capture",
        subsystems.audioCapture
          ? () => subsystems.audioCapture!.stop()
          : null,
      );
      await stopSafely(
        "xvfb",
        subsystems.xvfb ? () => deps.stopXvfb(subsystems.xvfb!) : null,
      );
      await stopSafely(
        "socket server",
        subsystems.socketServer
          ? () => subsystems.socketServer!.stop()
          : null,
      );

      publishLifecycle(
        subsystems.daemonClient,
        meetingId,
        finalState,
        deps,
        detail,
      );
      await stopSafely(
        "daemon client",
        subsystems.daemonClient
          ? () => subsystems.daemonClient!.stop()
          : null,
      );

      BotState.setPhase(finalState);
    })();

    await shutdownDonePromise;
  }

  // Signal handlers — any arriving signal triggers shutdown once.
  const detachSigterm = deps.onSignal("SIGTERM", () => {
    void shutdown("left", "SIGTERM").then(() => deps.exit(0));
  });
  const detachSigint = deps.onSignal("SIGINT", () => {
    void shutdown("left", "SIGINT").then(() => deps.exit(0));
  });

  // Terminal-error handler for the daemon client. `DaemonClient.onError`
  // fires when a batch is rejected with a 4xx or when retries are
  // exhausted for a 5xx / network failure. Either way the events in that
  // batch are lost. We can't recover them, but we MUST NOT keep the bot
  // "joined" while silently dropping every subsequent event — so after
  // the first failure we log and arm a 30s window; a second failure
  // inside that window trips a graceful shutdown with state "error".
  //
  // A single transient flap (one 5xx burst that outlasts the retry
  // budget) is tolerable; two in a row is a structural problem.
  const DAEMON_ERROR_WINDOW_MS = 30_000;
  let firstDaemonErrorAt: number | null = null;
  const onDaemonTerminalError = (err: Error): void => {
    deps.logError(`meet-bot: daemon ingress failure: ${err.message}`);
    const now = Date.now();
    if (
      firstDaemonErrorAt !== null &&
      now - firstDaemonErrorAt <= DAEMON_ERROR_WINDOW_MS
    ) {
      deps.logError(
        "meet-bot: daemon ingress failing repeatedly; shutting down",
      );
      void shutdown("error", `daemon ingress failure: ${err.message}`).then(
        () => {
          detachSigterm();
          detachSigint();
          deps.exit(1);
        },
      );
      return;
    }
    firstDaemonErrorAt = now;
  };

  // Everything below this line — PulseAudio is already up. On any thrown
  // error we publish `lifecycle:error`, drain the daemon client, and
  // exit 1.
  try {
    BotState.setPhase("joining");

    // ---------------------------------------------------------------------
    // Step 2 — Xvfb.
    // ---------------------------------------------------------------------
    subsystems.xvfb = await deps.startXvfb(env.xvfbDisplay);

    // ---------------------------------------------------------------------
    // Step 3 — NMH socket server.
    //
    // Ensure the socket's parent directory exists and the Chrome user-data
    // directory is ready before spawning anything. The socket lives under
    // `/run/` in production which may not exist in all base images.
    // ---------------------------------------------------------------------
    const socketDir = dirname(env.nmhSocketPath);
    deps.ensureDir(socketDir);

    const userDataDir = `${env.chromeUserDataRoot}-${meetingId}`;
    deps.ensureDir(userDataDir);

    subsystems.socketServer = deps.createNmhSocketServer({
      socketPath: env.nmhSocketPath,
      logger: {
        info: (m) => deps.logInfo(m),
        warn: (m) => deps.logError(m),
      },
    });

    // Inbound messages from the extension. This single handler routes every
    // validated frame: lifecycle + telemetry forward to the daemon,
    // diagnostics get logged, send_chat_result completes pending HTTP
    // requests. The `ready` handshake is handled separately by
    // `socketServer.waitForReady`; we log it here too for visibility.
    subsystems.socketServer.onExtensionMessage((msg) =>
      handleExtensionMessage(msg),
    );

    await subsystems.socketServer.start();

    // ---------------------------------------------------------------------
    // Step 4 — daemon client.
    //
    // Instantiate BEFORE Chrome + extension so any lifecycle events the
    // extension produces during early join can be forwarded to the daemon
    // immediately.
    // ---------------------------------------------------------------------
    subsystems.daemonClient = deps.createDaemonClient({
      daemonUrl,
      meetingId,
      botApiToken,
      onError: onDaemonTerminalError,
    });

    // ---------------------------------------------------------------------
    // Step 5 — Chrome.
    //
    // The handle's `exitPromise` is watched below; if Chrome dies before
    // we've intentionally shut down, treat it as an unexpected failure.
    // ---------------------------------------------------------------------
    subsystems.chrome = await deps.launchChrome({
      meetingUrl: meetUrl,
      displayNumber: env.xvfbDisplay,
      extensionPath: env.extensionPath,
      userDataDir,
      logger: {
        info: (m) => deps.logInfo(m),
        error: (m) => deps.logError(m),
      },
    });

    // Watch for an unexpected Chrome exit. If Chrome dies on its own before
    // the bot has decided to shut down, we escalate to an error shutdown.
    void subsystems.chrome.exitPromise.then((code) => {
      if (shutdownInProgress) return;
      void shutdown("error", `chrome exited unexpectedly with code ${code}`).then(
        () => {
          detachSigterm();
          detachSigint();
          deps.exit(1);
        },
      );
    });

    // ---------------------------------------------------------------------
    // Step 6 — wait for the extension, then issue `join`.
    // ---------------------------------------------------------------------
    try {
      await subsystems.socketServer.waitForReady(deps.extensionReadyTimeoutMs);
    } catch (err) {
      const msg = errMsg(err);
      deps.logError(`meet-bot: ${msg}`);
      await shutdown("error", `extension never signaled ready: ${msg}`);
      detachSigterm();
      detachSigint();
      deps.exit(1);
      return;
    }

    // Publish `lifecycle:joining` directly so the daemon sees the transition
    // even if the extension's own `joining` message is delayed by tab load.
    publishLifecycle(subsystems.daemonClient, meetingId, "joining", deps);

    try {
      subsystems.socketServer.sendToExtension({
        type: "join",
        meetingUrl: meetUrl,
        displayName: joinName,
        consentMessage,
      });
    } catch (err) {
      const msg = errMsg(err);
      deps.logError(`meet-bot: failed to send join to extension: ${msg}`);
      await shutdown("error", `failed to send join to extension: ${msg}`);
      detachSigterm();
      detachSigint();
      deps.exit(1);
      return;
    }

    // Arm the extension-joined deadline. `waitForReady` guarantees the
    // extension is alive, but it doesn't guarantee Chrome actually landed
    // on a Meet tab — a restore-session dialog or a redirect loop leaves
    // the content script unmounted and the background bridge silently
    // drops the `join` relay. Without this timer the bot would sit in
    // `phase=joining` indefinitely. The lifecycle message handler clears
    // `extensionJoinedTimer` on `joined` / `error`; the clear is idempotent
    // so repeated events are safe.
    extensionJoinedTimer = setTimeout(() => {
      if (shutdownInProgress) return;
      const detail = `extension did not reach joined state within ${deps.extensionJoinedTimeoutMs}ms`;
      deps.logError(`meet-bot: ${detail}`);
      void shutdown("error", detail).then(() => {
        detachSigterm();
        detachSigint();
        deps.exit(1);
      });
    }, deps.extensionJoinedTimeoutMs);

    // Short settle before wiring up the audio pipeline so the page has a
    // moment to render after admission. The extension will emit its own
    // `lifecycle:joined` which we forward; this sleep only keeps historical
    // test timing semantics (`joinedSettleMs`) intact.
    await deps.sleep(deps.joinedSettleMs);

    // ---------------------------------------------------------------------
    // Step 7 — audio capture.
    // ---------------------------------------------------------------------
    subsystems.audioCapture = await deps.startAudioCapture({
      socketPath: `${env.socketDir}/audio.sock`,
    });

    // ---------------------------------------------------------------------
    // Step 8 — HTTP control surface.
    // ---------------------------------------------------------------------
    subsystems.httpServer = deps.createHttpServer({
      apiToken: botApiToken,
      onLeave: (reason) => {
        void shutdown("left", reason ?? "api:/leave").then(() => {
          detachSigterm();
          detachSigint();
          deps.exit(0);
        });
      },
      onSendChat: (text) => sendChatViaExtension(text),
      onPlayAudio: () => {
        // Phase 3 will replace the 501 stub with a real implementation.
      },
    });
    await subsystems.httpServer.start(env.httpPort);

    deps.logInfo(`meet-bot ready (meetingId=${meetingId})`);
  } catch (err) {
    const msg = errMsg(err);
    deps.logError(`meet-bot: boot failed: ${msg}`);
    await shutdown("error", msg);
    detachSigterm();
    detachSigint();
    deps.exit(1);
  }

  // -------------------------------------------------------------------------
  // Helpers defined in-scope so they capture the subsystems / pending map.
  // -------------------------------------------------------------------------

  /**
   * Route a single validated inbound message from the extension. Lifecycle
   * + telemetry forward to the daemon, diagnostics get logged, and
   * `send_chat_result` completes the pending HTTP request.
   */
  function handleExtensionMessage(msg: ExtensionToBotMessage): void {
    switch (msg.type) {
      case "ready":
        deps.logInfo(`meet-bot: extension ready (version=${msg.extensionVersion})`);
        return;
      case "lifecycle": {
        const state: LifecycleState = msg.state;
        // Drive local bot-state on `joined` / terminal states; the
        // `joining` emitted by the extension is informational — we already
        // set BotState before `waitForReady` returned.
        if (state === "joined") BotState.setPhase("joined");
        if (state === "error") BotState.setPhase("error");
        if (state === "left") BotState.setPhase("leaving");
        // Clear the extension-joined deadline as soon as the extension
        // reaches a terminal post-prejoin state. Idempotent.
        if (state === "joined" || state === "error") {
          clearExtensionJoinedTimer();
        }
        // Rewrite meetingId to the authoritative UUID from env. The
        // extension derives its `meetingId` from `location.pathname` (the
        // Meet URL code, e.g. `abc-defg-hij`), but the daemon keys
        // sessions by the UUID passed via `MEETING_ID` env. Stamping here
        // at the bot boundary keeps the extension simple while ensuring
        // every daemon-facing event correlates to the correct session.
        publishLifecycle(
          subsystems.daemonClient,
          meetingId,
          state,
          deps,
          msg.detail,
        );
        return;
      }
      case "participant.change":
      case "speaker.change":
      case "chat.inbound":
        // Belt-and-suspenders: overwrite meetingId with the authoritative
        // UUID before forwarding. See lifecycle case above for rationale.
        if (subsystems.daemonClient) {
          subsystems.daemonClient.enqueue({ ...msg, meetingId });
        }
        return;
      case "diagnostic":
        if (msg.level === "error") deps.logError(`[ext] ${msg.message}`);
        else deps.logInfo(`[ext] ${msg.message}`);
        return;
      case "send_chat_result": {
        const pending = pendingSendChat.get(msg.requestId);
        if (!pending) {
          // Late reply for a request we already gave up on, or a fabricated
          // requestId. Log and drop.
          deps.logError(
            `meet-bot: send_chat_result for unknown requestId=${msg.requestId}`,
          );
          return;
        }
        clearTimeout(pending.timer);
        pendingSendChat.delete(msg.requestId);
        if (msg.ok) {
          pending.resolve();
        } else {
          pending.reject(
            new Error(
              msg.error
                ? `send_chat failed: ${msg.error}`
                : "send_chat failed (extension did not provide a reason)",
            ),
          );
        }
        return;
      }
    }
  }

  /**
   * Dispatch a `send_chat` command to the extension and wait for the
   * matching `send_chat_result`. Resolves on `ok: true`, rejects on
   * `ok: false` or on a 10s timeout. Called from the HTTP `/send_chat`
   * route.
   */
  async function sendChatViaExtension(text: string): Promise<void> {
    if (!subsystems.socketServer) {
      throw new Error("send_chat: socket server not started");
    }
    const requestId = deps.generateRequestId();
    const waitForResult = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingSendChat.delete(requestId);
        reject(
          new Error(
            `send_chat: extension did not reply within ${deps.sendChatTimeoutMs}ms (requestId=${requestId})`,
          ),
        );
      }, deps.sendChatTimeoutMs);
      pendingSendChat.set(requestId, { resolve, reject, timer });
    });

    const cmd: BotToExtensionMessage = {
      type: "send_chat",
      text,
      requestId,
    };
    try {
      subsystems.socketServer.sendToExtension(cmd);
    } catch (err) {
      const pending = pendingSendChat.get(requestId);
      if (pending) {
        clearTimeout(pending.timer);
        pendingSendChat.delete(requestId);
      }
      throw err;
    }
    await waitForResult;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Top-level invocation
// ---------------------------------------------------------------------------
//
// Skip under `import.meta.main` so test files that `import { runBot }` from
// this module don't kick off the real bot when loaded.

if (import.meta.main) {
  void runBot(defaultDeps()).catch((err) => {
    console.error("meet-bot failed:", err);
    process.exit(1);
  });
}
