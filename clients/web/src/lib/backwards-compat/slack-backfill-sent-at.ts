/**
 * Backwards-compat gate: original send time on backfilled Slack history.
 *
 * Assistants from the pinned version on set `metadata.sentAt` when Slack
 * history backfill writes a row, so the wire `timestamp` already reports
 * when the message was sent. Older assistants send the import time, which
 * makes weeks-old history read as though it just arrived.
 *
 * When unsupported, the send time is recovered client-side from
 * `slackMessage.channelTs`. Rows imported before the assistant-side fix
 * lack `sentAt` on any version, so they keep reporting their import time
 * once the gate opens; correcting them would take a migration, and the
 * affected population does not warrant one.
 *
 * Conservative on an unknown version, which costs nothing here: on a
 * supported assistant the fallback derives the same instant the daemon
 * would have sent.
 */
import type { DisplayMessage } from "@/domains/chat/types/types";

import { useAssistantSupports } from "./utils";

export const MIN_VERSION = "0.11.5";

/** Gate for trusting the wire timestamp on backfilled Slack rows. */
export function useSupportsBackfilledSentAt(): boolean {
  return useAssistantSupports(MIN_VERSION);
}

/** Slack ts: `<unix-seconds>` with optional `.<microseconds>`. */
const SLACK_TS_PATTERN = /^\d+(?:\.\d+)?$/;

/**
 * Epoch ms a Slack message was sent, read from its origin `channelTs`.
 *
 * Reaction rows are excluded: their `channelTs` is the ts of the message
 * being reacted to, so the row's own timestamp is what dates the reaction.
 */
export function slackOriginTimestamp(
  message: DisplayMessage,
): number | undefined {
  const slack = message.slackMessage;
  if (!slack || slack.eventKind === "reaction") {
    return undefined;
  }
  // Full-string match: `parseFloat` alone accepts a numeric prefix, which
  // would turn a malformed ts into a fabricated origin time.
  if (!SLACK_TS_PATTERN.test(slack.channelTs)) {
    return undefined;
  }
  const ms = Number.parseFloat(slack.channelTs) * 1000;
  return Number.isFinite(ms) ? ms : undefined;
}
