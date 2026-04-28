/**
 * Meet event publisher — bridges the bot's wire-level events to
 * `assistantEventHub`-shaped lifecycle / transcript / participant / speaker
 * messages that macOS (and future) clients consume over the SSE route.
 *
 * Two concerns live here:
 *
 *  1. {@link publishMeetEvent} — builds a proper `AssistantEvent` via the
 *     host's `events.buildEvent` and hands it to `host.events.publish`.
 *     Failures are swallowed and logged: a slow/broken SSE subscriber must
 *     never break the meeting.
 *
 *  2. {@link MeetEventDispatcher} — a thin fan-out for per-meeting bot
 *     events. The router upstream (`MeetSessionEventRouter`, PR 9) only
 *     allows one handler per meeting, which means the session manager
 *     must own the single registration and multiplex from there. Several
 *     consumers want to observe the same live event stream (this
 *     publisher for SSE, conversation bridge, storage, consent). They
 *     all subscribe through this dispatcher rather than racing to
 *     replace each other at the router.
 *
 *     The dispatcher is intentionally cheap: a `Map<meetingId, Set<cb>>`,
 *     synchronous fan-out, handler errors are caught and logged. No
 *     buffering, no async queues — matches the router's ergonomics.
 *
 * ## Host-based factory
 *
 * {@link createEventPublisher} captures a {@link SkillHost} and wires
 * the module-level singletons that the session manager and other
 * consumers import. Calling the factory before those consumers run is a
 * startup ordering requirement — the module-level thunks throw a clear
 * error if invoked before the host is installed.
 *
 * Consumers that want to read the stream should call
 * `subscribeToMeetingEvents(meetingId, cb)` rather than calling
 * `MeetSessionEventRouter.register` directly. That way adding a new
 * consumer never steps on an existing one.
 */

import type { Logger, SkillHost } from "@vellumai/skill-host-contracts";

import type { MeetBotEvent } from "../contracts/index.js";

import { registerSubModule } from "./modules-registry.js";
import { getMeetSessionEventRouter } from "./session-event-router.js";

// ---------------------------------------------------------------------------
// Event-kind discriminator
// ---------------------------------------------------------------------------

/**
 * Outbound meet-event `type` values. One per `meet.*` `ServerMessage`
 * discriminator in `assistant/src/daemon/message-types/meet.ts`.
 */
export type MeetEventKind =
  | "meet.joining"
  | "meet.joined"
  | "meet.participant_changed"
  | "meet.speaker_changed"
  | "meet.transcript_chunk"
  | "meet.left"
  | "meet.chat_sent"
  | "meet.error"
  | "meet.speaking_started"
  | "meet.speaking_ended";

// ---------------------------------------------------------------------------
// MeetEventDispatcher — per-meeting fan-out shim
// ---------------------------------------------------------------------------

/** Callback invoked for each bot event on a subscribed meeting. */
export type MeetEventSubscriber = (event: MeetBotEvent) => void;

/** Unsubscribe handle returned by {@link subscribeToMeetingEvents}. */
export type MeetEventUnsubscribe = () => void;

/**
 * Process-wide fan-out map for per-meeting bot events. One instance, many
 * subscribers per meeting id. Singleton so cross-cutting subscribers
 * (publisher, bridge, storage, consent) agree on the same dispatch target.
 *
 * The dispatcher holds no references to `assistant/` — it uses the
 * factory-supplied logger for its internal diagnostics, so constructing
 * it requires a {@link Logger} rather than reaching for a global.
 */
class MeetEventDispatcher {
  private readonly subs = new Map<string, Set<MeetEventSubscriber>>();

  constructor(private readonly log: Logger) {}

  subscribe(meetingId: string, cb: MeetEventSubscriber): MeetEventUnsubscribe {
    let set = this.subs.get(meetingId);
    if (!set) {
      set = new Set();
      this.subs.set(meetingId, set);
    }
    set.add(cb);
    return () => {
      const existing = this.subs.get(meetingId);
      if (!existing) return;
      existing.delete(cb);
      if (existing.size === 0) this.subs.delete(meetingId);
    };
  }

  dispatch(meetingId: string, event: MeetBotEvent): void {
    const set = this.subs.get(meetingId);
    if (!set || set.size === 0) return;
    // Snapshot so a callback removing itself mid-iteration doesn't skip
    // a neighbor or trip a concurrent-modification hazard.
    for (const cb of Array.from(set)) {
      try {
        cb(event);
      } catch (err) {
        this.log.error("Meet event subscriber threw", {
          err,
          meetingId,
          eventType: event.type,
        });
      }
    }
  }

  /** Drop all subscribers for a meeting. Called from the session manager on leave. */
  clear(meetingId: string): void {
    this.subs.delete(meetingId);
  }

  /** Current subscriber count for a meeting. Exposed for tests. */
  subscriberCount(meetingId: string): number {
    return this.subs.get(meetingId)?.size ?? 0;
  }

  /** Reset all state. Tests only. */
  _resetForTests(): void {
    this.subs.clear();
  }
}

// ---------------------------------------------------------------------------
// EventPublisher facade
// ---------------------------------------------------------------------------

/**
 * Bundle returned by {@link createEventPublisher}. Holds the per-meeting
 * dispatcher and the host-backed publish helpers that previously reached
 * into `assistant/` via top-level imports.
 */
export interface EventPublisher {
  readonly dispatcher: MeetEventDispatcher;
  publishMeetEvent(
    meetingId: string,
    kind: MeetEventKind,
    payload: Record<string, unknown>,
  ): Promise<void>;
  subscribeToMeetingEvents(
    meetingId: string,
    cb: MeetEventSubscriber,
  ): MeetEventUnsubscribe;
  registerMeetingDispatcher(meetingId: string): void;
  unregisterMeetingDispatcher(meetingId: string): void;
  subscribeEventHubPublisher(meetingId: string): MeetEventUnsubscribe;
}

/**
 * Build the Meet event publisher against a {@link SkillHost}. Called
 * once by `register(host)` at daemon startup; also stashes the
 * resulting bundle on a module-level singleton so the module-scoped
 * exports (`publishMeetEvent`, `meetEventDispatcher`, …) that the
 * session manager imports keep working.
 */
export function createEventPublisher(host: SkillHost): EventPublisher {
  const log = host.logger.get("meet-event-publisher");
  const dispatcher = new MeetEventDispatcher(log);

  const publisher: EventPublisher = {
    dispatcher,

    publishMeetEvent(
      meetingId: string,
      kind: MeetEventKind,
      payload: Record<string, unknown>,
    ): Promise<void> {
      // Narrow the composed literal to the host's wire-level `ServerMessage`
      // — every `meet.*` kind has a matching variant in the daemon-side
      // discriminated union, but TypeScript can't infer that from a
      // string-keyed payload at this boundary.
      const message = { type: kind, meetingId, ...payload };
      const event = host.events.buildEvent(message);
      return host.events.publish(event).catch((err) => {
        log.warn("Failed to publish meet event", { err, meetingId, kind });
      });
    },

    subscribeToMeetingEvents(
      meetingId: string,
      cb: MeetEventSubscriber,
    ): MeetEventUnsubscribe {
      return dispatcher.subscribe(meetingId, cb);
    },

    registerMeetingDispatcher(meetingId: string): void {
      getMeetSessionEventRouter().register(meetingId, (event) => {
        dispatcher.dispatch(meetingId, event);
      });
    },

    unregisterMeetingDispatcher(meetingId: string): void {
      getMeetSessionEventRouter().unregister(meetingId);
      dispatcher.clear(meetingId);
    },

    subscribeEventHubPublisher(meetingId: string): MeetEventUnsubscribe {
      return publisher.subscribeToMeetingEvents(meetingId, (event) => {
        switch (event.type) {
          case "participant.change":
            void publisher.publishMeetEvent(
              meetingId,
              "meet.participant_changed",
              {
                joined: event.joined,
                left: event.left,
              },
            );
            return;
          case "speaker.change":
            void publisher.publishMeetEvent(meetingId, "meet.speaker_changed", {
              speakerId: event.speakerId,
              speakerName: event.speakerName,
            });
            return;
          case "transcript.chunk": {
            if (!event.isFinal) return;
            const payload: Record<string, unknown> = { text: event.text };
            if (event.speakerLabel !== undefined)
              payload.speakerLabel = event.speakerLabel;
            if (event.speakerId !== undefined)
              payload.speakerId = event.speakerId;
            if (event.confidence !== undefined)
              payload.confidence = event.confidence;
            void publisher.publishMeetEvent(
              meetingId,
              "meet.transcript_chunk",
              payload,
            );
            return;
          }
          default:
            // Ignore event kinds we don't fan out from the router path.
            // Lifecycle transitions are published by the session manager.
            // Inbound chat + interim transcripts are intentionally dropped.
            return;
        }
      });
    },
  };

  installedPublisher = publisher;
  return publisher;
}

// ---------------------------------------------------------------------------
// Module-scoped thunks
// ---------------------------------------------------------------------------
//
// Session-manager imports these names directly. They delegate to the
// singleton that `createEventPublisher(host)` installed at startup.
// Calling before installation throws a loud error so wiring bugs
// surface early rather than silently dispatching into the void.

let installedPublisher: EventPublisher | null = null;

function requirePublisher(): EventPublisher {
  if (!installedPublisher) {
    throw new Error(
      "meet-join event-publisher: createEventPublisher(host) was not invoked " +
        "before a module-scoped export was accessed. Ensure the skill's " +
        "register(host) entry point ran during daemon bootstrap.",
    );
  }
  return installedPublisher;
}

/**
 * Publish a Meet lifecycle/transcript/participant/speaker event via the
 * installed host. See {@link EventPublisher.publishMeetEvent}.
 *
 * `payload` is merged with `{ type: kind, meetingId }` to form the message
 * body — callers must not include `type` or `meetingId` in `payload` or
 * they will conflict with the discriminator.
 *
 * Errors from subscribers are logged but never rethrown: a slow or broken
 * consumer on the SSE side must not break the active meeting.
 */
export function publishMeetEvent(
  meetingId: string,
  kind: MeetEventKind,
  payload: Record<string, unknown>,
): Promise<void> {
  return requirePublisher().publishMeetEvent(meetingId, kind, payload);
}

/**
 * Process-level singleton dispatcher facade. Delegates to the dispatcher
 * constructed by {@link createEventPublisher}. Retained so test harnesses
 * and the session manager can use the same API they used pre-migration.
 */
export const meetEventDispatcher = {
  subscribe(meetingId: string, cb: MeetEventSubscriber): MeetEventUnsubscribe {
    return requirePublisher().dispatcher.subscribe(meetingId, cb);
  },
  dispatch(meetingId: string, event: MeetBotEvent): void {
    requirePublisher().dispatcher.dispatch(meetingId, event);
  },
  clear(meetingId: string): void {
    requirePublisher().dispatcher.clear(meetingId);
  },
  subscriberCount(meetingId: string): number {
    return requirePublisher().dispatcher.subscriberCount(meetingId);
  },
  _resetForTests(): void {
    // Tolerate tests that reset before any factory has been wired — the
    // dispatcher is state-free in that case, so there is nothing to clear.
    installedPublisher?.dispatcher._resetForTests();
  },
};

/**
 * Subscribe to raw bot events for a meeting. Safe for multiple callers.
 * Returns an unsubscribe function.
 */
export function subscribeToMeetingEvents(
  meetingId: string,
  cb: MeetEventSubscriber,
): MeetEventUnsubscribe {
  return requirePublisher().subscribeToMeetingEvents(meetingId, cb);
}

/**
 * Install the single `MeetSessionEventRouter` handler for a meeting. The
 * handler forwards every incoming event into the dispatcher so multiple
 * subscribers can observe the stream.
 */
export function registerMeetingDispatcher(meetingId: string): void {
  requirePublisher().registerMeetingDispatcher(meetingId);
}

/**
 * Tear down the router handler and drop all dispatcher subscribers for a
 * meeting. Symmetric with {@link registerMeetingDispatcher}.
 */
export function unregisterMeetingDispatcher(meetingId: string): void {
  requirePublisher().unregisterMeetingDispatcher(meetingId);
}

/**
 * Subscribe the event-hub publisher to a meeting's bot-event stream so
 * `participant.change`, `speaker.change`, and final transcript chunks
 * fan out as the matching `meet.*` events on the host's event hub.
 *
 * Lifecycle transitions are NOT handled here — the session manager
 * publishes `meet.joining`, `meet.joined`, `meet.left`, and `meet.error`
 * directly at the points it controls.
 */
export function subscribeEventHubPublisher(
  meetingId: string,
): MeetEventUnsubscribe {
  return requirePublisher().subscribeEventHubPublisher(meetingId);
}

/**
 * Test-only helper. Clears the installed publisher so a fresh host can be
 * wired in from the next test case. Production code must never call this.
 */
export function _resetEventPublisherForTests(): void {
  installedPublisher = null;
}

// ---------------------------------------------------------------------------
// Sub-module registration
// ---------------------------------------------------------------------------
//
// The session manager pulls sub-module factories from the in-skill
// registry (see `modules-registry.ts`) by name, so a static import of
// this file from `register.ts` / the session manager is enough to
// populate the slot without the session manager taking a direct import
// on this module.

registerSubModule("event-publisher", createEventPublisher);
