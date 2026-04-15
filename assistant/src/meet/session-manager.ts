/**
 * MeetSessionManager — orchestrates per-meeting bot container lifecycle.
 *
 * Responsibilities:
 *   - Generate a unique `BOT_API_TOKEN` per meeting so the ingress route
 *     (PR 9) can authenticate inbound bot callbacks.
 *   - Stage per-meeting artifact directories (`sockets/`, `out/`) on the
 *     workspace volume.
 *   - Resolve the Deepgram API key (and a placeholder TTS key reserved for
 *     Phase 3) via the secure-keys abstraction.
 *   - Drive `DockerRunner` to create + start the Meet-bot container with the
 *     right env/binds/port mappings.
 *   - Register the per-meeting handler with `MeetSessionEventRouter` via
 *     the shared `meetEventDispatcher` so multiple subscribers (this
 *     manager, PR 17's conversation bridge, PR 18's storage writer,
 *     PR 22's consent monitor) can observe the same live event stream.
 *   - Publish `meet.joining` / `meet.joined` / `meet.left` / `meet.error`
 *     lifecycle events on the assistant event hub so SSE-connected clients
 *     can render live meeting state.
 *   - Enforce `services.meet.maxMeetingMinutes` via a hard-cap timeout that
 *     invokes `leave(id, "timeout")`.
 *   - On `leave`, best-effort hit the bot's `/leave` first; fall back to
 *     `DockerRunner.stop` + `remove` so stuck bots don't leak containers.
 *
 * Not yet wired in this PR — left for their owning PRs:
 *   - PR 16 adds audio ingest server startup before the container spawns.
 *   - PR 22 instantiates the consent monitor and disposes it on leave.
 *   - PR 23 substitutes `{assistantName}` into `CONSENT_MESSAGE`.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { getConfig } from "../config/loader.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../runtime/assistant-scope.js";
import { getProviderKeyAsync } from "../security/secure-keys.js";
import { getLogger } from "../util/logger.js";
import { getWorkspaceDir } from "../util/platform.js";
import { DockerRunner, type DockerRunResult } from "./docker-runner.js";
import {
  type MeetEventUnsubscribe,
  publishMeetEvent,
  registerMeetingDispatcher,
  subscribeEventHubPublisher,
  subscribeToMeetingEvents,
  unregisterMeetingDispatcher,
} from "./event-publisher.js";
import { getMeetSessionEventRouter } from "./session-event-router.js";

const log = getLogger("meet-session-manager");

/** Default internal port the bot's control API listens on inside the container. */
export const MEET_BOT_INTERNAL_PORT = 3000;

/** Default host interface to bind the bot's published port to. */
export const MEET_BOT_HOST_IP = "127.0.0.1";

/** Timeout for the best-effort bot `/leave` HTTP call before falling back to stop. */
export const BOT_LEAVE_HTTP_TIMEOUT_MS = 10_000;

/** Default daemon HTTP port when `RUNTIME_HTTP_PORT` is not set. */
const DEFAULT_DAEMON_PORT = 7821;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MeetSession {
  meetingId: string;
  conversationId: string;
  containerId: string;
  /** Host-side URL the daemon can use to talk to the bot's control API. */
  botBaseUrl: string;
  /** Per-meeting bearer token minted at join time. */
  botApiToken: string;
  /** Wall-clock ms since the epoch when the session was created. */
  startedAt: number;
  /** `services.meet.maxMeetingMinutes * 60_000` — captured at join time. */
  joinTimeoutMs: number;
}

export interface JoinInput {
  url: string;
  meetingId: string;
  conversationId: string;
}

// ---------------------------------------------------------------------------
// MeetSessionManagerImpl
// ---------------------------------------------------------------------------

interface ActiveSession extends MeetSession {
  /** Hard-cap timeout handle — cleared on leave. */
  timeoutHandle: ReturnType<typeof setTimeout> | null;
  /** Unsubscribe handles for per-session dispatcher subscriptions. */
  eventUnsubscribes: MeetEventUnsubscribe[];
  /** True once the bot has emitted a `lifecycle.joined` event. */
  joinedPublished: boolean;
}

export interface MeetSessionManagerDeps {
  /** Factory for the Docker runner — swapped in tests. */
  dockerRunnerFactory?: () => Pick<
    DockerRunner,
    "run" | "stop" | "remove" | "inspect"
  >;
  /** Override the function that fetches credentials. */
  getProviderKey?: (provider: string) => Promise<string | undefined>;
  /** Override the function that hits the bot's `/leave` endpoint. */
  botLeaveFetch?: (url: string, token: string) => Promise<void>;
  /** Override the daemon-URL resolver (used for `DAEMON_URL` env var). */
  resolveDaemonUrl?: () => string;
  /** Override workspace directory resolution (tests). */
  getWorkspaceDir?: () => string;
}

class MeetSessionManagerImpl {
  private sessions = new Map<string, ActiveSession>();
  private deps: Required<MeetSessionManagerDeps>;

  constructor(deps: MeetSessionManagerDeps = {}) {
    this.deps = {
      dockerRunnerFactory: deps.dockerRunnerFactory ?? (() => new DockerRunner()),
      getProviderKey: deps.getProviderKey ?? getProviderKeyAsync,
      botLeaveFetch: deps.botLeaveFetch ?? defaultBotLeaveFetch,
      resolveDaemonUrl: deps.resolveDaemonUrl ?? defaultResolveDaemonUrl,
      getWorkspaceDir: deps.getWorkspaceDir ?? getWorkspaceDir,
    };

    // The ingress route (PR 9) looks up per-meeting tokens through this
    // resolver. Install it once at construction time — it reads live state
    // from `this.sessions`, so it stays correct as sessions come and go.
    getMeetSessionEventRouter().setBotApiTokenResolver((meetingId) => {
      const session = this.sessions.get(meetingId);
      return session ? session.botApiToken : null;
    });
  }

  /** Swap dependencies at runtime. Tests only. */
  _replaceDeps(deps: MeetSessionManagerDeps): void {
    this.deps = {
      dockerRunnerFactory:
        deps.dockerRunnerFactory ?? this.deps.dockerRunnerFactory,
      getProviderKey: deps.getProviderKey ?? this.deps.getProviderKey,
      botLeaveFetch: deps.botLeaveFetch ?? this.deps.botLeaveFetch,
      resolveDaemonUrl: deps.resolveDaemonUrl ?? this.deps.resolveDaemonUrl,
      getWorkspaceDir: deps.getWorkspaceDir ?? this.deps.getWorkspaceDir,
    };
    // Re-install the token resolver in case `_resetForTests` cleared it.
    getMeetSessionEventRouter().setBotApiTokenResolver((meetingId) => {
      const session = this.sessions.get(meetingId);
      return session ? session.botApiToken : null;
    });
  }

  /** Reset internal state. Tests only. */
  _resetForTests(): void {
    for (const session of this.sessions.values()) {
      if (session.timeoutHandle) clearTimeout(session.timeoutHandle);
      for (const unsubscribe of session.eventUnsubscribes) {
        try {
          unsubscribe();
        } catch {
          /* best-effort */
        }
      }
    }
    this.sessions.clear();
  }

  /**
   * Spawn a Meet-bot container for the given meeting and return the session
   * descriptor. Throws if a session for the same meeting already exists.
   */
  async join(input: JoinInput): Promise<MeetSession> {
    const { url, meetingId, conversationId } = input;

    if (this.sessions.has(meetingId)) {
      throw new Error(
        `MeetSession already exists for meetingId=${meetingId}; leave the existing session before re-joining`,
      );
    }

    // Fire `meet.joining` before we start real work so clients can show the
    // "attempting to join …" state immediately. Await the publish so any
    // subscriber errors surface into the log stream before the container
    // spin-up (which takes seconds) begins.
    await publishMeetEvent(
      DAEMON_INTERNAL_ASSISTANT_ID,
      meetingId,
      "meet.joining",
      { url },
    );

    const config = getConfig();
    const meet = config.services.meet;

    const workspaceDir = this.deps.getWorkspaceDir();
    const meetingDir = join(workspaceDir, "meets", meetingId);
    const socketsDir = join(meetingDir, "sockets");
    const outDir = join(meetingDir, "out");
    mkdirSync(socketsDir, { recursive: true });
    mkdirSync(outDir, { recursive: true });

    const botApiToken = generateBotApiToken();

    const deepgramKey = (await this.deps.getProviderKey("deepgram")) ?? "";
    // Placeholder — Phase 3 (PR 23+) will resolve the real TTS credential.
    const ttsKey = (await this.deps.getProviderKey("tts")) ?? "";

    const daemonUrl = this.deps.resolveDaemonUrl();

    const env: Record<string, string> = {
      MEET_URL: url,
      MEETING_ID: meetingId,
      // `joinName` is null → bot falls back to the assistant display name at
      // runtime (PR 23 substitutes it). Forward an empty string so the bot
      // can distinguish "not set" from an explicit value.
      JOIN_NAME: meet.joinName ?? "",
      // `{assistantName}` substitution is owned by PR 23.
      CONSENT_MESSAGE: meet.consentMessage,
      DAEMON_URL: daemonUrl,
      BOT_API_TOKEN: botApiToken,
      DEEPGRAM_API_KEY: deepgramKey,
      TTS_API_KEY: ttsKey,
      // Enable the in-container Pulse null-sink by default (set to "1" to
      // disable in dev). Match the meet-bot image expectation.
      SKIP_PULSE: "0",
    };

    const runner = this.deps.dockerRunnerFactory();

    let runResult: DockerRunResult;
    try {
      runResult = await runner.run({
        image: meet.containerImage,
        env,
        binds: [
          { hostPath: socketsDir, containerPath: "/sockets" },
          { hostPath: outDir, containerPath: "/out" },
        ],
        ports: [
          {
            hostIp: MEET_BOT_HOST_IP,
            hostPort: 0,
            containerPort: MEET_BOT_INTERNAL_PORT,
            protocol: "tcp",
          },
        ],
        name: `vellum-meet-${meetingId}`,
        network: meet.dockerNetwork,
      });
    } catch (err) {
      log.error(
        { err, meetingId, image: meet.containerImage },
        "Failed to spawn meet bot container",
      );
      void publishMeetEvent(
        DAEMON_INTERNAL_ASSISTANT_ID,
        meetingId,
        "meet.error",
        { detail: errorDetail(err) },
      );
      throw err;
    }

    const boundPort = runResult.boundPorts.find(
      (p) => p.containerPort === MEET_BOT_INTERNAL_PORT,
    );
    if (!boundPort) {
      // Roll back the container so we don't leak a started-but-unreachable
      // bot. Best-effort — surface the original error either way.
      await runner.remove(runResult.containerId).catch(() => {});
      const detail = `meet-bot container ${runResult.containerId} did not publish a host port for ${MEET_BOT_INTERNAL_PORT}/tcp`;
      void publishMeetEvent(
        DAEMON_INTERNAL_ASSISTANT_ID,
        meetingId,
        "meet.error",
        { detail },
      );
      throw new Error(detail);
    }

    const botBaseUrl = `http://${MEET_BOT_HOST_IP}:${boundPort.hostPort}`;
    const joinTimeoutMs = meet.maxMeetingMinutes * 60_000;

    // Install the single router handler for this meeting. It fans incoming
    // bot events out via `meetEventDispatcher` so multiple subscribers
    // (this publisher, PR 17's bridge, PR 18's storage writer, PR 22's
    // consent monitor) can observe the same stream without racing to
    // replace each other at the router.
    registerMeetingDispatcher(meetingId);

    const startedAt = Date.now();
    const session: ActiveSession = {
      meetingId,
      conversationId,
      containerId: runResult.containerId,
      botBaseUrl,
      botApiToken,
      startedAt,
      joinTimeoutMs,
      timeoutHandle: null,
      eventUnsubscribes: [],
      joinedPublished: false,
    };
    this.sessions.set(meetingId, session);

    // Fan `participant.change` / `speaker.change` / final transcript chunks
    // out as `meet.*` events on the assistant event hub.
    session.eventUnsubscribes.push(
      subscribeEventHubPublisher(DAEMON_INTERNAL_ASSISTANT_ID, meetingId),
    );

    // Watch for the bot's first `lifecycle: joined` so we can emit a
    // client-facing `meet.joined` at the precise moment the bot is live
    // in the meeting. Lifecycle publish happens once per session.
    session.eventUnsubscribes.push(
      subscribeToMeetingEvents(meetingId, (event) => {
        if (event.type !== "lifecycle") return;
        if (event.state === "joined" && !session.joinedPublished) {
          session.joinedPublished = true;
          void publishMeetEvent(
            DAEMON_INTERNAL_ASSISTANT_ID,
            meetingId,
            "meet.joined",
            {},
          );
          return;
        }
        if (event.state === "error") {
          void publishMeetEvent(
            DAEMON_INTERNAL_ASSISTANT_ID,
            meetingId,
            "meet.error",
            { detail: event.detail ?? "unknown error" },
          );
        }
      }),
    );

    // Max-meeting-minutes hard cap. Using setTimeout keeps this compatible
    // with Bun's fake-timer harness for tests.
    session.timeoutHandle = setTimeout(() => {
      void this.leave(meetingId, "timeout").catch((err) => {
        log.error(
          { err, meetingId },
          "Error during max-meeting-minutes timeout cleanup",
        );
      });
    }, joinTimeoutMs);

    // NOTE: a container-exit watcher still belongs here in a future PR —
    // it would catch `docker stop`-driven exits that never emit a
    // `lifecycle: left` event and synthesize a `meet.error` so the client
    // doesn't hang in "joined" forever. Leaving as a follow-up; the
    // timeout cap + explicit `leave()` path already cover the normal
    // teardown routes.

    log.info(
      {
        meetingId,
        conversationId,
        containerId: runResult.containerId,
        botBaseUrl,
        joinTimeoutMs,
      },
      "Meet session joined",
    );

    return sessionView(session);
  }

  /**
   * Tear down a meeting: try the bot's `/leave` first, fall back to
   * `stop` + `remove`. Idempotent — calling leave on an unknown meeting
   * is a no-op.
   */
  async leave(meetingId: string, reason: string): Promise<void> {
    const session = this.sessions.get(meetingId);
    if (!session) {
      log.debug({ meetingId, reason }, "leave(): no active session — no-op");
      return;
    }

    // Immediately clear state so we don't re-enter this path via the timeout
    // firing concurrently with a caller-initiated leave.
    if (session.timeoutHandle) {
      clearTimeout(session.timeoutHandle);
      session.timeoutHandle = null;
    }
    this.sessions.delete(meetingId);

    // Tear down dispatcher subscribers BEFORE unregistering the router so no
    // in-flight event slips through to a subscriber whose consumer is gone.
    for (const unsubscribe of session.eventUnsubscribes) {
      try {
        unsubscribe();
      } catch (err) {
        log.warn(
          { err, meetingId },
          "Meet event subscriber unsubscribe threw during leave",
        );
      }
    }
    session.eventUnsubscribes = [];
    unregisterMeetingDispatcher(meetingId);

    const runner = this.deps.dockerRunnerFactory();

    let gracefulOk = false;
    try {
      await this.deps.botLeaveFetch(
        `${session.botBaseUrl}/leave`,
        session.botApiToken,
      );
      gracefulOk = true;
    } catch (err) {
      log.warn(
        { err, meetingId, reason },
        "Bot /leave failed or timed out — falling back to container stop",
      );
    }

    if (!gracefulOk) {
      try {
        await runner.stop(session.containerId);
      } catch (err) {
        log.warn(
          { err, meetingId, containerId: session.containerId },
          "DockerRunner.stop failed — proceeding to remove",
        );
      }
    }

    try {
      await runner.remove(session.containerId);
    } catch (err) {
      log.warn(
        { err, meetingId, containerId: session.containerId },
        "DockerRunner.remove failed — container may leak",
      );
    }

    void publishMeetEvent(
      DAEMON_INTERNAL_ASSISTANT_ID,
      meetingId,
      "meet.left",
      { reason },
    );

    log.info(
      { meetingId, containerId: session.containerId, reason, gracefulOk },
      "Meet session left",
    );
  }

  /** Snapshot of currently-active sessions (excludes internal fields). */
  activeSessions(): MeetSession[] {
    return Array.from(this.sessions.values()).map(sessionView);
  }

  /** Look up a session by meeting id, or `null` when none is active. */
  getSession(meetingId: string): MeetSession | null {
    const session = this.sessions.get(meetingId);
    return session ? sessionView(session) : null;
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

/** Process-wide session manager. */
export const MeetSessionManager = new MeetSessionManagerImpl();

/** Exposed for integration tests that need a clean instance. */
export function _createMeetSessionManagerForTests(
  deps?: MeetSessionManagerDeps,
): MeetSessionManagerImpl {
  return new MeetSessionManagerImpl(deps);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip internal fields (`timeoutHandle`) from a session before exposing it. */
function sessionView(session: ActiveSession): MeetSession {
  return {
    meetingId: session.meetingId,
    conversationId: session.conversationId,
    containerId: session.containerId,
    botBaseUrl: session.botBaseUrl,
    botApiToken: session.botApiToken,
    startedAt: session.startedAt,
    joinTimeoutMs: session.joinTimeoutMs,
  };
}

/**
 * Generate a cryptographically random bearer token for per-meeting bot auth.
 * 32 bytes → 64 hex chars — enough entropy for a shared secret.
 */
export function generateBotApiToken(): string {
  return randomBytes(32).toString("hex");
}

/** Extract a human-readable message from an unknown thrown value. */
function errorDetail(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "unknown error";
}

/**
 * Default bot `/leave` hitter. Honors {@link BOT_LEAVE_HTTP_TIMEOUT_MS}.
 * Throws on non-2xx or timeout so `leave()` can fall through to stop.
 */
async function defaultBotLeaveFetch(
  url: string,
  token: string,
): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(BOT_LEAVE_HTTP_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(
      `Bot /leave returned ${response.status}: ${await response.text().catch(() => "")}`,
    );
  }
}

/**
 * Resolve the daemon URL the bot container should use to post events back
 * to the host. Docker containers reach the host via
 * `host.docker.internal`; the port comes from `RUNTIME_HTTP_PORT` with a
 * fallback to the default.
 */
function defaultResolveDaemonUrl(): string {
  const portRaw = process.env.RUNTIME_HTTP_PORT;
  const port = portRaw ? Number.parseInt(portRaw, 10) : DEFAULT_DAEMON_PORT;
  const effectivePort =
    Number.isFinite(port) && port > 0 ? port : DEFAULT_DAEMON_PORT;
  return `http://host.docker.internal:${effectivePort}`;
}
