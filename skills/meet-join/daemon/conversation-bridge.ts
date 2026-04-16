/**
 * MeetConversationBridge — turns bot-side meet events into conversation
 * messages and live ephemeral updates.
 *
 * The bridge subscribes to a meeting's bot-event stream via
 * {@link subscribeToMeetingEvents} (the PR 19 fan-out dispatcher). It fans
 * incoming {@link MeetBotEvent}s into three sinks:
 *
 *   1. **Final transcripts** (`transcript.chunk` with `isFinal === true`)
 *      are run through {@link MeetSpeakerResolver} to arbitrate Deepgram
 *      vs DOM speaker attribution, then persisted as `"user"` messages
 *      with a `[<speakerName>]: <text>` attribution. Speaker metadata
 *      (`meetSpeakerLabel`, `meetSpeakerId`, `meetSpeakerName`,
 *      `meetSpeakerConfidence`, `meetTimestamp`) rides in the message
 *      metadata so later PRs can surface the raw speaker context without
 *      re-parsing the content.
 *
 *   2. **Interim transcripts** (`transcript.chunk` with `isFinal === false`)
 *      are NOT persisted. They are published via
 *      {@link assistantEventHub} as `meet.transcript_interim` so live
 *      clients can render in-progress text and have it superseded once a
 *      final chunk arrives.
 *
 *   3. **Inbound chat** (`chat.inbound`) is persisted as a `"user"`
 *      message prefixed with `"[Meet chat] <fromName>: <text>"` — this is
 *      the repo's existing "tag it in the content" pattern used by
 *      pointer / call messages (see `assistant/src/calls/call-pointer-messages.ts`).
 *
 *   4. **Participant changes** (`participant.change`) are persisted as
 *      short `"assistant"`-role lines (`"<name> joined"` / `"<name> left"`)
 *      with `automated: true` in metadata so they don't pollute memory
 *      indexing.
 *
 * `speaker.change` and `lifecycle` are intentionally consumed elsewhere
 * (PR 18 storage writer, PR 19 lifecycle listener, PR 21 speaker
 * resolver); this bridge is a no-op for them at the top level, though
 * the resolver transparently observes `speaker.change` via its own
 * subscription.
 *
 * Dependency injection keeps the bridge test-friendly: the message-insert
 * function, the dispatcher subscribe, the event hub, and the resolver
 * can all be supplied at construction time so unit tests never need to
 * spin up SQLite or the real singleton.
 */

import type { MeetBotEvent } from "../contracts/index.js";

import type { ServerMessage } from "../../../assistant/src/daemon/message-protocol.js";
import { buildAssistantEvent } from "../../../assistant/src/runtime/assistant-event.js";
import { assistantEventHub as defaultAssistantEventHub } from "../../../assistant/src/runtime/assistant-event-hub.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../../../assistant/src/runtime/assistant-scope.js";
import { getLogger } from "../../../assistant/src/util/logger.js";
import {
  type MeetEventSubscriber,
  type MeetEventUnsubscribe,
  subscribeToMeetingEvents as defaultSubscribeToMeetingEvents,
} from "./event-publisher.js";
import { MeetSpeakerResolver } from "./speaker-resolver.js";

const log = getLogger("meet-conversation-bridge");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Narrow shape of `addMessage` from `memory/conversation-crud.ts` — the
 * bridge only needs the subset of fields that the conversation message
 * insert path actually accepts. Declared locally so tests can supply a
 * recording shim without importing the full database module.
 */
export type InsertMessageFn = (
  conversationId: string,
  role: string,
  content: string,
  metadata?: Record<string, unknown>,
  opts?: { skipIndexing?: boolean },
) => Promise<{ id: string } & Record<string, unknown>>;

/** Minimal hub surface the bridge depends on — matches `assistantEventHub`. */
export interface AssistantEventPublisher {
  publish: (event: ReturnType<typeof buildAssistantEvent>) => Promise<void>;
}

/**
 * Subscribe shim — injected for tests so they can route events through a
 * local dispatcher without hitting the process-level singleton.
 */
export type SubscribeToMeetingEventsFn = (
  meetingId: string,
  cb: MeetEventSubscriber,
) => MeetEventUnsubscribe;

export interface MeetConversationBridgeDeps {
  /** Required: the per-meeting id the dispatcher keys on. */
  meetingId: string;
  /** Required: the target conversation to write into. */
  conversationId: string;
  /** Required: wrapper around `addMessage` — injected for tests. */
  insertMessage: InsertMessageFn;
  /**
   * Optional: override the dispatcher subscribe function. Defaults to the
   * process singleton {@link subscribeToMeetingEvents}.
   */
  subscribeToMeetingEvents?: SubscribeToMeetingEventsFn;
  /** Optional: override the event hub (defaults to the process singleton). */
  assistantEventHub?: AssistantEventPublisher;
  /**
   * Optional: override the speaker resolver. The bridge constructs a
   * default resolver using the same `subscribeToMeetingEvents` so tests
   * that wire a custom dispatcher get a resolver on the same stream.
   */
  resolver?: MeetSpeakerResolver;
  /**
   * Optional: override the assistant id on emitted interim events. The
   * daemon normally uses `DAEMON_INTERNAL_ASSISTANT_ID` ("self"); tests
   * may want to verify scope behavior.
   */
  assistantId?: string;
}

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

export class MeetConversationBridge {
  private readonly meetingId: string;
  private readonly conversationId: string;
  private readonly insertMessage: InsertMessageFn;
  private readonly subscribeFn: SubscribeToMeetingEventsFn;
  private readonly hub: AssistantEventPublisher;
  private readonly resolver: MeetSpeakerResolver;
  private readonly assistantId: string;
  private unsubscribeFn: MeetEventUnsubscribe | null = null;

  constructor(deps: MeetConversationBridgeDeps) {
    this.meetingId = deps.meetingId;
    this.conversationId = deps.conversationId;
    this.insertMessage = deps.insertMessage;
    this.subscribeFn =
      deps.subscribeToMeetingEvents ?? defaultSubscribeToMeetingEvents;
    this.hub = deps.assistantEventHub ?? defaultAssistantEventHub;
    this.resolver =
      deps.resolver ??
      new MeetSpeakerResolver({
        meetingId: deps.meetingId,
        subscribe: this.subscribeFn,
      });
    this.assistantId = deps.assistantId ?? DAEMON_INTERNAL_ASSISTANT_ID;
  }

  /**
   * Register this bridge as a subscriber on the dispatcher for its
   * `meetingId`. Idempotent — calling twice while already subscribed is
   * a no-op so callers don't need to track state themselves.
   */
  subscribe(): void {
    if (this.unsubscribeFn) return;
    this.unsubscribeFn = this.subscribeFn(this.meetingId, (event) => {
      // Defer to async-aware branch but don't block the dispatcher — late
      // errors are logged, not surfaced.
      void this.handleEvent(event).catch((err) => {
        log.error(
          { err, meetingId: this.meetingId, eventType: event.type },
          "MeetConversationBridge: handler failed",
        );
      });
    });
  }

  /**
   * Drop the dispatcher subscription and dispose the resolver. Safe to
   * call multiple times and before `subscribe()`.
   */
  unsubscribe(): void {
    if (this.unsubscribeFn) {
      try {
        this.unsubscribeFn();
      } catch (err) {
        log.warn(
          { err, meetingId: this.meetingId },
          "MeetConversationBridge: dispatcher unsubscribe threw",
        );
      }
      this.unsubscribeFn = null;
    }
    this.resolver.unsubscribe();
  }

  /** Whether this bridge currently holds a dispatcher subscription. */
  isSubscribed(): boolean {
    return this.unsubscribeFn !== null;
  }

  // ── Event dispatch ────────────────────────────────────────────────────────

  private async handleEvent(event: MeetBotEvent): Promise<void> {
    switch (event.type) {
      case "transcript.chunk":
        if (event.isFinal) {
          await this.handleFinalTranscript(event);
        } else {
          await this.handleInterimTranscript(event);
        }
        return;
      case "chat.inbound":
        await this.handleInboundChat(event);
        return;
      case "participant.change":
        await this.handleParticipantChange(event);
        return;
      case "speaker.change":
        // The resolver is a separate subscriber on this stream — the
        // bridge itself doesn't need to react to active-speaker changes.
        return;
      case "lifecycle":
        // PR 19 (lifecycle listener) owns this.
        return;
      default: {
        const exhaustiveCheck: never = event;
        log.warn(
          { meetingId: this.meetingId, event: exhaustiveCheck },
          "MeetConversationBridge: unknown event type",
        );
        return;
      }
    }
  }

  // ── Handlers ──────────────────────────────────────────────────────────────

  private async handleFinalTranscript(
    event: Extract<MeetBotEvent, { type: "transcript.chunk" }>,
  ): Promise<void> {
    const text = event.text.trim();
    if (text.length === 0) {
      // Empty final chunks sometimes arrive from ASR at segment boundaries —
      // skip them so they don't clutter the conversation.
      return;
    }

    const resolved = this.resolver.resolve(event);
    const speakerName = resolved.speakerName;
    const attributed = `[${speakerName}]: ${text}`;
    const content = JSON.stringify([{ type: "text", text: attributed }]);

    const metadata: Record<string, unknown> = {
      meetingId: this.meetingId,
      meetTimestamp: event.timestamp,
      meetSpeakerName: speakerName,
      meetSpeakerConfidence: resolved.confidence,
    };
    if (event.speakerLabel !== undefined) {
      metadata.meetSpeakerLabel = event.speakerLabel;
    }
    if (resolved.speakerId !== undefined) {
      metadata.meetSpeakerId = resolved.speakerId;
    } else if (event.speakerId !== undefined) {
      // Preserve the raw Deepgram speakerId even when the resolver didn't
      // produce a binding — it can still help downstream consumers pair
      // ASR segments to the same opaque speaker.
      metadata.meetSpeakerId = event.speakerId;
    }

    await this.insertMessage(this.conversationId, "user", content, metadata);
  }

  private async handleInterimTranscript(
    event: Extract<MeetBotEvent, { type: "transcript.chunk" }>,
  ): Promise<void> {
    // Never persisted — interim chunks are hub-only so the UI can render
    // live text that will be superseded by the next final chunk.
    const message = {
      type: "meet.transcript_interim",
      meetingId: this.meetingId,
      conversationId: this.conversationId,
      timestamp: event.timestamp,
      text: event.text,
      speakerLabel: event.speakerLabel,
      speakerId: event.speakerId,
      confidence: event.confidence,
    } as unknown as ServerMessage;

    try {
      await this.hub.publish(
        buildAssistantEvent(this.assistantId, message, this.conversationId),
      );
    } catch (err) {
      log.warn(
        { err, meetingId: this.meetingId },
        "MeetConversationBridge: interim publish failed",
      );
    }
  }

  private async handleInboundChat(
    event: Extract<MeetBotEvent, { type: "chat.inbound" }>,
  ): Promise<void> {
    const prefixed = `[Meet chat] ${event.fromName}: ${event.text}`;
    const content = JSON.stringify([{ type: "text", text: prefixed }]);

    await this.insertMessage(this.conversationId, "user", content, {
      meetingId: this.meetingId,
      meetTimestamp: event.timestamp,
      meetChatFromId: event.fromId,
      meetChatFromName: event.fromName,
      /** Marks the message as automated-source so memory indexing can downweight. */
      automated: true,
    });
  }

  private async handleParticipantChange(
    event: Extract<MeetBotEvent, { type: "participant.change" }>,
  ): Promise<void> {
    // Emit one short status line per join/leave so the conversation
    // stays readable — one batched summary would hide concurrent moves.
    for (const participant of event.joined) {
      const line = `${participant.name} joined`;
      await this.insertMessage(
        this.conversationId,
        "assistant",
        JSON.stringify([{ type: "text", text: line }]),
        {
          meetingId: this.meetingId,
          meetTimestamp: event.timestamp,
          meetParticipantId: participant.id,
          meetParticipantChange: "joined",
          automated: true,
        },
        { skipIndexing: true },
      );
    }

    for (const participant of event.left) {
      const line = `${participant.name} left`;
      await this.insertMessage(
        this.conversationId,
        "assistant",
        JSON.stringify([{ type: "text", text: line }]),
        {
          meetingId: this.meetingId,
          meetTimestamp: event.timestamp,
          meetParticipantId: participant.id,
          meetParticipantChange: "left",
          automated: true,
        },
        { skipIndexing: true },
      );
    }
  }
}
