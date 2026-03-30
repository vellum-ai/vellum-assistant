/**
 * Fetches recent DM history for inbound Slack direct messages so the
 * assistant has context about prior messages in the conversation.
 *
 * Uses `conversations.history` to retrieve recent messages and formats
 * them as a human-readable context string suitable for transport hints.
 */

import { fetchImpl } from "../fetch.js";
import { getLogger } from "../logger.js";
import { resolveSlackUser } from "./normalize.js";

const log = getLogger("slack-dm-context");

/** Maximum number of prior messages to include in context. */
const MAX_CONTEXT_MESSAGES = 10;

/** Timeout for the conversations.history API call. */
const FETCH_TIMEOUT_MS = 5_000;

interface SlackDmMessage {
  user?: string;
  text?: string;
  ts?: string;
  bot_id?: string;
  username?: string;
}

/**
 * Fetch recent DM history for a Slack direct-message channel.
 *
 * Returns a formatted string containing recent prior messages, or null
 * if the fetch fails or there are no prior messages.
 *
 * @param channel - Slack DM channel ID (starts with "D")
 * @param currentMessageTs - The current message's ts (excluded from context)
 * @param botToken - Bot OAuth token for API calls
 */
export async function fetchDmContext(
  channel: string,
  currentMessageTs: string,
  botToken: string,
): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const params = new URLSearchParams({
      channel,
      limit: "10",
    });

    const resp = await fetchImpl(
      `https://slack.com/api/conversations.history?${params.toString()}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${botToken}` },
        signal: controller.signal,
      },
    );

    clearTimeout(timeout);

    if (!resp.ok) {
      log.debug(
        { status: resp.status, channel },
        "conversations.history HTTP error",
      );
      return null;
    }

    const data = (await resp.json()) as {
      ok?: boolean;
      messages?: SlackDmMessage[];
      error?: string;
    };

    if (!data.ok || !data.messages?.length) {
      log.debug(
        { error: data.error, channel },
        "conversations.history returned no messages",
      );
      return null;
    }

    // Exclude the current message from context
    const priorMessages = data.messages.filter(
      (msg) => msg.ts !== currentMessageTs,
    );

    if (priorMessages.length === 0) return null;

    // Slack returns newest-first; reverse to chronological order
    priorMessages.reverse();

    // Cap at MAX_CONTEXT_MESSAGES (take the most recent N)
    const contextMessages =
      priorMessages.length <= MAX_CONTEXT_MESSAGES
        ? priorMessages
        : priorMessages.slice(-MAX_CONTEXT_MESSAGES);

    // Resolve user display names (best-effort, uses cache)
    const formattedMessages = await Promise.all(
      contextMessages.map(async (msg) => {
        let authorLabel: string;
        if (msg.user) {
          const userInfo = await resolveSlackUser(msg.user, botToken).catch(
            () => undefined,
          );
          authorLabel = userInfo?.displayName ?? msg.user;
        } else {
          authorLabel = msg.username ?? "Unknown";
        }

        const text = msg.text?.trim() || "(no text)";
        return `[${authorLabel}]: ${text}`;
      }),
    );

    return `Recent messages in this DM conversation (${contextMessages.length} prior messages):\n\n${formattedMessages.join("\n\n")}`;
  } catch (err) {
    // AbortError from timeout or any other fetch failure — non-fatal
    log.debug(
      { err, channel },
      "Failed to fetch DM context (non-fatal)",
    );
    return null;
  }
}
