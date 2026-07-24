import type {
  SlackAppMentionEvent,
  SlackChannelMessageEvent,
  SlackDirectMessageEvent,
  SlackMessageChangedEvent,
  SlackMessageDeletedEvent,
  SlackReactionEvent,
} from "./normalize.js";

/** The Slack event shapes that flow through text extraction. */
export type SlackTextBearingEvent =
  | SlackAppMentionEvent
  | SlackDirectMessageEvent
  | SlackChannelMessageEvent
  | SlackMessageChangedEvent
  | SlackMessageDeletedEvent
  | SlackReactionEvent;

/**
 * Extract the user-authored text from a Slack event for mention/channel label
 * resolution and rendering.
 *
 * This runs on **untrusted** event data and **before** normalization: the
 * static types declare `text` as a string, but a Socket Mode payload can carry
 * any JSON value there. The downstream Slack text renderer calls
 * `text.matchAll`, so a truthy non-string would throw and take down the emit
 * path before the tolerant normalizer ever runs. Returning a string (or
 * undefined) keeps that path crash-safe.
 */
export function slackEventText(
  event: SlackTextBearingEvent,
): string | undefined {
  const raw =
    event.type === "message" &&
    (event as SlackMessageChangedEvent).subtype === "message_changed"
      ? (event as SlackMessageChangedEvent).message?.text
      : event.type === "app_mention" || event.type === "message"
        ? (event as SlackAppMentionEvent | SlackDirectMessageEvent).text
        : undefined;
  return typeof raw === "string" ? raw : undefined;
}
