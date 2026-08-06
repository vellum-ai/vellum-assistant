import type { SlackInboundEvent } from "./envelope.js";
import { classifySlackEvent } from "./classify-event.js";

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
export function slackEventText(event: SlackInboundEvent): string | undefined {
  const classified = classifySlackEvent(event);
  let raw: unknown;
  switch (classified?.kind) {
    // The edited body lives on the inner `message`, not the top level.
    case "message_changed":
      raw = classified.event.message?.text;
      break;
    case "app_mention":
    case "message":
      raw = classified.event.text;
      break;
    // message_deleted / reactions carry no user-authored text to resolve.
    default:
      raw = undefined;
  }
  return typeof raw === "string" ? raw : undefined;
}
