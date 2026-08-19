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
} from "../home/feed-types.js";
import { appendFeedItem } from "../home/feed-writer.js";
import {
  addMessage,
  getConversation,
} from "../persistence/conversation-crud.js";
import { isBackgroundConversationType } from "../persistence/conversation-types.js";
import { getLogger } from "../util/logger.js";
import { normalizeTitle, stripMarkdown } from "../util/short-title.js";
import { isConversationSeedSane } from "./conversation-seed-composer.js";
import { deriveTitle } from "./copy-composer.js";
import { readPayloadString } from "./notification-utils.js";
import type { NotificationSignal } from "./signal.js";
import type { NotificationDecision, RenderedChannelCopy } from "./types.js";

const log = getLogger("home-feed-side-effect");

/**
 * Append a `FeedItem` for the given notification signal when the
 * filter criteria pass.
 *
 * `pairedVellumConversationId` is the conversation the broadcaster paired
 * with this signal's vellum delivery, and it carries two meanings here.
 *
 * As a navigation target it stands in for a `signal.sourceContextId` that
 * doesn't resolve to a real conversation row, so producers passing a
 * sentinel (heartbeat startup, credential health, watcher emits, scheduler
 * retries-exhausted) still render a "Go to Convo" button.
 *
 * Its absence also means no vellum delivery wrote the notification body into
 * a conversation, which is what the trailing append below acts on.
 *
 * Returns the persisted `FeedItem`, or `null` if the signal does not
 * qualify for home-feed mirroring (non-background origin AND no
 * `isAsyncBackground` hint) or if schema validation fails.
 */
export async function writeHomeFeedItemForSignal(
  signal: NotificationSignal,
  decision: NotificationDecision,
  pairedVellumConversationId?: string,
): Promise<FeedItem | null> {
  const { mirror, sourceConversationId, sourceScheduleJobId } =
    resolveHomeFeedMirror(signal, pairedVellumConversationId);
  if (!mirror) {
    return null;
  }

  const renderedCopy =
    decision.renderedCopy.vellum ??
    firstSelectedRenderedCopy(decision.renderedCopy, decision.selectedChannels);
  const payloadTitle =
    readPayloadString(signal.contextPayload, "title") ??
    readPayloadString(signal.contextPayload, "requestedTitle");
  const payloadBody =
    readPayloadString(signal.contextPayload, "body") ??
    readPayloadString(signal.contextPayload, "requestedMessage");

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

  // Title order: payload, then the rendered copy, then a headline derived
  // from the summary. `normalizeTitle` returns "" for empty, prose-shaped, and
  // meta-failure candidates; the derivation always yields something, so every
  // feed item lands with a title.
  const resolvedTitle =
    normalizeTitle(payloadTitle ?? "") ||
    normalizeTitle(renderedCopy?.title ?? "") ||
    deriveFallbackTitle(resolvedSummary);

  const urgency = signal.attentionHints.urgency;
  const now = new Date().toISOString();

  const category = deriveCategory(signal);
  const panelKind = deriveDetailPanelKind(signal);

  const baseMetadata =
    signal.contextPayload &&
    typeof signal.contextPayload === "object" &&
    !Array.isArray(signal.contextPayload)
      ? { ...signal.contextPayload }
      : undefined;

  // Link scheduled-run notifications back to their schedule. `notify`-mode
  // jobs put `scheduleId` directly in the context payload; `execute`-mode (and
  // other agent-backed) jobs only tag their conversation, so fall back to the
  // source conversation's `scheduleJobId`.
  const scheduleId =
    readPayloadString(signal.contextPayload, "scheduleId") ??
    sourceScheduleJobId ??
    undefined;

  const metadata =
    scheduleId !== undefined
      ? { ...(baseMetadata ?? {}), scheduleId }
      : baseMetadata;

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

  if (!pairedVellumConversationId && sourceConversationId) {
    await appendSummaryToFeedTarget(signal, sourceConversationId, item.summary);
  }

  return item;
}

/**
 * Write the card's own summary into the conversation its "Go to Convo"
 * button opens.
 *
 * That button targets the producing conversation whatever the routing, but
 * only the vellum delivery writes a notification body into a conversation
 * (`pairDeliveryWithConversation` appends there for passive signals). A
 * signal the decision engine routes to Slack or Telegram alone pairs no
 * vellum conversation, so without this the button opens a conversation that
 * never received what the card shows. A paired vellum id means that write
 * already happened, and this is skipped.
 *
 * The caller has already read `sourceConversationId` back from the store to
 * gate the mirror, so the row is known to exist and needs no second lookup:
 * with no paired id to fall back on, a resolved target can only be the
 * producing conversation itself.
 *
 * Indexing is skipped for parity with the other notification write paths:
 * notification copy is delivery audit, not conversational memory. Failures
 * are logged rather than thrown, so a message write cannot undo a card that
 * is already on disk.
 */
async function appendSummaryToFeedTarget(
  signal: NotificationSignal,
  conversationId: string,
  summary: string,
): Promise<void> {
  try {
    const message = await addMessage(conversationId, "assistant", summary, {
      skipIndexing: true,
    });
    log.info(
      {
        signalId: signal.signalId,
        conversationId,
        messageId: message.id,
      },
      "Appended notification body to the feed item's conversation",
    );
  } catch (err) {
    log.warn(
      { err, signalId: signal.signalId, conversationId },
      "Failed to append notification body to the feed item's conversation",
    );
  }
}

/**
 * Derive the terminal fallback headline from the summary.
 *
 * The summary is preferentially a conversation seed, which carries structured
 * markdown and hard line breaks, so flatten it to plain single-line text
 * before slicing a headline off the front. A non-empty summary always yields a
 * non-empty title.
 */
function deriveFallbackTitle(summary: string): string {
  // Block markers are line-anchored, so they have to go before the whitespace
  // collapse, and before `stripMarkdown` (whose inline-code rule would chew a
  // fence into a stray backtick). Ordered markers matter most: the seed prompt
  // asks the model for numbered lists, and a leading `1.` also reads as a
  // sentence terminator, which would truncate the title to the first digit.
  //
  // Deliberately regex-based, unlike the remark-backed
  // `stripMarkdownForPreview`. The leading-space allowance and rule set mirror
  // `flattenToPlainText` in workspace migration 138, which must stay
  // self-contained and so cannot share code with either: a backfilled title and
  // a freshly written one have to match, which a parser swap would break.
  const deblocked = summary
    .replace(/^\s{0,3}(?:```|~~~).*$/gm, "")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm, "");
  const plain = flattenWhitespace(stripMarkdown(deblocked));
  return deriveTitle(plain || flattenWhitespace(summary));
}

/** Collapse whitespace runs, including hard line breaks, into single spaces. */
function flattenWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
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
  "telegram.webhook_health_alert": "system",
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
        ? payload.requestKind
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
  sourceScheduleJobId?: string;
} {
  let sourceRow: {
    conversationType?: string;
    scheduleJobId?: string | null;
  } | null = null;
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
  const sourceScheduleJobId = sourceRow?.scheduleJobId ?? undefined;

  if (signal.sourceChannel === "assistant_tool") {
    return { mirror: true, sourceConversationId, sourceScheduleJobId };
  }
  if (signal.attentionHints.isAsyncBackground) {
    return { mirror: true, sourceConversationId, sourceScheduleJobId };
  }
  if (isBackgroundConversationType(sourceRow?.conversationType)) {
    return { mirror: true, sourceConversationId, sourceScheduleJobId };
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
    if (copy && (copy.title?.trim() || copy.body?.trim())) {
      return copy;
    }
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
  "credential.health_alert",
  // A dark messaging channel is inbox-worthy: the guardian may be waiting on
  // replies that are silently queueing at Telegram.
  "telegram.webhook_health_alert",
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
  if (signal.sourceChannel === "assistant_tool") {
    return true;
  }
  if (NOTEWORTHY_EVENT_NAMES.has(signal.sourceEventName)) {
    return true;
  }
  return false;
}
