/**
 * meet-bot entry point.
 *
 * Bootstrap sequence for the container-side process that joins a Google
 * Meet on behalf of an assistant. The boot path is deliberately linear:
 *
 *   1. Bring up PulseAudio virtual devices (null-sinks + virtual source).
 *      Skipped under `SKIP_PULSE=1` so the boot smoke test can run on
 *      macOS developer machines.
 *   2. Start Xvfb + launch Chromium via `createBrowserSession(MEET_URL)`.
 *   3. Drive the prejoin surface with `joinMeet(page, { displayName,
 *      consentMessage })`.
 *   4. Instantiate `DaemonClient`; publish `lifecycle:joining`, wait
 *      briefly for the meeting-room UI to settle, then publish
 *      `lifecycle:joined`.
 *   5. Start the DOM scrapers (participant, speaker, chat) with callbacks
 *      that funnel events into the daemon client.
 *   6. Start the audio capture pipeline (`startAudioCapture`) so PCM is
 *      shipped to the daemon over the Unix socket.
 *   7. Stand up the HTTP control surface so the daemon can issue `/leave`,
 *      `/send_chat` (Phase 2), `/play_audio` (Phase 3).
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
 * paths without touching PulseAudio / Playwright / network sockets.
 * `defaultDeps()` returns the real wiring; `runBot(defaultDeps())` is
 * what `void main()` invokes at the bottom of this file.
 */

import type { Page } from "playwright";

import type {
  InboundChatEvent,
  LifecycleEvent,
  LifecycleState,
  MeetBotEvent,
  ParticipantChangeEvent,
  SpeakerChangeEvent,
} from "@vellumai/meet-contracts";

import { startChatReader, type ChatReader } from "./browser/chat-reader.js";
import { joinMeet, type JoinMeetOptions } from "./browser/join-flow.js";
import {
  startParticipantScraper,
  type ParticipantScraperHandle,
} from "./browser/participant-scraper.js";
import {
  startSpeakerScraper,
  type SpeakerScraperHandle,
} from "./browser/speaker-scraper.js";
import { createBrowserSession, type BrowserSession } from "./browser/session.js";
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
  };
}

// ---------------------------------------------------------------------------
// Dep injection
// ---------------------------------------------------------------------------

/** Handle a scraper hands back to its caller for teardown. */
interface ScraperStopHandle {
  stop: () => void | Promise<void>;
}

/**
 * Factories the main wiring calls through. Keeping them on a single
 * `BotDeps` object lets tests override any subset with mocks while
 * leaving the rest at their real implementations.
 */
export interface BotDeps {
  env: () => BotEnv;
  setupPulseAudio: () => Promise<void>;
  createBrowserSession: (url: string) => Promise<BrowserSession>;
  joinMeet: (page: Page, opts: JoinMeetOptions) => Promise<void>;
  startParticipantScraper: (
    page: Page,
    onEvent: (event: ParticipantChangeEvent) => void,
    opts: { meetingId: string; selfName: string },
  ) => ParticipantScraperHandle;
  startSpeakerScraper: (
    page: Page,
    onEvent: (event: SpeakerChangeEvent) => void,
    opts: { meetingId: string },
  ) => SpeakerScraperHandle;
  startChatReader: (
    page: Page,
    onEvent: (event: InboundChatEvent) => void,
    opts: { meetingId: string; selfName: string },
  ) => Promise<ChatReader>;
  startAudioCapture: (
    opts: AudioCaptureOptions,
  ) => Promise<AudioCaptureHandle>;
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
   * Signal handler hooks. The test harness stubs these out so the
   * Bun/Node signal machinery isn't wired up during unit tests.
   */
  onSignal: (
    signal: "SIGTERM" | "SIGINT",
    handler: () => void,
  ) => () => void;
  /**
   * Short settle delay between `lifecycle:joining` and `lifecycle:joined`.
   * Exposed as a dep so tests can pass 0 and not hang.
   */
  joinedSettleMs: number;
  /** Sleep shim — tests can substitute a tick-accurate implementation. */
  sleep: (ms: number) => Promise<void>;
  /** Process exit — overridable so tests don't actually terminate. */
  exit: (code: number) => never;
  /** Logger — routed to console in production. Keep separate hooks so tests can capture. */
  logInfo: (msg: string) => void;
  logError: (msg: string) => void;
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
    createBrowserSession,
    joinMeet,
    startParticipantScraper,
    startSpeakerScraper,
    startChatReader,
    startAudioCapture,
    createDaemonClient: (opts) =>
      new DaemonClient({
        daemonUrl: opts.daemonUrl,
        meetingId: opts.meetingId,
        botApiToken: opts.botApiToken,
        onError: (err) => opts.onError(err),
      }),
    createHttpServer,
    onSignal: (signal, handler) => {
      process.on(signal, handler);
      return () => {
        process.off(signal, handler);
      };
    },
    joinedSettleMs: 2_000,
    sleep: (ms) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms)),
    exit: (code) => process.exit(code),
    logInfo: (msg) => console.log(msg),
    logError: (msg) => console.error(msg),
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
  // Legacy screenshot-only boot path (used by the boot smoke test).
  //
  // If there's no MEET_URL at all, the boot test just wants to confirm the
  // package can start and log the marker. Return without going further.
  //
  // If MEET_URL is set but MEETING_ID / DAEMON_URL / BOT_API_TOKEN / JOIN_NAME
  // are missing, we fall back to the previous "open a browser and screenshot"
  // behavior so existing smoke paths keep working. Full join + daemon wiring
  // requires the full env.
  // -------------------------------------------------------------------------

  if (!env.meetUrl) {
    return;
  }

  const needsFullWiring =
    env.meetingId &&
    env.joinName &&
    env.consentMessage &&
    env.daemonUrl &&
    env.botApiToken;

  if (!needsFullWiring) {
    const session = await deps.createBrowserSession(env.meetUrl);
    try {
      if (env.joinName && env.consentMessage) {
        try {
          await deps.joinMeet(session.page, {
            displayName: env.joinName,
            consentMessage: env.consentMessage,
          });
          deps.logInfo(`meet-bot joined ${env.meetUrl} as ${env.joinName}`);
        } catch (err) {
          deps.logError(`meet-bot: join flow failed: ${errMsg(err)}`);
          deps.exit(1);
          return;
        }
      } else {
        await session.page.screenshot({ path: "/tmp/boot-screenshot.png" });
        deps.logInfo(
          `meet-bot captured boot screenshot for ${env.meetUrl} at /tmp/boot-screenshot.png`,
        );
      }
    } finally {
      await session.close();
    }
    return;
  }

  // TypeScript narrowing — `needsFullWiring` already verified these.
  const meetingId = env.meetingId!;
  const joinName = env.joinName!;
  const consentMessage = env.consentMessage!;
  const daemonUrl = env.daemonUrl!;
  const botApiToken = env.botApiToken!;
  const meetUrl = env.meetUrl;

  BotState.setMeeting(meetingId);

  // Shared shutdown state — read by signal handlers, `/leave`, and boot
  // error paths. We construct it up-front so the error-reporting path can
  // still produce a usable shutdown even if the daemon client never gets
  // instantiated.
  type Subsystems = {
    session: BrowserSession | null;
    daemonClient: DaemonClientLike | null;
    participantScraper: ScraperStopHandle | null;
    speakerScraper: ScraperStopHandle | null;
    chatReader: ScraperStopHandle | null;
    audioCapture: AudioCaptureHandle | null;
    httpServer: HttpServerHandle | null;
  };
  const subsystems: Subsystems = {
    session: null,
    daemonClient: null,
    participantScraper: null,
    speakerScraper: null,
    chatReader: null,
    audioCapture: null,
    httpServer: null,
  };

  // Dedup guard: signals, HTTP /leave, and boot errors can all race to
  // trigger shutdown. Only the first one wins.
  let shutdownInProgress = false;
  let shutdownDonePromise: Promise<void> | null = null;

  /**
   * Graceful shutdown. Tears down subsystems in the reverse order of
   * startup: HTTP server (so no new commands arrive) → scrapers → audio
   * → browser → daemon client (flushed last so `lifecycle:left` is
   * delivered). Safe to call multiple times.
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

      /** Run a subsystem teardown without letting its failure poison the rest. */
      const stopSafely = async (
        label: string,
        handle: { stop: () => void | Promise<void> } | null,
      ): Promise<void> => {
        if (!handle) return;
        try {
          await handle.stop();
        } catch (err) {
          deps.logError(`meet-bot: ${label} stop failed: ${errMsg(err)}`);
        }
      };

      // Teardown order (reverse of boot): HTTP first so no new commands
      // arrive, then the scrapers (halts scraper-generated events), then
      // audio (so parec sees clean EOF before Chrome tears down), then
      // the browser. The daemon client is stopped last so the terminal
      // lifecycle event gets flushed.
      await stopSafely("http server", subsystems.httpServer);
      await stopSafely("participant scraper", subsystems.participantScraper);
      await stopSafely("speaker scraper", subsystems.speakerScraper);
      await stopSafely("chat reader", subsystems.chatReader);
      await stopSafely("audio capture", subsystems.audioCapture);
      await stopSafely(
        "browser session",
        subsystems.session
          ? { stop: () => subsystems.session!.close() }
          : null,
      );

      publishLifecycle(
        subsystems.daemonClient,
        meetingId,
        finalState,
        deps,
        detail,
      );
      await stopSafely("daemon client", subsystems.daemonClient);

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
    // ---------------------------------------------------------------------
    // Step 2 — Xvfb + browser.
    // ---------------------------------------------------------------------
    BotState.setPhase("joining");
    subsystems.session = await deps.createBrowserSession(meetUrl);

    // ---------------------------------------------------------------------
    // Step 3 — join the meeting.
    //
    // We need the daemon client up to *report* a join failure, so
    // instantiate it before invoking joinMeet. That way a selector
    // timeout (host never admits the bot, prejoin URL expired, etc.)
    // still produces a `lifecycle:error` event on the wire.
    // ---------------------------------------------------------------------
    subsystems.daemonClient = deps.createDaemonClient({
      daemonUrl,
      meetingId,
      botApiToken,
      onError: onDaemonTerminalError,
    });

    publishLifecycle(subsystems.daemonClient, meetingId, "joining", deps);

    try {
      await deps.joinMeet(subsystems.session.page, {
        displayName: joinName,
        consentMessage,
      });
    } catch (err) {
      const msg = errMsg(err);
      deps.logError(`meet-bot: join flow failed: ${msg}`);
      publishLifecycle(
        subsystems.daemonClient,
        meetingId,
        "error",
        deps,
        msg,
      );
      await shutdown("error", msg);
      detachSigterm();
      detachSigint();
      deps.exit(1);
      return;
    }

    // ---------------------------------------------------------------------
    // Step 4 — settle, then publish `lifecycle:joined`.
    // ---------------------------------------------------------------------
    await deps.sleep(deps.joinedSettleMs);
    BotState.setPhase("joined");
    publishLifecycle(subsystems.daemonClient, meetingId, "joined", deps);

    // ---------------------------------------------------------------------
    // Step 5 — scrapers.
    // ---------------------------------------------------------------------
    const enqueue = (ev: MeetBotEvent): void => {
      if (subsystems.daemonClient) subsystems.daemonClient.enqueue(ev);
    };

    subsystems.participantScraper = deps.startParticipantScraper(
      subsystems.session.page,
      (event) => enqueue(event),
      { meetingId, selfName: joinName },
    );
    subsystems.speakerScraper = deps.startSpeakerScraper(
      subsystems.session.page,
      (event) => enqueue(event),
      { meetingId },
    );
    subsystems.chatReader = await deps.startChatReader(
      subsystems.session.page,
      (event) => enqueue(event),
      { meetingId, selfName: joinName },
    );

    // ---------------------------------------------------------------------
    // Step 6 — audio capture.
    // ---------------------------------------------------------------------
    subsystems.audioCapture = await deps.startAudioCapture({
      socketPath: `${env.socketDir}/audio.sock`,
    });

    // ---------------------------------------------------------------------
    // Step 7 — HTTP control surface.
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
      onSendChat: () => {
        // Phase 2 will replace the 501 stub with a real implementation.
      },
      onPlayAudio: () => {
        // Phase 3 will replace the 501 stub with a real implementation.
      },
    });
    await subsystems.httpServer.start(env.httpPort);

    deps.logInfo(`meet-bot ready (meetingId=${meetingId})`);
  } catch (err) {
    const msg = errMsg(err);
    deps.logError(`meet-bot: boot failed: ${msg}`);
    publishLifecycle(
      subsystems.daemonClient,
      meetingId,
      "error",
      deps,
      msg,
    );
    await shutdown("error", msg);
    detachSigterm();
    detachSigint();
    deps.exit(1);
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
