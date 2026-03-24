/**
 * Fetches Slack thread context (parent message + recent replies) for thread
 * replies so the assistant has context about what the user is referring to.
 *
 * Uses `conversations.replies` to retrieve the thread history and formats
 * it as a human-readable context string suitable for transport hints.
 */

import { fetchImpl } from "../fetch.js";
import { getLogger } from "../logger.js";
import { resolveSlackUser } from "./normalize.js";

const log = getLogger("slack-thread-context");

/** Maximum number of thread messages to include in context. */
const MAX_THREAD_MESSAGES = 15;

/** Timeout for the conversations.replies API call. */
const FETCH_TIMEOUT_MS = 5_000;

interface SlackReplyMessage {
  user?: string;
  text?: string;
  ts?: string;
  bot_id?: string;
  username?: string;
}

/**
 * Fetch thread context for a Slack thread reply.
 *
 * Returns a formatted string containing the parent message and recent thread
 * replies, or null if the fetch fails or the thread has no useful content.
 *
 * @param channel - Slack channel ID
 * @param threadTs - Thread timestamp (parent message ts)
 * @param currentMessageTs - The current message's ts (excluded from context)
 * @param botToken - Bot OAuth token for API calls
 * @param botUserId - Bot's own user ID (to label bot messages)
 */
export async function fetchThreadContext(
  channel: string,
  threadTs: string,
  currentMessageTs: string,
  botToken: string,
  botUserId?: string,
): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const params = new URLSearchParams({
      channel,
      ts: threadTs,
      limit: String(MAX_THREAD_MESSAGES),
      inclusive: "true",
    });

    const resp = await fetchImpl(
      `https://slack.com/api/conversations.replies?${params.toString()}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${botToken}` },
        signal: controller.signal,
      },
    );

    clearTimeout(timeout);

    if (!resp.ok) {
      log.warn(
        { status: resp.status, channel, threadTs },
        "conversations.replies HTTP error",
      );
      return null;
    }

    const data = (await resp.json()) as {
      ok?: boolean;
      messages?: SlackReplyMessage[];
      error?: string;
    };

    if (!data.ok || !data.messages?.length) {
      log.debug(
        { error: data.error, channel, threadTs },
        "conversations.replies returned no messages",
      );
      return null;
    }

    // Exclude the current message from context (it's the user's new message)
    const contextMessages = data.messages.filter(
      (msg) => msg.ts !== currentMessageTs,
    );

    if (contextMessages.length === 0) return null;

    // Resolve user display names (best-effort, uses cache)
    const formattedMessages = await Promise.all(
      contextMessages.map(async (msg) => {
        let authorLabel: string;
        if (msg.bot_id || (botUserId && msg.user === botUserId)) {
          authorLabel = "Assistant";
        } else if (msg.user) {
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

    const isParentOnly =
      contextMessages.length === 1 && contextMessages[0]!.ts === threadTs;
    const header = isParentOnly
      ? "This message is a reply to the following Slack message"
      : `This message is a reply in a Slack thread (${contextMessages.length} prior messages)`;

    return `${header}:\n\n${formattedMessages.join("\n\n")}`;
  } catch (err) {
    // AbortError from timeout or any other fetch failure — non-fatal
    log.debug(
      { err, channel, threadTs },
      "Failed to fetch thread context (non-fatal)",
    );
    return null;
  }
}
