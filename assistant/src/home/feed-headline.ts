/**
 * Headlines for feed rows.
 *
 * Titles used to be derived: when a producer or the decision engine did not
 * write one, the first sentence of the body was sliced off and used as the
 * header. That is where rows like "I wrote something about the rendere…" came
 * from, and it is why so many rows read as a truncated middle of a thought
 * rather than as a name for something.
 *
 * Nothing is sliced here. A row uses the title it was given, and when it was
 * given none it gets a written noun phrase for what kind of thing it is. A
 * generic-but-true headline over a sentence fragment: the body is right
 * underneath and says the specific part.
 */

import type { FeedItem } from "../api/responses/home.js";

/**
 * Written headline per source event, keyed by the `sourceEventName` the
 * producer emitted. Noun phrases, under 8 words, none of them starting with
 * "I". The copy contract applies to these as much as to model-written copy.
 */
const EVENT_HEADLINES: Readonly<Record<string, string>> = {
  "guardian.question": "Approval needed",
  "guardian.channel_activation": "Channel verification",
  "ingress.access_request": "Access request",
  "ingress.access_request.callback_handoff": "Callback requested",
  "ingress.trusted_contact.guardian_decision": "Trusted contact decision",
  "ingress.trusted_contact.activated": "Trusted contact activated",
  "credential.health_alert": "Connection needs attention",
  "tool_confirmation.required_action": "Confirmation needed",
  "schedule.notify": "Reminder",
  "schedule.definition_error": "Schedule could not be read",
  "user.send_notification": "From your assistant",
  "watcher.notification": "Watcher finding",
  "watcher.escalation": "Watcher escalation",
  "chat.assistant_reply": "Reply ready",
  "run.needs_input": "Waiting on you",
  "run.failed": "Run failed",
  "run.finished_notable": "Run finished",
};

/** Last-resort name for a row whose kind we have no headline for. */
const GENERIC_HEADLINE = "Notification";

/**
 * The headline for a row that has no title of its own.
 *
 * `sourceEventName` is the producer's event name; unknown names fall through
 * to a generic noun. Never returns an empty string.
 */
export function headlineForEvent(sourceEventName: string): string {
  return EVENT_HEADLINES[sourceEventName] ?? GENERIC_HEADLINE;
}

/**
 * The name to show for a feed row: its own title, or a written headline for
 * its kind. Never derived from the summary.
 */
export function resolveFeedItemHeadline(item: FeedItem): string {
  const title = item.title?.trim();
  if (title && title.length > 0) {
    return title;
  }
  if (item.type === "run") {
    return item.run?.kind
      ? headlineForEvent(`run.${item.run.state}`)
      : GENERIC_HEADLINE;
  }
  if (item.type === "system_health") {
    return "System health";
  }
  if (item.type === "digest") {
    return "Activity digest";
  }
  const eventName = item.metadata?.sourceEventName;
  return typeof eventName === "string"
    ? headlineForEvent(eventName)
    : GENERIC_HEADLINE;
}
