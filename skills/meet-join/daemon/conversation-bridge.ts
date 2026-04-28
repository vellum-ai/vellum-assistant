/**
 * MeetConversationBridge — turns bot-side meet events into conversation
 * messages and live ephemeral updates.
 *
 * The bridge subscribes to a meeting's bot-event stream via
 * {@link subscribeToMeetingEvents} and fans incoming {@link MeetBotEvent}s
 * into four sinks:
 *
 *   1. Final transcripts (`transcript.chunk` with `isFinal === true`) are
 *      run through {@link MeetSpeakerResolver} to arbitrate provider vs
 *      DOM speaker attribution, then persisted as `"user"` messages with
 *      a `[<speakerName>]: <text>` attribution. Speaker metadata
 *      (`meetSpeakerLabel`, `meetSpeakerId`, `meetSpeakerName`,
 *      `meetSpeakerConfidence`, `meetTimestamp`) rides in the message
 *      metadata so later PRs can surface the raw speaker context without
 *      re-parsing the content.
 *
 *   2. Interim transcripts (`transcript.chunk` with `isFinal === false`)
 *      are NOT persisted. They are published via the host's event hub as
 *      `meet.transcript_interim` so live clients can render in-progress
 *      text and have it superseded once a final chunk arrives.
 *
 *   3. Inbound chat (`chat.inbound`) is persisted as a `"user"` message
 *      prefixed with `"[Meet chat] <fromName>: <text>"` — this is the
 *      repo's existing "tag it in the content" pattern used by pointer
 *      and call messages.
 *
 *   4. Participant changes (`participant.change`) are persisted as short
 *      `"user"`-role lines (`"[Meeting] <name> joined"` /
 *      `"[Meeting] <name> left"`) with `automated: true` in metadata so
 *      they don't pollute memory indexing. Using `"user"` role keeps
 *      untrusted participant names from carrying assistant-level
 *      authority in model context.
 *
 * `speaker.change` and `lifecycle` are intentionally consumed elsewhere
 * (storage writer, lifecycle listener, speaker resolver); this bridge is
 * a no-op for them at the top level, though the resolver transparently
 * observes `speaker.change` via its own subscription.
 *
 * ## Host-based factory
 *
 * The module previously reached into `assistant/` for `buildAssistantEvent`,
 * `assistantEventHub`, `getLogger`, and `DAEMON_INTERNAL_ASSISTANT_ID`. The
 * skill-isolation plan replaces those with the runtime-injected
 * {@link SkillHost}. {@link createConversationBridge} captures a host and
 * returns a builder that constructs {@link MeetConversationBridge}
 * instances with host-backed defaults pre-wired; each instance's deps bag
 * still accepts overrides so tests can inject shims without threading a
 * full host through.
 */

import type {
  AssistantEvent,
  Logger,
  ServerMessage,
  SkillHost,
} from "@vellumai/skill-host-contracts";
import { buildAssistantEvent } from "@vellumai/skill-host-contracts";

import type { MeetBotEvent } from "../contracts/index.js";

import {
  type MeetEventSubscriber,
  type MeetEventUnsubscribe,
  subscribeToMeetingEvents as defaultSubscribeToMeetingEvents,
} from "./event-publisher.js";
import { registerSubModule } from "./modules-registry.js";
import { MeetSpeakerResolver } from "./speaker-resolver.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Narrow shape of `addMessage` from the assistant's memory module — the
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

/** Minimal hub surface the bridge depends on — matches `host.events`. */
export interface AssistantEventPublisher {
  publish: (event: AssistantEvent) => Promise<void>;
}

/**
 * Subscribe shim — injected for tests so they can route events through a
 * local dispatcher without hitting the process-level singleton.
 */
export type SubscribeToMeetingEventsFn = (
  meetingId: string,
  cb: MeetEventSubscriber,
) => MeetEventUnsubscribe;

/**
 * Build an {@link AssistantEvent} envelope. The default uses the neutral
 * `buildAssistantEvent` from `@vellumai/skill-host-contracts`; tests may
 * inject a recorder.
 */
export type BuildEventFn = (
  message: ServerMessage,
  conversationId?: string,
) => AssistantEvent;

export interface MeetConversationBridgeDeps {
  /** Required: the per-meeting id the dispatcher keys on. */
  meetingId: string;
  /** Required: the target conversation to write into. */
  conversationId: string;
  /** Required: wrapper around `addMessage` — injected for tests. */
  insertMessage: InsertMessageFn;
  /**
   * Optional: override the dispatcher subscribe function. Defaults to the
   * legacy module-level thunk from `event-publisher.ts`.
   */
  subscribeToMeetingEvents?: SubscribeToMeetingEventsFn;
  /**
   * Optional: override the event hub (defaults to whatever
   * {@link createConversationBridge} captured, or — for tests that build
   * the class directly — falls back to a no-op implementation).
   */
  assistantEventHub?: AssistantEventPublisher;
  /**
   * Optional: override the speaker resolver. The bridge constructs a
   * default resolver using the same `subscribeToMeetingEvents` so tests
   * that wire a custom dispatcher get a resolver on the same stream.
   */
  resolver?: MeetSpeakerResolver;
  /**
   * Optional: structural logger. Defaults to a host-backed logger when the
   * factory is used, or a console-wrapping shim when the class is
   * constructed directly without a host.
   */
  log?: Logger;
  /**
   * Optional: override the `AssistantEvent` builder. Defaults to the
   * pure-function {@link buildAssistantEvent} in
   * `@vellumai/skill-host-contracts`.
   */
  buildEvent?: BuildEventFn;
}

// ---------------------------------------------------------------------------
// Fallback logger
// ---------------------------------------------------------------------------

/**
 * Structural logger used when a bridge is constructed without a host or
 * explicit `log` dep. The default pipes through `console.*` so test
 * failures still surface — callers that want structured output wire in a
 * host-backed logger via the factory.
 */
const consoleFallbackLogger: Logger = {
  // eslint-disable-next-line no-console
  debug: (msg, meta) => console.debug(msg, meta),
  // eslint-disable-next-line no-console
  info: (msg, meta) => console.info(msg, meta),
  // eslint-disable-next-line no-console
  warn: (msg, meta) => console.warn(msg, meta),
  // eslint-disable-next-line no-console
  error: (msg, meta) => console.error(msg, meta),
};

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

export class MeetConversationBridge {
  private readonly meetingId: string;
  private readonly conversationId: string;
  private readonly insertMessage: InsertMessageFn;
  private readonly subscribeFn: SubscribeToMeetingEventsFn;
  private readonly hub: AssistantEventPublisher | null;
  private readonly resolver: MeetSpeakerResolver;
  private readonly log: Logger;
  private readonly buildEvent: BuildEventFn;
  private unsubscribeFn: MeetEventUnsubscribe | null = null;

  constructor(deps: MeetConversationBridgeDeps) {
    this.meetingId = deps.meetingId;
    this.conversationId = deps.conversationId;
    this.insertMessage = deps.insertMessage;
    this.subscribeFn =
      deps.subscribeToMeetingEvents ?? defaultSubscribeToMeetingEvents;
    // No direct daemon-singleton fallback — callers that don't provide a
    // hub get a no-op publish so the bridge still installs cleanly.
    this.hub = deps.assistantEventHub ?? null;
    this.resolver =
      deps.resolver ??
      new MeetSpeakerResolver({
        meetingId: deps.meetingId,
        subscribe: this.subscribeFn,
      });
    this.log = deps.log ?? consoleFallbackLogger;
    this.buildEvent = deps.buildEvent ?? buildAssistantEvent;
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
        this.log.error("MeetConversationBridge: handler failed", {
          err,
          meetingId: this.meetingId,
          eventType: event.type,
        });
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
        this.log.warn("MeetConversationBridge: dispatcher unsubscribe threw", {
          err,
          meetingId: this.meetingId,
        });
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
        // The lifecycle listener owns this.
        return;
      default: {
        const exhaustiveCheck: never = event;
        this.log.warn("MeetConversationBridge: unknown event type", {
          meetingId: this.meetingId,
          event: exhaustiveCheck,
        });
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
      // Preserve the raw provider speakerId even when the resolver didn't
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
    const message: ServerMessage = {
      type: "meet.transcript_interim",
      meetingId: this.meetingId,
      conversationId: this.conversationId,
      timestamp: event.timestamp,
      text: event.text,
      speakerLabel: event.speakerLabel,
      speakerId: event.speakerId,
      confidence: event.confidence,
    };

    if (!this.hub) return;

    try {
      await this.hub.publish(this.buildEvent(message, this.conversationId));
    } catch (err) {
      this.log.warn("MeetConversationBridge: interim publish failed", {
        err,
        meetingId: this.meetingId,
      });
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
    // Emit one short status line per join/leave so the conversation stays
    // readable — one batched summary would hide concurrent moves. Persisted
    // as "user" with `automated: true` so untrusted participant names never
    // carry assistant-level authority in model context.
    for (const participant of event.joined) {
      const safeName = sanitizeParticipantName(participant.name);
      const line = `[Meeting] ${safeName} joined`;
      await this.insertMessage(
        this.conversationId,
        "user",
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
      const safeName = sanitizeParticipantName(participant.name);
      const line = `[Meeting] ${safeName} left`;
      await this.insertMessage(
        this.conversationId,
        "user",
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

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Inputs a caller still needs to supply when building a bridge via the
 * factory. The factory injects host-derived fields (hub, logger, assistant
 * id, event builder) so consumers only think about the per-meeting bits.
 */
export interface BuildConversationBridgeArgs {
  meetingId: string;
  conversationId: string;
  insertMessage: InsertMessageFn;
  subscribeToMeetingEvents?: SubscribeToMeetingEventsFn;
  resolver?: MeetSpeakerResolver;
}

export interface ConversationBridgeBuilder {
  (args: BuildConversationBridgeArgs): MeetConversationBridge;
}

/**
 * Build the conversation-bridge factory against a {@link SkillHost}. The
 * returned function is the production entry point: callers pass
 * per-meeting args and receive a fully wired {@link MeetConversationBridge}
 * with host-backed publish, log, and identity dependencies.
 */
export function createConversationBridge(
  host: SkillHost,
): ConversationBridgeBuilder {
  const log = host.logger.get("meet-conversation-bridge");
  const buildEvent: BuildEventFn = (message, conversationId) =>
    host.events.buildEvent(message, conversationId);

  return (args) =>
    new MeetConversationBridge({
      meetingId: args.meetingId,
      conversationId: args.conversationId,
      insertMessage: args.insertMessage,
      subscribeToMeetingEvents: args.subscribeToMeetingEvents,
      resolver: args.resolver,
      assistantEventHub: host.events,
      log,
      buildEvent,
    });
}

/**
 * Strip control characters and collapse whitespace in a participant display
 * name so it can't inject newlines, tabs, or other formatting tricks when
 * persisted as message content. Truncated to 100 chars to bound the attack
 * surface of absurdly long names.
 */
function sanitizeParticipantName(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim()
    .slice(0, 100);
}

// ---------------------------------------------------------------------------
// Sub-module registration
// ---------------------------------------------------------------------------
//
// The factory slot here is `createConversationBridge` — consumers (the
// session manager) pull the builder via `getSubModule` instead
// of taking a static import on this file.

registerSubModule("conversation-bridge", createConversationBridge);
