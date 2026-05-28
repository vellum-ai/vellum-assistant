/**
 * Edit an already-sent notification.
 *
 * Patches the home-feed entry the user actually sees, then attempts a
 * best-effort update of any per-channel deliveries that support
 * in-place edits (Slack via chat.update today). Feed-only fields
 * (`urgency`, `status`) skip the channel hop — channel messages don't
 * carry that metadata, only body/title.
 */

import {
  type FeedItem,
  type FeedItemStatus,
  type FeedItemUrgency,
} from "../home/feed-types.js";
import { patchFeedItemContent } from "../home/feed-writer.js";
import { getLogger } from "../util/logger.js";
import { findLatestDecisionByEventId } from "./decisions-store.js";
import {
  findDeliveriesByDecisionId,
  type NotificationDeliveryRow,
  updateDeliveryRenderedCopy,
} from "./deliveries-store.js";
import { getBroadcaster } from "./emit-signal.js";
import type { NotificationChannel } from "./types.js";

const log = getLogger("edit-notification");

/** Prefix used by `home-feed-side-effect` when minting feed item ids. */
export const FEED_ITEM_ID_PREFIX = "notif:";

export interface EditNotificationParams {
  /** Feed item id (`notif:<uuid>`) or bare signal uuid. */
  id: string;
  title?: string;
  body?: string;
  urgency?: FeedItemUrgency;
  status?: FeedItemStatus;
}

export type ChannelEditOutcome =
  | "updated"
  | "unsupported"
  | "skipped"
  | "failed";

export interface ChannelEditResult {
  channel: NotificationChannel;
  deliveryId: string;
  outcome: ChannelEditOutcome;
  /** Reason for skip/failure when `outcome` is not `"updated"`. */
  reason?: string;
}

export interface EditNotificationResult {
  feedItem: FeedItem;
  channels: ChannelEditResult[];
}

/**
 * Normalize a user-supplied id into the canonical feed-item form
 * (`notif:<uuid>`). Accepts either the full prefixed id or a bare uuid.
 */
export function normalizeFeedItemId(id: string): string {
  const trimmed = id.trim();
  if (trimmed.startsWith(FEED_ITEM_ID_PREFIX)) return trimmed;
  return `${FEED_ITEM_ID_PREFIX}${trimmed}`;
}

/** Strip the `notif:` prefix to recover the original signal/event id. */
export function feedItemIdToSignalId(feedItemId: string): string {
  return feedItemId.startsWith(FEED_ITEM_ID_PREFIX)
    ? feedItemId.slice(FEED_ITEM_ID_PREFIX.length)
    : feedItemId;
}

/**
 * Apply an edit to a previously-sent notification.
 *
 * Returns the updated feed item plus per-channel update outcomes.
 * Resolves to `null` when the feed item id isn't on disk so callers
 * can surface a clear "not found" to the user.
 */
export async function editNotification(
  params: EditNotificationParams,
): Promise<EditNotificationResult | null> {
  const feedItemId = normalizeFeedItemId(params.id);

  const feedItem = await patchFeedItemContent(feedItemId, {
    title: params.title,
    summary: params.body,
    urgency: params.urgency,
    status: params.status,
  });
  if (!feedItem) {
    log.warn({ feedItemId }, "Edit requested for unknown feed item");
    return null;
  }

  // Only edit channel messages when the user-visible text changed.
  // Urgency/status are feed-only — pushing a channel update for those
  // alone would re-deliver the same body and confuse the recipient.
  const shouldUpdateChannels =
    params.title !== undefined || params.body !== undefined;
  if (!shouldUpdateChannels) {
    return { feedItem, channels: [] };
  }

  const signalId = feedItemIdToSignalId(feedItemId);
  const decision = findLatestDecisionByEventId(signalId);
  if (!decision) {
    log.info(
      { feedItemId, signalId },
      "Feed item has no persisted decision — skipping channel updates",
    );
    return { feedItem, channels: [] };
  }

  const deliveries = findDeliveriesByDecisionId(decision.id);
  const channels = await updateChannelDeliveries(deliveries, {
    title: params.title,
    body: params.body,
  });

  return { feedItem, channels };
}

async function updateChannelDeliveries(
  deliveries: NotificationDeliveryRow[],
  patch: { title?: string; body?: string },
): Promise<ChannelEditResult[]> {
  const broadcaster = getBroadcaster();
  const results: ChannelEditResult[] = [];

  for (const delivery of deliveries) {
    const channel = delivery.channel as NotificationChannel;
    if (delivery.status !== "sent") {
      results.push({
        channel,
        deliveryId: delivery.id,
        outcome: "skipped",
        reason: `delivery status is ${delivery.status}`,
      });
      continue;
    }

    const adapter = broadcaster.getAdapter(channel);
    if (!adapter?.update) {
      results.push({
        channel,
        deliveryId: delivery.id,
        outcome: "unsupported",
        reason: `${channel} adapter does not support in-place edits`,
      });
      continue;
    }

    try {
      const result = await adapter.update(
        {
          deliveryId: delivery.id,
          destination: delivery.destination,
          messageId: delivery.messageId,
        },
        patch,
      );
      if (!result.success) {
        results.push({
          channel,
          deliveryId: delivery.id,
          outcome: "failed",
          reason: result.error ?? "unknown error",
        });
        continue;
      }
      updateDeliveryRenderedCopy(delivery.id, {
        renderedTitle: patch.title,
        renderedBody: patch.body,
      });
      results.push({
        channel,
        deliveryId: delivery.id,
        outcome: "updated",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        { err, channel, deliveryId: delivery.id },
        "Channel adapter update threw",
      );
      results.push({
        channel,
        deliveryId: delivery.id,
        outcome: "failed",
        reason: message,
      });
    }
  }

  return results;
}
