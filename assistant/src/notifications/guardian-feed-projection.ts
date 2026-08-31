/**
 * Canonical "Needs attention" projection of guardian requests onto the
 * home feed.
 *
 * One pending guardian request is exactly one feed item, keyed by
 * `guardianFeedItemId(requestId)` so the feed writer's replace-in-place
 * merge keeps it canonical: re-emits update the same row, and the
 * terminal-status fan-out rewrites it into a receipt instead of leaving
 * a stale actionable card. The item's `guardianRequest` field
 * (`FeedItemGuardianRequestSchema`) is a read projection of the
 * gateway-owned `guardian_requests` row, never an independent delivery
 * record: clients derive every affordance from its `status`, and the
 * daemon updates it wherever `withdrawGuardianRequestCards` settles the
 * other surfaces.
 */
import { z } from "zod";

import {
  type FeedItem,
  type FeedItemGuardianIntent,
  type FeedItemGuardianRequest,
  FeedItemGuardianStatusSchema,
  isPendingGuardianFeedItem,
} from "../api/responses/home.js";
import {
  getGuardianRequest,
  type GuardianRequestStatus,
  type GuardianRequestWire,
  listGuardianRequests,
} from "../channels/gateway-guardian-requests.js";
import { getConfig } from "../config/loader.js";
import {
  appendFeedItem,
  patchFeedItemContent,
  readHomeFeed,
} from "../home/feed-writer.js";
import { buildSlackMessageDeepLinks } from "../messaging/providers/slack/deep-link.js";
import {
  DEFAULT_USER_REFERENCE,
  resolveGuardianName,
} from "../prompts/user-reference.js";
import { getLogger } from "../util/logger.js";
import {
  buildToolApprovalSourceView,
  LenientToolApprovalPayloadSchema,
  resolveGuardianInstructionModeFromFields,
  resolveGuardianQuestionInstructionMode,
} from "./guardian-question-mode.js";
import type { NotificationDeliveryResult } from "./types.js";

const log = getLogger("guardian-feed-projection");

// The wire enum in `api/responses/home.ts` cannot import the gateway
// contract (the api directory is copied verbatim into client packages),
// so it mirrors `GuardianRequestStatusSchema` by value. This assignment
// fails to compile if the enums ever diverge in either direction.
type FeedStatus = z.infer<typeof FeedItemGuardianStatusSchema>;
type StatusEnumsAligned = [GuardianRequestStatus] extends [FeedStatus]
  ? [FeedStatus] extends [GuardianRequestStatus]
    ? true
    : never
  : never;
const _statusEnumsAligned: StatusEnumsAligned = true;
void _statusEnumsAligned;

/** Feed-item id of the canonical projection for a guardian request. */
export function guardianFeedItemId(requestId: string): string {
  return `guardian:${requestId}`;
}

/** The `requestId` a guardian feed-item id was built from, or null. */
export function requestIdFromGuardianFeedItemId(itemId: string): string | null {
  return itemId.startsWith("guardian:")
    ? itemId.slice("guardian:".length)
    : null;
}

/**
 * Guardian display name for receipt copy, or undefined when only the
 * prompt-voice fallback ("my human") is available. A receipt with no
 * decider label renders as the bare status word.
 */
function guardianReceiptName(): string | undefined {
  const name = resolveGuardianName();
  return name === DEFAULT_USER_REFERENCE ? undefined : name;
}

/**
 * Build the pending `guardianRequest` projection for a `guardian.question`
 * signal's feed item. Returns null when the payload does not carry the
 * request id the projection is keyed by.
 *
 * `slackDelivery` is the signal's Slack delivery outcome, when one
 * shipped: its destination chat + message ts locate the guardian-DM
 * approval card, and the derived deep links are what the client's
 * "Open in Slack" affordance opens.
 */
export function buildPendingGuardianProjection(
  contextPayload: unknown,
  slackDelivery?: NotificationDeliveryResult,
): FeedItemGuardianRequest | null {
  const parsed = LenientToolApprovalPayloadSchema.safeParse(contextPayload);
  if (!parsed.success) {
    return null;
  }
  const payload = parsed.data;
  const requestId = payload.requestId?.trim();
  if (!requestId) {
    return null;
  }

  const intent = intentFromInstructionMode(
    resolveGuardianQuestionInstructionMode(payload).mode,
  );

  const sourceView = buildToolApprovalSourceView(payload);
  const slackLinks = buildSlackCardLinks(slackDelivery);

  return {
    requestId,
    kind: payload.requestKind,
    intent,
    status: "pending",
    ...(payload.requesterIdentifier?.trim()
      ? { requesterLabel: payload.requesterIdentifier.trim() }
      : {}),
    ...(payload.toolName?.trim() ? { toolName: payload.toolName.trim() } : {}),
    ...(sourceView?.channel ? { sourceChannel: sourceView.channel } : {}),
    ...(sourceView
      ? { sourceContextLabel: describeApprovalSourceContext(sourceView) }
      : {}),
    ...(sourceView?.permalink ? { sourceUrl: sourceView.permalink } : {}),
    ...(slackLinks?.webUrl ? { slackCardUrl: slackLinks.webUrl } : {}),
    ...(slackLinks?.appUrl ? { slackCardAppUrl: slackLinks.appUrl } : {}),
  };
}

/**
 * A request in answer mode asks the guardian a question; every other
 * mode asks for an approval. The instruction mode already encodes this
 * (it decides whether cards render answer options or approve/reject),
 * so the projection's `intent` is a straight reading of it.
 */
function intentFromInstructionMode(
  mode: "approval" | "answer" | undefined,
): FeedItemGuardianIntent {
  return mode === "answer" ? "question" : "approval";
}

/**
 * Display label for the originating chat, mirroring the wording the
 * in-app approval card's source row uses (`sourceMetadataRow` in
 * `approval-card-data.ts`): Slack chats are named, other channels fall
 * back to the channel id.
 */
function describeApprovalSourceContext(view: {
  channel: string;
  chatId?: string | null;
  isSlackDm: boolean;
}): string {
  if (view.channel === "slack" && view.chatId) {
    return view.isSlackDm ? "Slack direct message" : `Slack #${view.chatId}`;
  }
  return view.channel;
}

/** Deep links to the Slack guardian-DM approval card, when one shipped. */
function buildSlackCardLinks(
  slackDelivery?: NotificationDeliveryResult,
): { appUrl?: string; webUrl?: string } | undefined {
  if (
    !slackDelivery ||
    slackDelivery.status !== "sent" ||
    !slackDelivery.destination ||
    !slackDelivery.messageId
  ) {
    return undefined;
  }
  const slackConfig = getConfig().slack;
  return buildSlackMessageDeepLinks({
    teamId: slackConfig?.teamId,
    teamUrl: slackConfig?.teamUrl,
    channelId: slackDelivery.destination,
    messageTs: slackDelivery.messageId,
  });
}

export interface GuardianFeedReceiptParams {
  requestId: string;
  status: GuardianRequestStatus;
  /** Action that produced the terminal status, when it was a decision. */
  decidedAction?: string;
  /** Epoch ms the request reached its terminal status. */
  decidedAtMs?: number;
  /** Non-decision cause of the terminal status (e.g. "superseded"). */
  terminalReason?: string;
}

/**
 * Rewrite a request's canonical feed item into its terminal receipt.
 *
 * The item keeps its title and summary; `guardianRequest` flips to the
 * terminal status (which is what removes the client's action buttons),
 * and urgency drops to `medium` so the item leaves the protected
 * "Needs attention" treatment and becomes an ordinary clearable
 * notification. Returns false only when the write itself failed, so the
 * withdrawal fan-out can hold its per-request receipt back and retry
 * (same contract as the other surfaces it settles). A request with no
 * projection item resolves true: the pending writer converges the
 * write-vs-resolve race by re-checking canonical status after its
 * append, so there is nothing here for a retry to fix.
 */
export async function writeGuardianFeedReceipt(
  params: GuardianFeedReceiptParams,
): Promise<boolean> {
  const itemId = guardianFeedItemId(params.requestId);
  try {
    const updated = await patchFeedItemContent(itemId, {
      urgency: "medium",
      guardianRequest: (existing) => ({
        ...existing,
        status: params.status,
        ...(params.decidedAction
          ? { decidedAction: params.decidedAction }
          : {}),
        // A decider label only when a person decided: a non-decision
        // terminal (superseded, expired) must not read as the guardian's
        // own rejection.
        ...((params.status === "approved" || params.status === "denied") &&
        !params.terminalReason
          ? decidedByLabelPatch()
          : {}),
        decidedAt: new Date(params.decidedAtMs ?? Date.now()).toISOString(),
        ...(params.terminalReason
          ? { terminalReason: params.terminalReason }
          : {}),
      }),
    });
    if (!updated) {
      // No projection item: either the request predates the projection
      // or the pending write raced the resolution and has not landed
      // yet. The pending writer converges the race by re-checking
      // canonical status after its append.
      log.debug(
        { requestId: params.requestId, status: params.status },
        "No guardian feed item to receipt",
      );
      return true;
    }
    return true;
  } catch (err) {
    log.warn(
      { err, requestId: params.requestId, status: params.status },
      "Failed to write guardian feed receipt",
    );
    return false;
  }
}

/** `{ decidedByLabel }` when a real display name exists, `{}` otherwise. */
function decidedByLabelPatch(): Pick<
  Partial<FeedItemGuardianRequest>,
  "decidedByLabel"
> {
  const name = guardianReceiptName();
  return name === undefined ? {} : { decidedByLabel: name };
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/**
 * Converge the feed against canonical guardian state. Run from the
 * guardian expiry sweep, so drift heals on the same cadence expiry does:
 *
 *   1. A pending request with no feed item (it predates the projection,
 *      or its write was lost) gets one backfilled from the request row.
 *      No conversation is generated: the item links to the request's
 *      source conversation when it names one, and nothing else.
 *   2. A feed item still offering actions for a request that is
 *      terminal (or gone) is rewritten into its receipt, and the drift
 *      is logged loudly: a terminal request with an actionable
 *      projection is the invariant this system exists to prevent.
 *
 * Skips the round when the gateway is unreachable; an empty list must
 * not be mistaken for "everything resolved".
 */
export async function reconcileGuardianFeedProjections(): Promise<void> {
  let pending: GuardianRequestWire[];
  try {
    pending = await listGuardianRequests({ status: "pending" });
  } catch (err) {
    log.debug(
      { err },
      "Guardian feed reconciliation skipped: gateway unreachable",
    );
    return;
  }

  const items = readHomeFeed().items;
  const itemsByRequestId = new Map<string, FeedItem>();
  for (const item of items) {
    const requestId = requestIdFromGuardianFeedItemId(item.id);
    if (requestId) {
      itemsByRequestId.set(requestId, item);
    }
  }

  const pendingIds = new Set(pending.map((request) => request.id));

  for (const request of pending) {
    if (itemsByRequestId.has(request.id)) {
      continue;
    }
    log.info(
      { requestId: request.id, kind: request.kind, surface: "home_feed" },
      "Backfilling feed projection for pending guardian request",
    );
    await appendFeedItem(buildBackfillGuardianFeedItem(request));
  }

  for (const [requestId, item] of itemsByRequestId) {
    if (!isPendingGuardianFeedItem(item) || pendingIds.has(requestId)) {
      continue;
    }
    // The item says pending but the canonical row does not: read the row
    // to learn its terminal status. Deliberately the throwing lookup: the
    // degrading variant returns null on a transport failure too, and a
    // hiccup must skip the row rather than receipt a live request as
    // cancelled. A row the gateway genuinely no longer has reads as
    // cancelled.
    let request: GuardianRequestWire | null;
    try {
      request = await getGuardianRequest(requestId);
    } catch {
      continue;
    }
    if (request?.status === "pending") {
      // Raced a fresh listing; the request really is pending.
      continue;
    }
    log.warn(
      {
        requestId,
        surface: "home_feed",
        canonicalStatus: request?.status ?? "missing",
      },
      "Terminal guardian request still had an actionable feed projection",
    );
    await writeGuardianFeedReceipt({
      requestId,
      status: request?.status ?? "cancelled",
      ...(request ? { decidedAtMs: request.updatedAt } : {}),
    });
  }
}

/**
 * Minimal feed item for a pending request discovered without one,
 * assembled from the canonical row alone (reconciliation has no
 * notification copy to draw on). `questionText` is the human-readable
 * ask every producer writes; `activityText` names the action in plain
 * language when the producer recorded one.
 */
function buildBackfillGuardianFeedItem(request: GuardianRequestWire): FeedItem {
  const summary =
    request.questionText?.trim() ||
    request.activityText?.trim() ||
    `Guardian request ${request.requestCode ?? request.id}`;
  const intent = intentFromInstructionMode(
    resolveGuardianInstructionModeFromFields(
      request.kind,
      request.toolName ?? undefined,
    )?.mode,
  );
  const now = new Date().toISOString();
  return {
    id: guardianFeedItemId(request.id),
    type: "notification",
    priority: 50,
    summary,
    timestamp: new Date(request.createdAt).toISOString(),
    createdAt: now,
    status: "new",
    category: "security",
    noteworthy: true,
    urgency: "high",
    detailPanel: { kind: "permissionChat" },
    ...(request.sourceConversationId
      ? { conversationId: request.sourceConversationId }
      : {}),
    guardianRequest: {
      requestId: request.id,
      kind: request.kind,
      intent,
      status: "pending",
      ...(request.toolName ? { toolName: request.toolName } : {}),
      ...(request.sourceChannel
        ? { sourceChannel: request.sourceChannel }
        : {}),
    },
  };
}
