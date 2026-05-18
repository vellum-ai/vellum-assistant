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
  type FeedItemCategory,
  type FeedItemDetailPanelKind,
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

  const resolvedTitle =
    renderedCopy?.title?.trim() || payloadTitle?.trim() || "";
  const resolvedSummary =
    renderedCopy?.body?.trim() || payloadBody?.trim() || "";
  if (!resolvedTitle || !resolvedSummary) {
    log.warn(
      { signalId: signal.signalId, sourceEventName: signal.sourceEventName },
      "Home-feed write skipped: no real title or summary available (would have fallen back to event name)",
    );
    return null;
  }

  const conversationId = deliveryResults.find(
    (r) => r.channel === "vellum",
  )?.conversationId;
  const urgency = FEED_ITEM_URGENCIES.has(signal.attentionHints.urgency)
    ? (signal.attentionHints.urgency as FeedItemUrgency)
    : undefined;
  const now = new Date().toISOString();

  const category = deriveCategory(signal);
  const panelKind = deriveDetailPanelKind(signal);
  const metadata =
    signal.contextPayload &&
    typeof signal.contextPayload === "object" &&
    !Array.isArray(signal.contextPayload)
      ? (signal.contextPayload as Record<string, unknown>)
      : undefined;

  const item: FeedItem = {
    id: `notif:${signal.signalId}`,
    type: "notification",
    priority: 50,
    title: resolvedTitle,
    summary: resolvedSummary,
    timestamp: now,
    createdAt: now,
    status: "new",
    category,
    ...(urgency ? { urgency } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(panelKind ? { detailPanel: { kind: panelKind } } : {}),
    ...(metadata ? { metadata } : {}),
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

// ── Category & detail-panel derivation ────────────────────────────────

const EVENT_CATEGORY_MAP: Record<string, FeedItemCategory> = {
  "credential.health_alert": "security",
  "activity.failed": "background",
  "activity.complete": "background",
  "heartbeat.alert": "system",
  "watcher.notification": "system",
  "schedule.notify": "scheduling",
  "guardian.question": "security",
  "guardian.channel_activation": "security",
  "ingress.access_request": "security",
  "ingress.escalation": "security",
};

function deriveCategory(signal: NotificationSignal): FeedItemCategory {
  return EVENT_CATEGORY_MAP[signal.sourceEventName] ?? "system";
}

function deriveDetailPanelKind(
  signal: NotificationSignal,
): FeedItemDetailPanelKind | undefined {
  if (signal.sourceEventName === "credential.health_alert") {
    return "toolPermission";
  }

  if (signal.sourceEventName === "guardian.question") {
    const payload = signal.contextPayload;
    const kind =
      payload && typeof payload === "object" && "requestKind" in payload
        ? (payload as Record<string, unknown>).requestKind
        : undefined;
    if (kind === "tool_approval" || kind === "tool_grant_request") {
      return "permissionChat";
    }
  }

  return undefined;
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
