/**
 * Per-meeting event fan-out for the meet-bot → daemon ingress path.
 *
 * The meet-bot runs as an assistant-spawned subprocess on localhost and
 * posts {@link MeetBotEvent} payloads to `POST /v1/internal/meet/:meetingId/events`.
 * The route handler parses + validates the batch and hands each event off
 * to this router, which fans the event out to the registered handler for
 * that `meetingId`.
 *
 * Later PRs in the meet-phase-1 plan register handlers here:
 *   - Conversation bridge (PR 17) — relays transcript/chat to the
 *     assistant conversation.
 *   - Storage writer (PR 18) — persists events for audit + replay.
 *   - Lifecycle listener (PR 19) — reacts to join/leave transitions.
 *   - Speaker resolver (PR 21) — attributes utterances to participants.
 *   - Consent monitor (PR 22) — enforces recording consent invariants.
 *
 * The router is intentionally simple: one handler per meeting, synchronous
 * fanout, no buffering. Fan-out *within* a meeting is expected to happen
 * inside the registered handler (e.g. a single "session" handler that
 * itself dispatches to the storage writer, bridge, etc.). Keeping the
 * top-level router 1:1 avoids ordering ambiguity — exactly one
 * registration, exactly one handler, deterministic dispatch.
 *
 * Late events (arriving after `unregister`) are logged and dropped so a
 * slow in-flight POST from a just-terminated bot session can't explode the
 * handler graph.
 *
 * ## Host-based factory
 *
 * The router no longer imports from `assistant/` directly. Callers build
 * one via {@link createSessionEventRouter}, passing the `SkillHost` the
 * skill received from its entry point. The router's only host dependency
 * is the logger facet, used for handler-error / drop telemetry.
 */

import type { Logger, SkillHost } from "@vellumai/skill-host-contracts";

import type { MeetBotEvent } from "../contracts/index.js";

import { registerSubModule } from "./modules-registry.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Callback invoked for every event dispatched to a registered meeting. */
export type MeetSessionEventHandler = (event: MeetBotEvent) => void;

/**
 * Resolver that returns the bot API token for a given `meetingId`, or
 * `null` when no active session exists for that id.
 *
 * The default resolver rejects all requests (returns `null`). PR 10 wires
 * the real resolver from the session manager so only live meetings can
 * accept bot events.
 */
export type BotApiTokenResolver = (meetingId: string) => string | null;

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * Fans meet-bot events out to per-meeting handlers.
 *
 * Singleton access is via {@link getMeetSessionEventRouter}. Tests should
 * use {@link __resetMeetSessionEventRouterForTests} to start each test
 * with a clean router.
 */
export class MeetSessionEventRouter {
  private readonly handlers = new Map<string, MeetSessionEventHandler>();
  private resolveBotApiTokenImpl: BotApiTokenResolver = () => null;
  private readonly log: Logger;

  /**
   * Construct a router. The optional {@link Logger} is used only for
   * handler-error / drop telemetry; production callers wire
   * `host.logger.get("meet-session-event-router")` via
   * {@link createSessionEventRouter}. Tests that construct the router
   * directly get a console-backed fallback so they do not need to inject
   * a logger.
   */
  constructor(logger?: Logger) {
    this.log = logger ?? consoleLogger;
  }

  /**
   * Register a handler for a meeting. Overwrites any existing handler
   * for the same `meetingId`; callers are expected to pair `register`
   * and `unregister` on the session lifecycle, so a double-register is
   * treated as "replace" (logged at warn level so it's observable).
   */
  register(meetingId: string, handler: MeetSessionEventHandler): void {
    if (this.handlers.has(meetingId)) {
      this.log.warn(
        "MeetSessionEventRouter: overwriting existing handler registration",
        { meetingId },
      );
    }
    this.handlers.set(meetingId, handler);
  }

  /**
   * Remove the handler for a meeting, if any. Subsequent dispatches for
   * this meeting log-and-drop until a new handler is registered.
   */
  unregister(meetingId: string): void {
    this.handlers.delete(meetingId);
  }

  /**
   * Dispatch an event to the registered handler for `meetingId`.
   *
   * If no handler is registered (e.g. the session was unregistered
   * while an in-flight POST was still queued), the event is logged at
   * info level and dropped. Handler errors are caught and logged so
   * one handler failure cannot poison the dispatch loop.
   */
  dispatch(meetingId: string, event: MeetBotEvent): void {
    const handler = this.handlers.get(meetingId);
    if (!handler) {
      this.log.info(
        "MeetSessionEventRouter: dropping event for unregistered meeting",
        { meetingId, eventType: event.type },
      );
      return;
    }
    try {
      handler(event);
    } catch (err) {
      this.log.error("MeetSessionEventRouter: handler threw", {
        err,
        meetingId,
        eventType: event.type,
      });
    }
  }

  /**
   * Look up the bearer token a bot must present to post events for this
   * meeting. Returns `null` when no active session exists — the ingress
   * route uses this to reject 401 on stale/unknown meeting ids.
   */
  resolveBotApiToken(meetingId: string): string | null {
    return this.resolveBotApiTokenImpl(meetingId);
  }

  /**
   * Install the resolver used by {@link resolveBotApiToken}. Called once
   * at daemon boot by the session manager (PR 10). The default resolver
   * rejects every request.
   */
  setBotApiTokenResolver(resolver: BotApiTokenResolver): void {
    this.resolveBotApiTokenImpl = resolver;
  }

  /** Number of currently registered meetings. Exposed for tests. */
  registeredCount(): number {
    return this.handlers.size;
  }
}

// ---------------------------------------------------------------------------
// Fallback logger for tests / direct-construction paths
// ---------------------------------------------------------------------------

/**
 * Minimal console-backed logger used when the router is constructed
 * without a host-supplied logger. Keeps the no-arg `new MeetSessionEventRouter()`
 * constructor callable from unit tests without forcing them to build a
 * host stub.
 */
const consoleLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: (msg, meta) => {
    // eslint-disable-next-line no-console
    console.warn(msg, meta ?? {});
  },
  error: (msg, meta) => {
    // eslint-disable-next-line no-console
    console.error(msg, meta ?? {});
  },
};

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: MeetSessionEventRouter | null = null;

/**
 * Process-level singleton router shared by the ingress route, the session
 * manager, and all event subscribers. Uses the console-backed fallback
 * logger; callers that want host-scoped logging should construct a
 * dedicated router via {@link createSessionEventRouter} and pass it
 * around explicitly.
 */
export function getMeetSessionEventRouter(): MeetSessionEventRouter {
  if (!instance) instance = new MeetSessionEventRouter();
  return instance;
}

/**
 * Install the bot API token resolver on the module singleton. Shortcut for
 * `getMeetSessionEventRouter().setBotApiTokenResolver(resolver)`; exported
 * so PR 10's session manager can wire the resolver without importing the
 * router class directly.
 */
export function setBotApiTokenResolver(resolver: BotApiTokenResolver): void {
  getMeetSessionEventRouter().setBotApiTokenResolver(resolver);
}

/**
 * Test helper: reset the module-level singleton so each test starts with
 * a fresh router. Production code never calls this.
 */
export function __resetMeetSessionEventRouterForTests(): void {
  instance = null;
}

// ---------------------------------------------------------------------------
// Host-based factory
// ---------------------------------------------------------------------------

/**
 * Build a {@link MeetSessionEventRouter} scoped to a {@link SkillHost}.
 * The router's logger is sourced from `host.logger.get(...)` so handler-
 * error and drop telemetry carries the host's log scope.
 *
 * Registered under the sub-module slot `"session-event-router"` in
 * {@link registerSubModule} at module import time; PR 17's session
 * manager consumes the registration via `getSubModule`.
 */
export function createSessionEventRouter(
  host: SkillHost,
): MeetSessionEventRouter {
  return new MeetSessionEventRouter(host.logger.get("meet-session-event-router"));
}

registerSubModule("session-event-router", createSessionEventRouter);
