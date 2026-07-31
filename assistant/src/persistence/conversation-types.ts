// The canonical conversation-type union — how a conversation was created / what
// execution mode it runs in. Defined here (a leaf) so the create path in
// `conversation-crud.ts`, the notification pipeline, and read-side filters
// share one declaration without importing the heavy CRUD module. Also provides
// the shared "is this a non-interactive / background conversation?" predicate
// used by notification-feed and memory filters, the source-aware
// `resolveConversationKind` classifier, and the pure predicates over a
// persisted message's `metadata` record.

import { parseChannelId } from "../channels/types.js";

/**
 * Canonical `conversations.source` string for background memory v2
 * consolidation runs. A persisted column value, so it lives with the rest of
 * the conversation vocabulary rather than inside the memory plugin that
 * writes it (persistence must not depend on a plugin).
 */
// FROZEN: persisted `conversations.source` value. Never rename it.
export const MEMORY_V2_CONSOLIDATION_SOURCE = "memory_v2_consolidation";

/** How a conversation was created / its execution mode. */
export type ConversationCreateType = "standard" | "background" | "scheduled";

/** Read-side alias of {@link ConversationCreateType}. */
export type ConversationType = ConversationCreateType;

/**
 * Conversation types created by background machinery (heartbeat runs,
 * scheduled runs, retrospective forks) rather than by a person. Exported as a
 * list so SQL filters (e.g. `notInArray`) share the same set as the predicate
 * below.
 */
export const BACKGROUND_CONVERSATION_TYPES = [
  "background",
  "scheduled",
] as const satisfies readonly ConversationType[];

// Tolerant of null/undefined/unknown strings so it can be called directly on
// raw DB column values without pre-validation.
export function isBackgroundConversationType(
  t: ConversationType | string | null | undefined,
): boolean {
  return (BACKGROUND_CONVERSATION_TYPES as readonly string[]).includes(t ?? "");
}

/**
 * Who or what drove a conversation, folding the `source` and `conversationType`
 * columns into one label.
 */
export type ConversationKind =
  | "user"
  | "background"
  | "background_memory_consolidation"
  | "scheduled";

/**
 * Single classifier shared by the LLM-context routes and the notification
 * producers, so a new background source or conversation type lands in every
 * consumer at once.
 */
export function resolveConversationKind(
  source: string,
  conversationType: string,
): ConversationKind {
  if (source === MEMORY_V2_CONSOLIDATION_SOURCE) {
    return "background_memory_consolidation";
  }
  if (conversationType === "background") {
    return "background";
  }
  if (conversationType === "scheduled") {
    return "scheduled";
  }
  return "user";
}

/**
 * Shared predicate for the transcript-suppression flag on user-message
 * metadata (the `hidden` field of the persisted `metadata` column). One
 * definition so the sites that must agree (echo suppression, list-messages
 * filtering, queued-snapshot filtering, indexing exclusion, and downstream
 * consumers of message text) cannot drift.
 */
export function isHiddenMessageMetadata(
  metadata: Record<string, unknown> | null | undefined,
): boolean {
  return metadata?.hidden === true;
}

/**
 * True when the row is a persisted `<background_event source="...">` trigger.
 * Every wake, scheduled run, and backgrounded-tool completion stamps one (see
 * `persistWakeTriggerMessage`). The permission mode such a turn ran under
 * varies (most run interactive; clientless/headless wakes do not) and is
 * recorded separately in `backgroundEventInteractive`; this predicate only
 * identifies the row as a background event.
 */
export function isBackgroundEventMetadata(
  metadata: Record<string, unknown> | undefined,
): boolean {
  return typeof metadata?.backgroundEventSource === "string";
}

/**
 * True when a role-`"user"` row is internal scaffolding rather than a person's
 * prompt: a daemon-injected run lifecycle notification (subagent
 * `subagentNotification`, ACP run `acpNotification`, or any wake trigger, the
 * persisted `<background_event source="...">` row every wake reads), or a row
 * explicitly flagged `hidden` (e.g. a hidden `POST /messages` send that queued
 * behind an in-flight turn, like the channel-setup wizard-close marker).
 *
 * These rows are persisted so the orchestrator wakes and reads the trigger,
 * but the user sees the wake through its inline card ("Conversation Woke", or
 * a terminal card for a backgrounded bash run), not a chat turn. One
 * definition so the sites that must agree cannot drift: the
 * `user_message_echo` broadcast (never render a live user bubble), the retry
 * route's hidden-prompt re-run, and {@link isReplyPushIneligibleUserMessage}
 * (a turn opened by one of these rows is not a user prompt awaiting a reply).
 */
export function isEchoSuppressedUserMessage(
  metadata: Record<string, unknown> | undefined,
): boolean {
  return (
    isHiddenMessageMetadata(metadata) ||
    metadata?.subagentNotification != null ||
    metadata?.acpNotification != null ||
    isBackgroundEventMetadata(metadata)
  );
}

/**
 * True when a role-`"user"` row was persisted by the voice bridge for a live
 * phone call or in-app voice session (every row `startVoiceTurn` persists, see
 * `calls/voice-session-bridge.ts`).
 *
 * The reply to such a turn is spoken back over the still-open session, so any
 * consumer that treats a finished reply as something the user has yet to see
 * must skip it rather than push a notification for audio the user is hearing
 * right now.
 *
 * This marker is the only durable signal for that: the channel/interface fields
 * cannot stand in, because an in-app live-voice turn persists as
 * `vellum`/`macos`, indistinguishable from a typed desktop send.
 */
export function isVoiceSessionUserMessage(
  metadata: Record<string, unknown> | undefined,
): boolean {
  return metadata?.voiceSessionTurn === true;
}

/**
 * True when the row that opened the turn arrived over an external messaging
 * surface (Slack, Telegram, WhatsApp, email, a phone call) rather than the
 * native app.
 *
 * An absent (or unrecognized) channel counts as in-app: every external ingress
 * path stamps its channel via buildChannelMetadata, so the rows that omit the
 * field are daemon-internal persists on native-app conversations (for example
 * the deliberate omission in calls/call-pointer-messages.ts).
 */
function isChannelOriginatedUserMessage(
  metadata: Record<string, unknown> | undefined,
): boolean {
  const channel = parseChannelId(metadata?.userMessageChannel);
  return channel != null && channel !== "vellum";
}

/**
 * True when the reply to this row reaches the user over the surface the row
 * arrived on rather than the app: a messaging channel the finished reply is
 * delivered back to, or a still-open voice session that speaks it aloud.
 *
 * Both reasons describe where a reply lands, not what the row is, so they hold
 * only for a turn that keeps the row's original delivery orchestration.
 */
function isReplyDeliveredOffApp(
  metadata: Record<string, unknown> | undefined,
): boolean {
  return (
    isVoiceSessionUserMessage(metadata) ||
    isChannelOriginatedUserMessage(metadata)
  );
}

/**
 * True when a finished reply to this row must not raise a
 * `chat.assistant_reply` push. Five independent reasons, one predicate so the
 * producer's own gating and the batch-drain selection of the row it reads
 * cannot disagree: picking a row the producer then suppresses would swallow the
 * push for a genuine prompt coalesced into the same batch.
 *
 * - `automated`: a scheduled or background prompt injected into an ordinary
 *   user conversation, which has its own producer (e.g. `schedule.notify`).
 * - Echo-suppressed: internal scaffolding, nobody's prompt awaiting a reply.
 * - Voice-session: the reply is spoken back over the still-open session.
 * - Channel-originated: the finished reply is delivered back to the
 *   originating messaging surface (`finalizeEventDelivery`), so the sender
 *   already has it and a push would duplicate it on their phone.
 * - `pointerInstruction`: `runPointerMessageTurn` fact-checks the rows the turn
 *   generated only after the turn ends, and deletes them when validation fails
 *   so deterministic fallback copy takes their place. A push at turn end would
 *   already have carried the rejected text.
 *
 * `replyDeliveredInAppOnly` marks a turn whose reply streams to the app and
 * nowhere else: `POST /conversations/:id/retry` re-runs the anchor row through
 * the agent loop with no channel-delivery orchestration and no voice session
 * attached, so the two delivery-surface reasons ({@link isReplyDeliveredOffApp})
 * no longer describe it and suppressing the push would leave the user without a
 * copy anywhere. The other three reasons are properties of the row itself and
 * stand either way.
 */
export function isReplyPushIneligibleUserMessage(
  metadata: Record<string, unknown> | undefined,
  options?: { replyDeliveredInAppOnly?: boolean },
): boolean {
  return (
    metadata?.automated === true ||
    metadata?.pointerInstruction === true ||
    isEchoSuppressedUserMessage(metadata) ||
    (!options?.replyDeliveredInAppOnly && isReplyDeliveredOffApp(metadata))
  );
}
