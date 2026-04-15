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
 */

import type { MeetBotEvent } from "@vellumai/meet-contracts";

import { getLogger } from "../../../assistant/src/util/logger.js";

const log = getLogger("meet-session-event-router");

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

  /**
   * Register a handler for a meeting. Overwrites any existing handler
   * for the same `meetingId`; callers are expected to pair `register`
   * and `unregister` on the session lifecycle, so a double-register is
   * treated as "replace" (logged at warn level so it's observable).
   */
  register(meetingId: string, handler: MeetSessionEventHandler): void {
    if (this.handlers.has(meetingId)) {
      log.warn(
        { meetingId },
        "MeetSessionEventRouter: overwriting existing handler registration",
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
      log.info(
        { meetingId, eventType: event.type },
        "MeetSessionEventRouter: dropping event for unregistered meeting",
      );
      return;
    }
    try {
      handler(event);
    } catch (err) {
      log.error(
        { err, meetingId, eventType: event.type },
        "MeetSessionEventRouter: handler threw",
      );
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
// Singleton (matches the style of `ChromeExtensionRegistry` / `assistantEventHub`)
// ---------------------------------------------------------------------------

let instance: MeetSessionEventRouter | null = null;

/**
 * Process-level singleton router shared by the ingress route, the session
 * manager, and all event subscribers.
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
