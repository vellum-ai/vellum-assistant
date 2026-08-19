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
import { updateFeedItemConversationMessage } from "./home-feed-side-effect.js";
import { nonEmpty } from "./notification-utils.js";
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
  if (trimmed.startsWith(FEED_ITEM_ID_PREFIX)) {
    return trimmed;
  }
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

  // Titles are never cleared, so a blank one is dropped before it can
  // reach the feed patch or a channel update.
  const title = nonEmpty(params.title);

  const feedItem = await patchFeedItemContent(feedItemId, {
    title,
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
  const shouldUpdateChannels = title !== undefined || params.body !== undefined;
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
  }

  const deliveries = decision ? findDeliveriesByDecisionId(decision.id) : [];
  const { channels, rewrittenMessageIds } = await updateChannelDeliveries(
    deliveries,
    { title, body: params.body },
  );

  // The delivery walk covers a conversation row only while its delivery reads
  // sent, so the card carries the id of the row behind it and this closes
  // whatever the walk missed. Runs after it, and skips a row the walk just
  // rewrote, so the two never both write. Body edits only: a title-only patch
  // leaves the feed summary alone, and the row holds the body.
  if (params.body !== undefined) {
    updateFeedItemConversationMessage(
      feedItem,
      params.body,
      rewrittenMessageIds,
    );
  }

  return { feedItem, channels };
}

/**
 * Walk the recorded deliveries and let each channel adapter apply the patch.
 *
 * Alongside the per-channel outcomes this reports the message ids the
 * adapters rewrote, which is what tells the caller whether the row behind the
 * card still needs writing. Only body patches contribute: an adapter reports
 * its message id on a title-only patch too, without having touched the
 * conversation row.
 */
async function updateChannelDeliveries(
  deliveries: NotificationDeliveryRow[],
  patch: { title?: string; body?: string },
): Promise<{
  channels: ChannelEditResult[];
  rewrittenMessageIds: ReadonlySet<string>;
}> {
  const broadcaster = getBroadcaster();
  const results: ChannelEditResult[] = [];
  const rewrittenMessageIds = new Set<string>();

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
          conversationId: delivery.conversationId,
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
      if (patch.body !== undefined && result.messageId) {
        rewrittenMessageIds.add(result.messageId);
      }
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

  return { channels: results, rewrittenMessageIds };
}
