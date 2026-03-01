import type { GatewayConfig } from "../config.js";
import { resolveAssistant, isRejection } from "../routing/resolve-assistant.js";
import type { RouteResult } from "../routing/types.js";
import type { GatewayInboundEvent } from "../types.js";

/**
 * Slack `app_mention` event shape (subset relevant to normalization).
 */
export interface SlackAppMentionEvent {
  type: "app_mention";
  user: string;
  text: string;
  ts: string;
  channel: string;
  thread_ts?: string;
  client_msg_id?: string;
  event_ts?: string;
}

/**
 * Strip leading bot-mention tokens (`<@U...>`) from the message text.
 * Slack wraps mentions as `<@UXXXXXX>`, often at the start of an
 * app_mention event's text field. We remove all leading occurrences
 * so the assistant receives clean user content.
 */
export function stripBotMention(text: string): string {
  const stripped = text.replace(/^(<@[A-Z0-9]+>\s*)+/i, "").trim();
  return stripped || text.trim();
}

export type NormalizedSlackEvent = {
  event: GatewayInboundEvent;
  routing: RouteResult;
  /** Thread timestamp for reply threading. */
  threadTs: string;
  /** Slack channel ID. */
  channel: string;
};

/**
 * Normalize a Slack `app_mention` event into the gateway's
 * canonical inbound event shape, matching the pattern used by
 * the Telegram normalizer.
 *
 * Returns null if the event cannot be routed.
 */
export function normalizeSlackAppMention(
  event: SlackAppMentionEvent,
  eventId: string,
  config: GatewayConfig,
): NormalizedSlackEvent | null {
  const routing = resolveAssistant(config, event.channel, event.user);
  if (isRejection(routing)) {
    return null;
  }

  const content = stripBotMention(event.text);
  const externalMessageId = event.client_msg_id ?? event.ts ?? `${event.channel}:${event.ts}`;

  return {
    event: {
      version: "v1",
      sourceChannel: "slack",
      receivedAt: new Date().toISOString(),
      message: {
        content,
        conversationExternalId: event.channel,
        externalMessageId,
      },
      actor: {
        actorExternalId: event.user,
      },
      source: {
        updateId: eventId,
      },
      raw: event as unknown as Record<string, unknown>,
    },
    routing,
    threadTs: event.thread_ts ?? event.ts,
    channel: event.channel,
  };
}
