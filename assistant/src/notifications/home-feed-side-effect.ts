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
import { isConversationSeedSane } from "./conversation-seed-composer.js";
import { readPayloadString } from "./notification-utils.js";
import type { NotificationSignal } from "./signal.js";
import type { NotificationDecision, RenderedChannelCopy } from "./types.js";

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
 * `fallbackConversationId` is used as the feed item's "Go to Convo"
 * navigation target when `signal.sourceContextId` doesn't resolve to a
 * real conversation row. The notification broadcaster pairs the vellum
 * delivery with a conversation (newly created or reused) before this
 * function runs, so callers can thread that paired id through here for
 * producers whose `sourceContextId` is a sentinel (heartbeat startup,
 * credential health, watcher emits, scheduler retries-exhausted) — the
 * feed item will then carry the paired delivery conversation and the
 * "Go to Convo" button can render.
 *
 * Returns the persisted `FeedItem`, or `null` if the signal does not
 * qualify for home-feed mirroring (non-background origin AND no
 * `isAsyncBackground` hint) or if schema validation fails.
 */
export async function writeHomeFeedItemForSignal(
  signal: NotificationSignal,
  decision: NotificationDecision,
  fallbackConversationId?: string,
): Promise<FeedItem | null> {
  const { mirror, sourceConversationId } = resolveHomeFeedMirror(
    signal,
    fallbackConversationId,
  );
  if (!mirror) return null;

  const renderedCopy =
    decision.renderedCopy.vellum ??
    firstSelectedRenderedCopy(decision.renderedCopy, decision.selectedChannels);
  const payloadTitle =
    readPayloadString(signal.contextPayload, "title") ??
    readPayloadString(signal.contextPayload, "requestedTitle");
  const payloadBody =
    readPayloadString(signal.contextPayload, "body") ??
    readPayloadString(signal.contextPayload, "requestedMessage");

  // Source the title from the payload only. The LLM's `renderedCopy.title`
  // often echoes the body when no explicit title was passed, which stutters
  // against `summary` in the row. Leave undefined when absent; renderers
  // fall back to `summary`.
  const resolvedTitle = payloadTitle?.trim() || undefined;
  // Prefer conversationSeedMessage over body for the home feed: the seed
  // message is richer and may contain structured markdown (lists, headers,
  // bold) that the detail panel renders. The popup-oriented `body` is
  // intentionally short (≤ 2 sentences) and loses formatting.
  const seedCandidate = renderedCopy?.conversationSeedMessage;
  const resolvedSummary =
    (isConversationSeedSane(seedCandidate)
      ? seedCandidate.trim()
      : undefined) ||
    renderedCopy?.body?.trim() ||
    payloadBody?.trim() ||
    "";
  if (!resolvedSummary) {
    log.warn(
      { signalId: signal.signalId, sourceEventName: signal.sourceEventName },
      "Home-feed write skipped: no summary available (would have fallen back to event name)",
    );
    return null;
  }

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
    ...(resolvedTitle ? { title: resolvedTitle } : {}),
    summary: resolvedSummary,
    timestamp: now,
    createdAt: now,
    status: "new",
    category,
    noteworthy: deriveNoteworthy(signal),
    fromAssistant: signal.sourceChannel === "assistant_tool",
    ...(urgency ? { urgency } : {}),
    ...(sourceConversationId ? { conversationId: sourceConversationId } : {}),
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
 * The lookup is best-effort and unified: a single `getConversation` call
 * both gates the "background conversation" mirror branch and populates
 * `sourceConversationId` for the "Go to Thread" navigation target. Misses
 * (scheduler job ids, watcher event ids, CLI tool-call ids) leave
 * `sourceConversationId` undefined so the client hides the affordance.
 *
 * `assistant_tool` mirrors unconditionally because the documented
 * `notifications send` skill (and background-job failure emits) deliberately
 * does not require a background-typed conversation or the
 * `isAsyncBackground` hint.
 */
function resolveHomeFeedMirror(
  signal: NotificationSignal,
  fallbackConversationId?: string,
): {
  mirror: boolean;
  sourceConversationId?: string;
} {
  let sourceRow: { conversationType?: string } | null = null;
  if (signal.sourceContextId) {
    try {
      sourceRow = getConversation(signal.sourceContextId) ?? null;
    } catch {
      sourceRow = null;
    }
  }
  // Prefer the producer's source context (e.g. the heartbeat / background
  // job conversation that emitted the signal) for the "Go to Convo" target,
  // since that's where the work actually happened. Fall back to the paired
  // delivery conversation only when the source context didn't resolve —
  // covers producers whose `sourceContextId` is a sentinel string.
  const sourceConversationId = sourceRow
    ? signal.sourceContextId
    : fallbackConversationId;

  if (signal.sourceChannel === "assistant_tool") {
    return { mirror: true, sourceConversationId };
  }
  if (signal.attentionHints.isAsyncBackground) {
    return { mirror: true, sourceConversationId };
  }
  if (isBackgroundConversationType(sourceRow?.conversationType)) {
    return { mirror: true, sourceConversationId };
  }
  return { mirror: false };
}

/**
 * Routing-intent enforcement can prune `selectedChannels` without also
 * pruning `renderedCopy`, so iterating `renderedCopy` directly risks
 * surfacing copy for a channel that was never delivered. Walk
 * `selectedChannels` in order instead so the channel that actually shipped
 * wins.
 */
function firstSelectedRenderedCopy(
  renderedCopy: NotificationDecision["renderedCopy"],
  selectedChannels: NotificationDecision["selectedChannels"],
): RenderedChannelCopy | undefined {
  for (const channel of selectedChannels) {
    const copy = renderedCopy[channel];
    if (copy && (copy.title?.trim() || copy.body?.trim())) return copy;
  }
  return undefined;
}

// ── Noteworthy derivation ─────────────────────────────────────────────
//
// Clients split the feed into inbox-style (noteworthy) and activity-style
// (routine) surfaces. Assistant-initiated shares and a small allow-list of
// high-importance system events land in the inbox; routine background
// signals stay in activity.

const NOTEWORTHY_EVENT_NAMES: ReadonlySet<string> = new Set([
  "guardian.question",
  "guardian.channel_activation",
  "ingress.access_request",
  "ingress.escalation",
  "credential.health_alert",
]);

function deriveNoteworthy(signal: NotificationSignal): boolean {
  // Background-job failures emit with `sourceChannel: "assistant_tool"`
  // (see `runtime/background-job-runner.ts`), so the activity.failed rule
  // must run BEFORE the assistant_tool short-circuit — otherwise every
  // routine watcher/heartbeat failure would land in the Inbox instead of
  // staying in the activity feed.
  if (signal.sourceEventName === "activity.failed") {
    return signal.attentionHints.urgency === "critical";
  }
  if (signal.sourceChannel === "assistant_tool") return true;
  if (NOTEWORTHY_EVENT_NAMES.has(signal.sourceEventName)) return true;
  return false;
}
