/**
 * Meet event publisher — bridges the bot's wire-level events to
 * `assistantEventHub`-shaped lifecycle / transcript / participant / speaker
 * messages that macOS (and future) clients consume over the SSE route.
 *
 * Two concerns live here:
 *
 *  1. {@link publishMeetEvent} — builds a proper {@link AssistantEvent} via
 *     {@link buildAssistantEvent} and hands it to `assistantEventHub.publish`.
 *     Failures are swallowed and logged: a slow/broken SSE subscriber must
 *     never break the meeting.
 *
 *  2. {@link MeetEventDispatcher} — a thin fan-out for per-meeting bot
 *     events. The router upstream (`MeetSessionEventRouter`, PR 9) only
 *     allows *one* handler per meeting, which means the session manager
 *     must own the single registration and multiplex from there. Several
 *     PRs in the plan want to observe the same live event stream (this
 *     publisher for SSE, PR 17 for the conversation bridge, PR 18 for
 *     storage, PR 22 for consent). They all subscribe through this
 *     dispatcher rather than racing to replace each other at the router.
 *
 *     The dispatcher is intentionally cheap: a Map<meetingId, Set<cb>>,
 *     synchronous fan-out, handler errors are caught and logged. No
 *     buffering, no async queues — matches the router's ergonomics.
 *
 * Future PRs that want to read the stream should call
 * `subscribeToMeetingEvents(meetingId, cb)` rather than calling
 * `MeetSessionEventRouter.register` directly. That way adding a new
 * consumer never steps on an existing one.
 */

import type { MeetBotEvent } from "@vellumai/meet-contracts";

import type { ServerMessage } from "../../../assistant/src/daemon/message-protocol.js";
import { buildAssistantEvent } from "../../../assistant/src/runtime/assistant-event.js";
import { assistantEventHub } from "../../../assistant/src/runtime/assistant-event-hub.js";
import { getLogger } from "../../../assistant/src/util/logger.js";
import { getMeetSessionEventRouter } from "./session-event-router.js";

const log = getLogger("meet-event-publisher");

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
// publishMeetEvent
// ---------------------------------------------------------------------------

/**
 * Publish a Meet lifecycle/transcript/participant/speaker event to the
 * in-process `assistantEventHub`. Clients subscribed via SSE receive the
 * event in delivery order.
 *
 * `payload` is merged with `{ type: kind, meetingId }` to form the
 * `ServerMessage` body — callers must not include `type` or `meetingId`
 * in `payload` or they will conflict with the discriminator.
 *
 * Errors from subscribers are logged but never rethrown: a slow or broken
 * consumer on the SSE side must not break the active meeting. Returns a
 * promise that resolves when the publish call settles, for tests that
 * want to await delivery. Production callers can fire-and-forget.
 */
export function publishMeetEvent(
  assistantId: string,
  meetingId: string,
  kind: MeetEventKind,
  payload: Record<string, unknown>,
): Promise<void> {
  // Narrow the composed literal to `ServerMessage` — every `meet.*` kind
  // has a matching variant in the `ServerMessage` discriminated union, but
  // TypeScript can't infer the runtime match from a string-keyed payload.
  const message = { type: kind, meetingId, ...payload } as ServerMessage;
  const event = buildAssistantEvent(assistantId, message);
  return assistantEventHub.publish(event).catch((err) => {
    log.warn({ err, meetingId, kind }, "Failed to publish meet event");
  });
}

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
 */
class MeetEventDispatcher {
  private readonly subs = new Map<string, Set<MeetEventSubscriber>>();

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
        log.error(
          { err, meetingId, eventType: event.type },
          "Meet event subscriber threw",
        );
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

/** Process-level singleton dispatcher, shared across the meet subsystem. */
export const meetEventDispatcher = new MeetEventDispatcher();

/**
 * Subscribe to raw bot events for a meeting. Safe for multiple callers.
 * Returns an unsubscribe function.
 *
 * Use this from downstream consumers (conversation bridge, storage writer,
 * consent monitor) instead of calling `MeetSessionEventRouter.register`
 * directly — the router allows only one handler per meeting, and the
 * session manager owns that registration.
 */
export function subscribeToMeetingEvents(
  meetingId: string,
  cb: MeetEventSubscriber,
): MeetEventUnsubscribe {
  return meetEventDispatcher.subscribe(meetingId, cb);
}

// ---------------------------------------------------------------------------
// Router integration
// ---------------------------------------------------------------------------

/**
 * Install the single `MeetSessionEventRouter` handler for a meeting. The
 * handler forwards every incoming event into {@link meetEventDispatcher}
 * so multiple subscribers can observe the stream.
 *
 * The session manager calls this once per `join()` and pairs it with
 * {@link unregisterMeetingDispatcher} on `leave()`.
 */
export function registerMeetingDispatcher(meetingId: string): void {
  getMeetSessionEventRouter().register(meetingId, (event) => {
    meetEventDispatcher.dispatch(meetingId, event);
  });
}

/**
 * Tear down the router handler and drop all dispatcher subscribers for a
 * meeting. Symmetric with {@link registerMeetingDispatcher}.
 */
export function unregisterMeetingDispatcher(meetingId: string): void {
  getMeetSessionEventRouter().unregister(meetingId);
  meetEventDispatcher.clear(meetingId);
}

// ---------------------------------------------------------------------------
// Router → event-hub bridge
// ---------------------------------------------------------------------------

/**
 * Subscribe the event-hub publisher to a meeting's bot-event stream so
 * `participant.change`, `speaker.change`, and final transcript chunks
 * fan out as `meet.participant_changed` / `meet.speaker_changed` /
 * `meet.transcript_chunk` events on `assistantEventHub`.
 *
 * Lifecycle transitions are NOT handled here — the session manager
 * publishes `meet.joining`, `meet.joined`, `meet.left`, and `meet.error`
 * directly at the points it controls (join start, first joined lifecycle
 * event, leave, error) since those fire outside the bot-event stream
 * or carry richer context than the wire event provides.
 *
 * Returns an unsubscribe function the caller can invoke on leave.
 */
export function subscribeEventHubPublisher(
  assistantId: string,
  meetingId: string,
): MeetEventUnsubscribe {
  return subscribeToMeetingEvents(meetingId, (event) => {
    switch (event.type) {
      case "participant.change":
        void publishMeetEvent(
          assistantId,
          meetingId,
          "meet.participant_changed",
          {
            joined: event.joined,
            left: event.left,
          },
        );
        return;
      case "speaker.change":
        void publishMeetEvent(assistantId, meetingId, "meet.speaker_changed", {
          speakerId: event.speakerId,
          speakerName: event.speakerName,
        });
        return;
      case "transcript.chunk": {
        // Interim chunks are noisy and may be superseded by a later final
        // chunk covering the same time range. Clients only want stable text.
        if (!event.isFinal) return;
        const payload: Record<string, unknown> = { text: event.text };
        if (event.speakerLabel !== undefined)
          payload.speakerLabel = event.speakerLabel;
        if (event.speakerId !== undefined) payload.speakerId = event.speakerId;
        if (event.confidence !== undefined)
          payload.confidence = event.confidence;
        void publishMeetEvent(
          assistantId,
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
}
