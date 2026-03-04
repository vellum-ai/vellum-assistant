/**
 * Presence-aware notification delivery queue for Slack.
 *
 * Before sending low-urgency notifications, checks the guardian's Slack
 * presence. If the guardian is `away`, the message is queued and
 * re-checked periodically (every 5 minutes). When the guardian comes
 * back online (`active`), all queued messages are delivered.
 *
 * High/medium urgency notifications bypass the queue entirely and are
 * delivered immediately regardless of presence.
 */

import * as slackClient from "../messaging/providers/slack/client.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("presence-queue");

const PRESENCE_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export interface QueuedMessage {
  token: string;
  userId: string;
  channel: string;
  text: string;
  threadTs?: string;
  queuedAt: number;
}

const messageQueue: QueuedMessage[] = [];
let presenceCheckTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Check the guardian's Slack presence status.
 * Returns `"active"` or `"away"`.
 */
export async function checkPresence(
  token: string,
  userId: string,
): Promise<"active" | "away"> {
  try {
    const result = await slackClient.getPresence(token, userId);
    return result.presence;
  } catch (err) {
    log.warn(
      { err, userId },
      "Failed to check Slack presence -- assuming active to avoid blocking delivery",
    );
    return "active";
  }
}

/** Enqueue a message for delivery when the guardian comes back online. */
export function enqueueMessage(message: QueuedMessage): void {
  messageQueue.push(message);
  log.info(
    {
      userId: message.userId,
      channel: message.channel,
      queueSize: messageQueue.length,
    },
    "Message queued for presence-aware delivery",
  );
  ensurePresenceCheckRunning();
}

/** Return a snapshot of the current queue (for observability). */
export function getQueuedMessages(): readonly QueuedMessage[] {
  return messageQueue;
}

/** Drain and return all queued messages for a specific user. */
function drainMessagesForUser(userId: string): QueuedMessage[] {
  const userMessages: QueuedMessage[] = [];
  for (let i = messageQueue.length - 1; i >= 0; i--) {
    if (messageQueue[i].userId === userId) {
      userMessages.unshift(messageQueue.splice(i, 1)[0]);
    }
  }
  return userMessages;
}

/** Deliver all queued messages for a user who has come online. */
async function deliverQueuedMessages(userId: string): Promise<void> {
  const messages = drainMessagesForUser(userId);
  if (messages.length === 0) return;

  log.info(
    { userId, count: messages.length },
    "Guardian is active -- delivering queued messages",
  );

  for (const msg of messages) {
    try {
      await slackClient.postMessage(
        msg.token,
        msg.channel,
        msg.text,
        msg.threadTs,
      );
      log.debug({ userId, channel: msg.channel }, "Queued message delivered");
    } catch (err) {
      log.error(
        { err, userId, channel: msg.channel },
        "Failed to deliver queued message",
      );
    }
  }
}

/** Periodic presence check: for each unique user in the queue, check presence and deliver if active. */
async function runPresenceCheck(): Promise<void> {
  if (messageQueue.length === 0) {
    stopPresenceCheck();
    return;
  }

  // Collect unique user+token pairs
  const userTokens = new Map<string, string>();
  for (const msg of messageQueue) {
    if (!userTokens.has(msg.userId)) {
      userTokens.set(msg.userId, msg.token);
    }
  }

  for (const [userId, token] of userTokens) {
    const presence = await checkPresence(token, userId);
    if (presence === "active") {
      await deliverQueuedMessages(userId);
    }
  }

  // Stop the timer if the queue is now empty
  if (messageQueue.length === 0) {
    stopPresenceCheck();
  }
}

function ensurePresenceCheckRunning(): void {
  if (presenceCheckTimer) return;
  presenceCheckTimer = setInterval(() => {
    runPresenceCheck().catch((err) => {
      log.error({ err }, "Presence check sweep failed");
    });
  }, PRESENCE_CHECK_INTERVAL_MS);

  // Don't keep the process alive just for presence checks
  if (typeof presenceCheckTimer === "object" && "unref" in presenceCheckTimer) {
    presenceCheckTimer.unref();
  }
}

function stopPresenceCheck(): void {
  if (presenceCheckTimer) {
    clearInterval(presenceCheckTimer);
    presenceCheckTimer = null;
  }
}

/** Shut down the presence check timer (for clean process exit). */
export function shutdownPresenceQueue(): void {
  stopPresenceCheck();
  // Don't clear the queue -- let it be drained on next startup or lost
  log.info(
    { remainingQueued: messageQueue.length },
    "Presence queue shut down",
  );
}
