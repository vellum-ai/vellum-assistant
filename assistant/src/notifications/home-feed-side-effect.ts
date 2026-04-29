/**
 * Home-feed side effect for the notification pipeline.
 *
 * Writes a `FeedItem` into the home activity feed when a notification
 * signal originates from a non-interactive (background or scheduled)
 * conversation, or carries the `isAsyncBackground` attention hint.
 *
 * Producer flows like the scheduler, watchers, and background activity
 * jobs already emit through `emitNotificationSignal()` — this helper
 * mirrors the high-signal subset of that traffic into the home feed so
 * the macOS Home page surfaces them alongside other activity.
 */
import {
  type FeedItem,
  feedItemSchema,
  type FeedItemUrgency,
} from "../home/feed-types.js";
import { appendFeedItem } from "../home/feed-writer.js";
import { getConversation } from "../memory/conversation-crud.js";
import { isBackgroundConversationType } from "../memory/conversation-types.js";
import { getLogger } from "../util/logger.js";
import type { NotificationSignal } from "./signal.js";
import type {
  NotificationDecision,
  NotificationDeliveryResult,
} from "./types.js";

const log = getLogger("home-feed-side-effect");

const FEED_ITEM_URGENCIES: ReadonlySet<string> = new Set<FeedItemUrgency>([
  "low",
  "medium",
  "high",
  "critical",
]);

/**
 * Append a `FeedItem` for the given notification signal when the
 * filter criteria pass.
 *
 * Returns the persisted `FeedItem`, or `null` if the signal does not
 * qualify for home-feed mirroring (non-background origin AND no
 * `isAsyncBackground` hint) or if schema validation fails.
 */
export async function writeHomeFeedItemForSignal(
  signal: NotificationSignal,
  decision: NotificationDecision,
  deliveryResults: NotificationDeliveryResult[],
): Promise<FeedItem | null> {
  if (!shouldMirrorToHomeFeed(signal)) return null;

  const renderedCopy = decision.renderedCopy.vellum;
  const payloadTitle = readPayloadString(signal.contextPayload, "title");
  const payloadBody = readPayloadString(signal.contextPayload, "body");

  const conversationId = deliveryResults.find(
    (r) => r.channel === "vellum",
  )?.conversationId;
  const urgency = FEED_ITEM_URGENCIES.has(signal.attentionHints.urgency)
    ? (signal.attentionHints.urgency as FeedItemUrgency)
    : undefined;
  const now = new Date().toISOString();

  const item: FeedItem = {
    id: `notif:${signal.signalId}`,
    type: "action",
    source: "assistant",
    author: "assistant",
    priority: 50,
    title: renderedCopy?.title ?? payloadTitle ?? signal.sourceEventName,
    summary: renderedCopy?.body ?? payloadBody ?? signal.sourceEventName,
    timestamp: now,
    createdAt: now,
    status: "new",
    ...(urgency ? { urgency } : {}),
    ...(conversationId ? { conversationId } : {}),
  };

  try {
    feedItemSchema.parse(item);
  } catch (err) {
    log.warn(
      { err, signalId: signal.signalId },
      "FeedItem failed schema validation; skipping home-feed write",
    );
    return null;
  }

  await appendFeedItem(item);
  return item;
}

/**
 * `sourceContextId` is best-effort — it may not be a conversation id
 * (e.g. scheduler job id, watcher event id), so a lookup failure
 * falls through to "not a background conversation" rather than throwing.
 */
function shouldMirrorToHomeFeed(signal: NotificationSignal): boolean {
  if (signal.attentionHints.isAsyncBackground) return true;
  if (!signal.sourceContextId) return false;
  try {
    const row = getConversation(signal.sourceContextId);
    return isBackgroundConversationType(row?.conversationType);
  } catch {
    return false;
  }
}

function readPayloadString(payload: unknown, key: string): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}
