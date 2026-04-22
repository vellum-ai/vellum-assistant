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
  trustedTypeKillTimeoutMs,
  trustedTypeReplyTimeoutMs,
} from "../../contracts/native-messaging.js";

import {
  launchChrome,
  type ChromeProcessHandle,
  type LaunchChromeOptions,
} from "./browser/chrome-launcher.js";
import { xdotoolClick } from "./browser/xdotool-click.js";
import { xdotoolType } from "./browser/xdotool-type.js";
import { startXvfb, stopXvfb, type XvfbHandle } from "./browser/xvfb.js";
import { DaemonClient } from "./control/daemon-client.js";
import {
  createHttpServer,
  type HttpServerAvatarOptions,
  type HttpServerCallbacks,
  type HttpServerHandle,
} from "./control/http-server.js";
import { BotState } from "./control/state.js";
// Importing the avatar barrel has the side effect of registering the noop
// factory and the TalkingHead.js factory. Individual renderer-backend PRs
// extend this list with their own side-effect imports.
import {
  AvatarRendererUnavailableError,
  resolveAvatarRenderer,
  type AvatarConfig,
  type AvatarNativeMessagingSender,
} from "./media/avatar/index.js";
import {
  startAudioCapture,
  type AudioCaptureHandle,
  type AudioCaptureOptions,
} from "./media/audio-capture.js";
import { setupPulseAudio } from "./media/pulse.js";
import {
  createCameraChannel,
  type CameraChannel,
} from "./native-messaging/camera-channel.js";
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
  /**
   * Host to dial for the daemon's audio-ingest TCP port. Defaults to
   * `host.docker.internal` — the alias Docker sets via `ExtraHosts` so the
   * bot can reach its parent daemon on the host.
   */
  daemonAudioHost: string;
  /**
   * TCP port the daemon's audio-ingest server is listening on. Required —
   * the session manager picks an ephemeral port and threads it through so
   * multiple bots can coexist without colliding on a fixed port.
   */
  daemonAudioPort: number | undefined;
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
  /**
   * Phase 4 avatar opt-in. `AVATAR_ENABLED=1` (or a common truthy
   * synonym — `true`, `yes`, `on`) threads the v4l2loopback camera flags
   * through to {@link launchChrome}. Absent or any non-truthy value falls
   * back to the Phase 1 launcher argv byte-for-byte. The session manager
   * in the daemon sets this env on the bot container when the assistant
   * has the Meet avatar feature enabled.
   */
  avatarEnabled: boolean;
  /**
   * Phase 4 renderer selector. Defaults to `"noop"` (safe fallback)
   * when unset. Drives which factory the registry resolves when the
   * daemon calls `/avatar/enable`. The session-manager sets this env
   * from `services.meet.avatar.renderer` on the bot container.
   */
  avatarRenderer: string;
  /**
   * Optional JSON-encoded avatar-config bundle. The session-manager
   * serializes the fully-resolved `services.meet.avatar.*` block (with
   * vault-resolved credentials substituted in) and passes it as a
   * single env var so the bot can hand the whole thing to each
   * renderer factory without having to juggle a dozen env vars.
   */
  avatarConfigJson: string | undefined;
  /**
   * Explicit device-path override. Mirrors
   * `services.meet.avatar.devicePath` from the daemon config. When
   * unset, the bot falls back to `/dev/video10` (the default
   * {@link launchChrome} also uses).
   */
  avatarDevicePath: string | undefined;
}

/**
 * Parse a truthy env value. Accepts `"1"`, `"true"`, `"yes"`, `"on"`
 * (case-insensitive, trimmed). Anything else — including `undefined`,
 * `"0"`, `"false"`, `"no"`, `"off"`, and empty strings — is false.
 * Kept deliberately narrow so an accidental leading/trailing space or an
 * operator typing `AVATAR_ENABLED=true` both flip the same switch as
 * `AVATAR_ENABLED=1`.
 */
function parseBooleanEnv(raw: string | undefined): boolean {
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
}

function readEnv(env: NodeJS.ProcessEnv = process.env): BotEnv {
  return {
    meetUrl: env.MEET_URL,
    meetingId: env.MEETING_ID,
    joinName: env.JOIN_NAME,
    consentMessage: env.CONSENT_MESSAGE,
    daemonUrl: env.DAEMON_URL,
    botApiToken: env.BOT_API_TOKEN,
    daemonAudioHost: env.DAEMON_AUDIO_HOST ?? "host.docker.internal",
    daemonAudioPort: env.DAEMON_AUDIO_PORT
      ? Number(env.DAEMON_AUDIO_PORT)
      : undefined,
    skipPulse: env.SKIP_PULSE === "1",
    httpPort: env.HTTP_PORT ? Number(env.HTTP_PORT) : 3000,
    extensionPath: env.EXTENSION_PATH ?? "/app/ext",
    nmhSocketPath: env.NMH_SOCKET_PATH ?? "/run/nmh.sock",
    xvfbDisplay: env.XVFB_DISPLAY ?? ":99",
    chromeUserDataRoot: env.CHROME_USER_DATA_ROOT ?? "/tmp/chrome-profile",
    avatarEnabled: parseBooleanEnv(env.AVATAR_ENABLED),
    avatarRenderer: env.AVATAR_RENDERER ?? "noop",
    avatarConfigJson: env.AVATAR_CONFIG_JSON,
    avatarDevicePath: env.AVATAR_DEVICE_PATH,
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
  /** Spawn chromium. Returns a handle with exitPromise + stop. */
  launchChrome: (opts: LaunchChromeOptions) => Promise<ChromeProcessHandle>;
  /**
   * Dispatch a real X-server click at the given screen coordinates. Used to
   * clear Meet's `event.isTrusted` gate on the prejoin admission button.
   * See `browser/xdotool-click.ts` for rationale.
   */
  xdotoolClick: (opts: {
    x: number;
    y: number;
    display: string;
  }) => Promise<void>;
  /**
   * Type text via real X-server keystrokes into whatever is currently
   * focused on the Xvfb display. Used as belt-and-suspenders for the
   * chat composer when Meet gates input on `event.isTrusted === true`.
   * The extension is responsible for focusing the right element before
   * emitting `trusted_type`. See `browser/xdotool-type.ts` for rationale.
   */
  xdotoolType: (opts: {
    text: string;
    display: string;
    delayMs?: number;
    /**
     * Per-call kill timeout. When omitted, `xdotool-type.ts` falls back to
     * its own default (which does NOT scale with text length). The
     * `trusted_type` handler below computes a scaled value via
     * {@link trustedTypeKillTimeoutMs} so long chats (≥ ~590 chars at the
     * default 25ms/keystroke) are not truncated by the legacy fixed
     * 15s ceiling.
     */
    timeoutMs?: number;
  }) => Promise<void>;
  startAudioCapture: (opts: AudioCaptureOptions) => Promise<AudioCaptureHandle>;
  createDaemonClient: (opts: {
    daemonUrl: string;
    meetingId: string;
    botApiToken: string;
    onError: (err: Error) => void;
  }) => DaemonClientLike;
  createHttpServer: (
    opts: HttpServerCallbacks & {
      apiToken: string;
      avatar?: HttpServerAvatarOptions;
    },
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
    xdotoolClick: (opts) => xdotoolClick(opts),
    xdotoolType: (opts) => xdotoolType(opts),
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
  // Log before enqueue so the silent-success path is visible when
  // debugging join-flow stalls — without this line the only evidence a
  // lifecycle event even ran through this function was in the daemon
  // logs, which made it impossible to tell locally whether the extension
  // ever reached `joined` after an earlier diagnostic.
  deps.logInfo(
    `meet-bot: forwarding lifecycle:${state} to daemon${detail ? ` (${detail})` : ""}`,
  );
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

  // Derive the Meet URL code (e.g. `abc-defg-hij`) from `MEET_URL`. The
  // Chrome extension stamps every outbound event with `meetingId =
  // location.pathname` from the page it's injected into, so this code
  // is the authoritative filter on whether an event belongs to our
  // session.
  //
  // The background service worker fans every bot command out to every
  // open `meet.google.com/*` tab in the Chrome profile, and content-
  // script-side gating (see `meet-controller-ext/src/content.ts`) only
  // stops the `join` flow from spinning up on stray tabs. If a user had
  // a prior Meet tab open in the same profile — or a second bot session
  // leaked a tab — its content script would still emit lifecycle /
  // telemetry events into the shared `chrome.runtime.sendMessage` pipe,
  // which the background forwards to the NMH socket. Without this
  // filter we would happily stamp the env UUID onto those frames and
  // treat them as authoritative for the current session — clearing the
  // join-deadline timer, firing spurious `lifecycle:joined` / `error`
  // at the daemon, and mixing participant / speaker / chat telemetry
  // across meetings.
  //
  // A non-matching `meetingId` gets logged at diagnostic level and
  // dropped; a genuinely missing / unparseable code falls back to
  // "accept" so we don't silently blackhole the intended session when
  // the URL has an unusual shape.
  const expectedMeetingCode = extractMeetingCodeFromUrl(meetUrl);

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
    /**
     * Camera-toggle channel. Constructed alongside the avatar HTTP
     * options (when avatar is enabled AND the NMH socket server is up)
     * so the HTTP server's `/avatar/enable`/`/avatar/disable` routes can
     * flip the Meet camera on/off via the extension. `shutdown()` is
     * called during bot teardown so in-flight round-trips reject
     * deterministically rather than waiting for their 7s timeout.
     */
    cameraChannel: CameraChannel | null;
  };
  const subsystems: Subsystems = {
    xvfb: null,
    socketServer: null,
    chrome: null,
    daemonClient: null,
    audioCapture: null,
    httpServer: null,
    cameraChannel: null,
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
   * Return true when an inbound extension event belongs to the tab
   * driving this bot's Meet session. Compares the event's
   * extension-supplied `meetingId` (= `location.pathname` code, e.g.
   * `abc-defg-hij`) against the code derived from `MEET_URL`. Falls
   * back to `true` when we couldn't derive an expected code, so an
   * unusually-shaped URL doesn't blackhole the intended session.
   */
  const isFromOurTab = (extMeetingId: string): boolean => {
    if (expectedMeetingCode === null) return true;
    return extMeetingId === expectedMeetingCode;
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
        subsystems.httpServer ? () => subsystems.httpServer!.stop() : null,
      );
      // Abort any in-flight camera round-trips so HTTP handlers awaiting
      // enableCamera / disableCamera don't hang for the full 7s channel
      // timeout. Runs after HTTP stop (no new requests can enter) and
      // before chrome/socket teardown (so the extension is still notionally
      // around to respond, but we no longer care about the result). Safe
      // when the channel was never created (avatar disabled, or booted
      // without a socket server).
      if (subsystems.cameraChannel) {
        try {
          subsystems.cameraChannel.shutdown(
            detail ?? (finalState === "error" ? "error" : "shutdown"),
          );
        } catch (err) {
          deps.logError(
            `meet-bot: camera-channel shutdown failed: ${errMsg(err)}`,
          );
        }
      }
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
        subsystems.audioCapture ? () => subsystems.audioCapture!.stop() : null,
      );
      await stopSafely(
        "xvfb",
        subsystems.xvfb ? () => deps.stopXvfb(subsystems.xvfb!) : null,
      );
      await stopSafely(
        "socket server",
        subsystems.socketServer ? () => subsystems.socketServer!.stop() : null,
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
        subsystems.daemonClient ? () => subsystems.daemonClient!.stop() : null,
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
      avatarEnabled: env.avatarEnabled,
      // When an operator overrides `services.meet.avatar.devicePath`
      // (threaded here as `AVATAR_DEVICE_PATH`), the renderer will write
      // frames to that path — Chrome's `--use-file-for-fake-video-capture`
      // flag must target the same device or Meet reads from the wrong
      // node and participants see a black frame. Omitting the key when
      // unset preserves the launcher's module-local default (/dev/video10).
      ...(env.avatarDevicePath
        ? { avatarDevicePath: env.avatarDevicePath }
        : {}),
      logger: {
        info: (m) => deps.logInfo(m),
        error: (m) => deps.logError(m),
      },
    });

    // Watch for an unexpected Chrome exit. If Chrome dies on its own before
    // the bot has decided to shut down, we escalate to an error shutdown.
    void subsystems.chrome.exitPromise.then((code) => {
      if (shutdownInProgress) return;
      void shutdown(
        "error",
        `chrome exited unexpectedly with code ${code}`,
      ).then(() => {
        detachSigterm();
        detachSigint();
        deps.exit(1);
      });
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

    // A terminal lifecycle (`left`/`error`) or chrome-exit that landed
    // during the settle window already fire-and-forgot `shutdown(...)`.
    // Short-circuit the rest of the boot sequence so we don't bring up
    // audio/HTTP against subsystems that are already being torn down —
    // otherwise `meet-bot ready` can log after the meeting has already
    // terminally failed, and the HTTP control surface briefly accepts
    // requests. All subsequent awaits carry the same guard.
    if (shutdownInProgress) return;

    // ---------------------------------------------------------------------
    // Step 7 — audio capture.
    //
    // Dials the daemon's audio-ingest TCP port on `host.docker.internal`.
    // If the port is missing we fail the boot: the bot cannot do useful
    // work without streaming audio, and a silent no-op would manifest
    // downstream as the daemon's 120s "bot did not connect" timeout.
    // ---------------------------------------------------------------------
    if (env.daemonAudioPort === undefined || Number.isNaN(env.daemonAudioPort)) {
      await shutdown(
        "error",
        "DAEMON_AUDIO_PORT env var is missing or not a number",
      );
      detachSigterm();
      detachSigint();
      deps.exit(1);
      return;
    }
    subsystems.audioCapture = await deps.startAudioCapture({
      daemonHost: env.daemonAudioHost,
      daemonPort: env.daemonAudioPort,
      onError: (err) => {
        // Exhausted reconnect budget — the daemon is unreachable or the
        // pipeline is flapping. Shut the bot down so the daemon rolls the
        // container back instead of waiting out its 120s join timeout.
        if (shutdownInProgress) return;
        deps.logError(`meet-bot: audio capture fatal: ${errMsg(err)}`);
        void shutdown("error", `audio capture failed: ${errMsg(err)}`).then(
          () => {
            detachSigterm();
            detachSigint();
            deps.exit(1);
          },
        );
      },
    });
    if (shutdownInProgress) return;

    // ---------------------------------------------------------------------
    // Step 8 — HTTP control surface.
    //
    // When `AVATAR_ENABLED=1` is set, construct the avatar options bag
    // the server needs to wire the `/avatar/*` routes. We ALSO eagerly
    // attempt to resolve the configured renderer here so a misconfig
    // (missing credential, bad id, unreachable sidecar) surfaces in
    // the bot boot log rather than the first time the agent tries to
    // turn the avatar on. Note that we intentionally only CONSTRUCT —
    // we do not call `start()` — so an eager construction failure
    // just logs; the renderer is actually started on the daemon's
    // `/avatar/enable` HTTP call.
    // ---------------------------------------------------------------------
    const { options: avatarHttpOptions, cameraChannel } =
      buildAvatarHttpOptions(env, deps, subsystems.socketServer);
    subsystems.cameraChannel = cameraChannel;

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
      avatar: avatarHttpOptions,
    });
    await subsystems.httpServer.start(env.httpPort);
    if (shutdownInProgress) return;

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
   * Single-lane queue for xdotool invocations (`trusted_type` +
   * `trusted_click`). Every xdotool operation must complete before the
   * next begins; overlapping invocations corrupt each other via focus
   * migration. Concrete symptom: a `trusted_type` for a ~90-char
   * consent message racing a `trusted_click` for the send button
   * truncates the typed text to ~30 chars — the click lands mid-
   * typing, the composer submits whatever made it in so far, and the
   * remaining keystrokes either drop or land on the wrong element.
   *
   * The extension tries to gap these via a wall-clock
   * `trustedTypeDurationMs(text.length)` wait in `features/chat.ts`,
   * but that timer doesn't survive NMH pipe backpressure, Chrome
   * service-worker throttling, or a busy Bun event loop — any of which
   * can push the two xdotool processes into overlap despite the intended
   * ordering. The queue makes serial execution a property of the bot
   * process itself, so overlap is impossible regardless of caller-side
   * timing assumptions.
   */
  let xdotoolQueue: Promise<unknown> = Promise.resolve();
  function enqueueXdotool<T>(op: () => Promise<T>): Promise<T> {
    // `.catch(() => undefined)` so one failed xdotool invocation doesn't
    // poison the chain — later type/click ops must still run.
    const next = xdotoolQueue.catch(() => undefined).then(op);
    xdotoolQueue = next;
    return next;
  }

  /**
   * Route a single validated inbound message from the extension. Lifecycle
   * + telemetry forward to the daemon, diagnostics get logged, and
   * `send_chat_result` completes the pending HTTP request.
   */
  function handleExtensionMessage(msg: ExtensionToBotMessage): void {
    switch (msg.type) {
      case "ready":
        deps.logInfo(
          `meet-bot: extension ready (version=${msg.extensionVersion})`,
        );
        return;
      case "lifecycle": {
        // Source-tab gate. See `expectedMeetingCode` at boot time for
        // the full rationale: a stray Meet tab's lifecycle events would
        // otherwise clear our join-deadline timer and fire spurious
        // `joined` / `error` at the daemon.
        if (!isFromOurTab(msg.meetingId)) {
          deps.logInfo(
            `meet-bot: dropping lifecycle event from foreign tab (meetingId=${msg.meetingId}, state=${msg.state}, expected=${expectedMeetingCode ?? "<none>"})`,
          );
          return;
        }
        const state: LifecycleState = msg.state;
        // If shutdown is already in progress (SIGTERM, /leave, chrome-exit
        // watcher, daemon-error), this lifecycle is either the extension
        // echoing our own `leave` or a race with another trigger. shutdown()
        // publishes the terminal lifecycle itself, so swallow here to avoid
        // duplicate daemon events and double-firing the exit path.
        if (shutdownInProgress) return;
        // Drive local bot-state on `joined`; terminal states (`left`/`error`)
        // delegate phase management to shutdown() below so we don't
        // double-set. `joining` emitted by the extension is informational —
        // we already set BotState before `waitForReady` returned.
        if (state === "joined") BotState.setPhase("joined");
        // Clear the extension-joined deadline as soon as the extension
        // reaches a terminal post-prejoin state. Idempotent.
        if (state === "joined" || state === "error" || state === "left") {
          clearExtensionJoinedTimer();
        }
        // Terminal states from the extension — the meeting ended or the
        // join irrecoverably failed. Fire a graceful shutdown so subsystems
        // tear down promptly; otherwise the subsequent Chrome exit trips
        // the unexpected-exit watcher and misclassifies a clean leave as
        // an error. shutdown() publishes lifecycle:<state> itself, so we
        // skip the forward-publish below to avoid a duplicate event.
        if (state === "left" || state === "error") {
          const exitCode = state === "error" ? 1 : 0;
          void shutdown(state, msg.detail).then(() => {
            detachSigterm();
            detachSigint();
            deps.exit(exitCode);
          });
          return;
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
        // Source-tab gate — see lifecycle case above.
        if (!isFromOurTab(msg.meetingId)) {
          deps.logInfo(
            `meet-bot: dropping ${msg.type} from foreign tab (meetingId=${msg.meetingId}, expected=${expectedMeetingCode ?? "<none>"})`,
          );
          return;
        }
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
      case "trusted_click": {
        // Serialized through `xdotoolQueue`: a click issued while a
        // prior `trusted_type` is still in flight would shift focus
        // mid-type and truncate the typed text. The extension is
        // fire-and-forget; the extension observes success via the
        // subsequent DOM transition (waitForSelector on the in-meeting
        // UI). xdotool failure is surfaced as a logError so operators
        // see it even though the extension can't synchronously react.
        enqueueXdotool(() =>
          deps
            .xdotoolClick({
              x: msg.x,
              y: msg.y,
              display: env.xvfbDisplay,
            })
            .then(() =>
              deps.logInfo(
                `meet-bot: trusted_click dispatched at (${msg.x},${msg.y})`,
              ),
            )
            .catch((err: unknown) => {
              const detail = err instanceof Error ? err.message : String(err);
              deps.logError(`meet-bot: trusted_click failed: ${detail}`);
            }),
        );
        return;
      }
      case "trusted_type": {
        // Serialized through `xdotoolQueue` — see `trusted_click` above.
        // The extension has already focused the target element; the bot
        // just types into whatever is focused on the Xvfb display. An
        // explicit `timeoutMs` is scaled to the message length so xdotool
        // is not killed mid-type on long chats. `xdotool-type.ts`'s
        // built-in default is a fixed 15s, which truncated any message
        // above ~590 characters at the default 25ms/keystroke delay.
        enqueueXdotool(() =>
          deps
            .xdotoolType({
              text: msg.text,
              delayMs: msg.delayMs,
              display: env.xvfbDisplay,
              timeoutMs: trustedTypeKillTimeoutMs(msg.text.length, msg.delayMs),
            })
            .then(() =>
              deps.logInfo(
                `meet-bot: trusted_type dispatched (${msg.text.length} chars)`,
              ),
            )
            .catch((err: unknown) => {
              const detail = err instanceof Error ? err.message : String(err);
              deps.logError(`meet-bot: trusted_type failed: ${detail}`);
            }),
        );
        return;
      }
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
   * `ok: false` or on a length-scaled timeout. Called from the HTTP
   * `/send_chat` route.
   *
   * The reply timeout scales with text length via
   * {@link trustedTypeReplyTimeoutMs} because the extension types the
   * text one keystroke at a time (25ms default) before clicking send —
   * a fixed 10s ceiling would fail valid messages above ~390 chars.
   * `deps.sendChatTimeoutMs` stays a floor so short messages retain
   * their original budget.
   */
  async function sendChatViaExtension(text: string): Promise<void> {
    if (!subsystems.socketServer) {
      throw new Error("send_chat: socket server not started");
    }
    const requestId = deps.generateRequestId();
    const timeoutMs = Math.max(
      deps.sendChatTimeoutMs,
      trustedTypeReplyTimeoutMs(text.length),
    );
    const waitForResult = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingSendChat.delete(requestId);
        reject(
          new Error(
            `send_chat: extension did not reply within ${timeoutMs}ms (requestId=${requestId})`,
          ),
        );
      }, timeoutMs);
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

/**
 * Extract the Meet code (e.g. `abc-defg-hij`) from a Meet URL like
 * `https://meet.google.com/abc-defg-hij`. Mirrors the content script's
 * own `deriveMeetingId` / `extractMeetingIdFromUrl` helpers so the bot
 * can compare whichever code the extension stamped on an inbound event
 * against the code derived from our own `MEET_URL`.
 *
 * Returns `null` when the URL cannot be parsed or has no leading path
 * segment; callers treat `null` as "cannot filter" and fall through to
 * accepting the event rather than blackholing the session.
 */
function extractMeetingCodeFromUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const segment = parsed.pathname.replace(/^\/+/, "").split("/")[0] ?? "";
  return segment || null;
}

/**
 * Assemble the avatar options bag passed to `createHttpServer` when the
 * avatar feature is enabled. Returns `undefined` options when
 * `AVATAR_ENABLED=0` (or unset) so the HTTP server short-circuits
 * `/avatar/*` routes with 503. Also performs an eager construction
 * probe: if the configured renderer can't be resolved the failure is
 * logged — but we do NOT bail the bot boot, since the renderer is not
 * strictly required for the meeting to proceed.
 *
 * When `socketServer` is non-null the caller forwards a narrowed
 * `AvatarNativeMessagingSender` so the TalkingHead.js renderer (and
 * any future extension-mediated renderer) can drive the avatar tab.
 * In that same case we also construct a {@link CameraChannel} bound
 * to the full `sendToExtension` surface (so `camera.enable` /
 * `camera.disable` frames round-trip through the extension) and thread
 * its `enableCamera`/`disableCamera` into `HttpServerAvatarOptions.camera`
 * so `/avatar/enable` and `/avatar/disable` actually flip the Meet
 * camera toggle. The channel handle is returned separately so the
 * caller can invoke `shutdown()` during bot teardown.
 */
function buildAvatarHttpOptions(
  env: BotEnv,
  deps: BotDeps,
  socketServer: NmhSocketServer | null,
): {
  options: HttpServerAvatarOptions | undefined;
  cameraChannel: CameraChannel | null;
} {
  if (!env.avatarEnabled) return { options: undefined, cameraChannel: null };

  // Parse the JSON-encoded config blob the daemon passed down. Fall
  // back to a minimal config derived from `AVATAR_RENDERER` + the
  // device-path env so tests and operators can exercise the path
  // without populating the full blob.
  let parsed: Record<string, unknown> | null = null;
  if (env.avatarConfigJson) {
    try {
      const raw = JSON.parse(env.avatarConfigJson);
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        parsed = raw as Record<string, unknown>;
      }
    } catch (err) {
      deps.logError(
        `meet-bot: AVATAR_CONFIG_JSON is not valid JSON: ${errMsg(err)} — falling back to env defaults`,
      );
    }
  }

  const config: AvatarConfig = {
    ...(parsed ?? {}),
    enabled: true,
    renderer: env.avatarRenderer,
  };

  // Narrow the NMH socket server to the three avatar.* outbound
  // commands + the inbound listener hook. The renderer gets a
  // hard-typed surface it can't use to smuggle `join`/`leave`/etc.
  const nativeMessaging: AvatarNativeMessagingSender | undefined = socketServer
    ? {
        sendToExtension: (msg) => socketServer.sendToExtension(msg),
        onExtensionMessage: (cb) => socketServer.onExtensionMessage(cb),
      }
    : undefined;

  // Eager construction probe — non-fatal on failure.
  try {
    resolveAvatarRenderer(config, {
      ...(nativeMessaging ? { nativeMessaging } : {}),
    });
  } catch (err) {
    if (err instanceof AvatarRendererUnavailableError) {
      deps.logError(
        `meet-bot: avatar renderer "${err.rendererId}" unavailable at boot: ${err.reason} (will respond 503 on /avatar/enable)`,
      );
    } else {
      deps.logError(
        `meet-bot: avatar renderer eager-probe threw: ${errMsg(err)} (will surface on /avatar/enable)`,
      );
    }
  }

  // Stand up the camera-toggle channel when the NMH socket server is
  // wired up. Uses the full `sendToExtension` / `onExtensionMessage`
  // surface (NOT the narrowed avatar-only `AvatarNativeMessagingSender`)
  // because `camera.enable` / `camera.disable` live outside the narrow
  // avatar.* command set. Absent a socket server (boot smoke builds,
  // tests without a socket-server mock), the channel stays null and the
  // HTTP server falls back to its "renderer-only, no camera toggle"
  // path — which is the correct behavior because there's no extension
  // to receive the toggle command anyway.
  const cameraChannel: CameraChannel | null = socketServer
    ? createCameraChannel({
        sendToExtension: (msg) => socketServer.sendToExtension(msg),
        onExtensionMessage: (cb) => socketServer.onExtensionMessage(cb),
      })
    : null;

  const options: HttpServerAvatarOptions = {
    config,
    ...(nativeMessaging ? { nativeMessaging } : {}),
    ...(env.avatarDevicePath ? { devicePath: env.avatarDevicePath } : {}),
    ...(cameraChannel
      ? {
          camera: {
            enableCamera: () => cameraChannel.enableCamera(),
            disableCamera: () => cameraChannel.disableCamera(),
          },
        }
      : {}),
  };

  return { options, cameraChannel };
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
