/**
 * Predicates over user-message metadata shared by the daemon and the runtime
 * routes.
 *
 * They live in their own module rather than alongside the queue/drain code
 * that first needed them so both `conversation-messaging.ts` (enqueue) and
 * `conversation-process.ts` (drain) can import them without forming a cycle.
 */

import { isHiddenMessageMetadata } from "../persistence/conversation-crud.js";

/**
 * Daemon-injected run lifecycle notifications (subagent
 * `subagentNotification`, ACP run `acpNotification`, and any wake trigger:
 * the persisted `<background_event source="...">` row every wake reads) are
 * persisted into the parent conversation so the orchestrator wakes and reads
 * the trigger, but they are internal scaffolding. The user sees the wake
 * through its inline card ("Conversation Woke", or a terminal card for a
 * backgrounded bash run), not a chat turn. Skip the `user_message_echo`
 * broadcast for these so they never render as a live user bubble; the
 * persisted row is filtered from the rendered transcript on the client.
 *
 * The same predicate gates every user-facing view of the pending-message
 * queue: the `message_queued` / `message_dequeued` pair and the ack's
 * `position`, plus the queued rows `GET /v1/messages` synthesizes from the
 * in-memory queue. A notification awaiting drain therefore never appears as a
 * queued user bubble and never displaces a real queued message's position.
 *
 * Messages explicitly flagged `hidden` (a hidden `POST /messages` send that
 * queued behind an in-flight turn, e.g. the channel-setup wizard-close
 * marker) are suppressed the same way: the immediate route path already
 * skips their echo, and the persisted `hidden` metadata keeps them out of
 * the fetched transcript.
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
 * True when the row is a persisted `<background_event source="...">` trigger.
 * Every wake, scheduled run, and backgrounded-tool completion stamps one (see
 * {@link persistWakeTriggerMessage}). The permission mode such a turn ran under
 * varies (most run interactive; clientless/headless wakes do not) and is
 * recorded separately in `backgroundEventInteractive`; this predicate only
 * identifies the row as a background event.
 */
export function isBackgroundEventMetadata(
  metadata: Record<string, unknown> | undefined,
): boolean {
  return typeof metadata?.backgroundEventSource === "string";
}
