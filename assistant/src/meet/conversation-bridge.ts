/**
 * MeetConversationBridge — turns bot-side meet events into conversation
 * messages and live ephemeral updates.
 *
 * The bridge is a single-meeting subscriber on
 * {@link MeetSessionEventRouter}. It fans incoming {@link MeetBotEvent}s
 * into three sinks:
 *
 *   1. **Final transcripts** (`transcript.chunk` with `isFinal === true`)
 *      are persisted as `"user"` messages in the conversation with a
 *      `[<speakerName>]: <text>` attribution. Speaker metadata
 *      (`meetSpeakerLabel`, `meetSpeakerId`, `meetSpeakerName`,
 *      `meetTimestamp`) rides in the message metadata so later PRs can
 *      surface the raw speaker context without re-parsing the content.
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
 * resolver); this bridge is a no-op for them.
 *
 * Dependency injection keeps the bridge test-friendly: the message-insert
 * function and the router / event-hub can all be supplied at construction
 * time so unit tests never need to spin up SQLite or the real singleton.
 * PR 21 will extend this bridge to call the speaker resolver before
 * every final-transcript insert to arbitrate Deepgram vs DOM speaker
 * attribution — the `speakerLabel` / `speakerName` / `speakerId`
 * carried on the event today are the raw Deepgram values.
 */

import type { MeetBotEvent } from "@vellumai/meet-contracts";

import type { ServerMessage } from "../daemon/message-protocol.js";
import { buildAssistantEvent } from "../runtime/assistant-event.js";
import { assistantEventHub as defaultAssistantEventHub } from "../runtime/assistant-event-hub.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../runtime/assistant-scope.js";
import { getLogger } from "../util/logger.js";
import {
  getMeetSessionEventRouter,
  type MeetSessionEventHandler,
  type MeetSessionEventRouter,
} from "./session-event-router.js";

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

export interface MeetConversationBridgeDeps {
  /** Required: the per-meeting id the router keys on. */
  meetingId: string;
  /** Required: the target conversation to write into. */
  conversationId: string;
  /** Required: wrapper around `addMessage` — injected for tests. */
  insertMessage: InsertMessageFn;
  /** Optional: override the router (defaults to the process singleton). */
  router?: MeetSessionEventRouter;
  /** Optional: override the event hub (defaults to the process singleton). */
  assistantEventHub?: AssistantEventPublisher;
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
  private readonly router: MeetSessionEventRouter;
  private readonly hub: AssistantEventPublisher;
  private readonly assistantId: string;
  private subscribed = false;

  constructor(deps: MeetConversationBridgeDeps) {
    this.meetingId = deps.meetingId;
    this.conversationId = deps.conversationId;
    this.insertMessage = deps.insertMessage;
    this.router = deps.router ?? getMeetSessionEventRouter();
    this.hub = deps.assistantEventHub ?? defaultAssistantEventHub;
    this.assistantId = deps.assistantId ?? DAEMON_INTERNAL_ASSISTANT_ID;
  }

  /**
   * Register this bridge as the handler for its `meetingId` on the
   * router. Overwrites any prior registration (the router logs a warning
   * in that case). Idempotent within a single instance — calling twice
   * just re-registers the same handler.
   */
  subscribe(): void {
    const handler: MeetSessionEventHandler = (event) => {
      // Defer to async-aware branch but don't block the router — late
      // errors are logged, not surfaced.
      void this.handleEvent(event).catch((err) => {
        log.error(
          { err, meetingId: this.meetingId, eventType: event.type },
          "MeetConversationBridge: handler failed",
        );
      });
    };
    this.router.register(this.meetingId, handler);
    this.subscribed = true;
  }

  /**
   * Remove this bridge's registration from the router. Safe to call
   * multiple times and before `subscribe()`.
   */
  unsubscribe(): void {
    this.router.unregister(this.meetingId);
    this.subscribed = false;
  }

  /** Whether this bridge currently holds a router registration. */
  isSubscribed(): boolean {
    return this.subscribed;
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
        // PR 18 (storage writer) / PR 21 (speaker resolver) own this.
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

    // PR 21 will replace `speakerName` / `speakerId` with resolver output
    // before building the attribution; for now we use the raw Deepgram
    // metadata the event carries.
    const speakerName = event.speakerLabel ?? "Unknown speaker";
    const attributed = `[${speakerName}]: ${text}`;
    const content = JSON.stringify([{ type: "text", text: attributed }]);

    const metadata: Record<string, unknown> = {
      meetingId: this.meetingId,
      meetTimestamp: event.timestamp,
    };
    if (event.speakerLabel !== undefined) {
      metadata.meetSpeakerLabel = event.speakerLabel;
    }
    if (event.speakerId !== undefined) {
      metadata.meetSpeakerId = event.speakerId;
    }
    metadata.meetSpeakerName = speakerName;

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
