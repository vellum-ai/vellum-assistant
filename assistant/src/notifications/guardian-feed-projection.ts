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

import {
  type FeedItem,
  type FeedItemGuardianIntent,
  type FeedItemGuardianRequest,
  isPendingGuardianFeedItem,
} from "../api/responses/home.js";
import {
  getGuardianRequest,
  type GuardianRequestStatus,
  type GuardianRequestWire,
  listGuardianRequests,
} from "../channels/gateway-guardian-requests.js";
import {
  appendFeedItem,
  patchFeedItemContent,
  readHomeFeed,
} from "../home/feed-writer.js";
import { getLogger } from "../util/logger.js";
import {
  buildToolApprovalSourceView,
  describeSlackChatLabel,
  type GuardianQuestionRequestKind,
  LenientToolApprovalPayloadSchema,
  resolveGuardianInstructionModeFromFields,
  resolveGuardianQuestionInstructionMode,
  type ToolApprovalSourceView,
} from "./guardian-question-mode.js";
import { readPayloadString } from "./notification-utils.js";

const log = getLogger("guardian-feed-projection");

/**
 * The signal events that carry a guardian request. `guardian.question`
 * covers tool approvals, tool grants, and questions; access requests
 * predate that registry and still ride their own event with an implied
 * `access_request` kind.
 */
export function isGuardianRequestSignalEvent(sourceEventName: string): boolean {
  return (
    sourceEventName === "guardian.question" ||
    sourceEventName === "ingress.access_request"
  );
}

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
 * Build the pending `guardianRequest` projection for a `guardian.question`
 * signal's feed item. Returns null when the payload does not carry the
 * request id the projection is keyed by.
 */
export function buildPendingGuardianProjection(
  contextPayload: unknown,
  fallbackKind?: GuardianQuestionRequestKind,
): FeedItemGuardianRequest | null {
  // Access-request payloads predate the kind registry and carry no
  // `requestKind`; the producer's event name supplies it instead.
  const normalizedPayload =
    contextPayload &&
    typeof contextPayload === "object" &&
    !Array.isArray(contextPayload) &&
    !("requestKind" in contextPayload) &&
    fallbackKind
      ? { ...contextPayload, requestKind: fallbackKind }
      : contextPayload;
  const parsed = LenientToolApprovalPayloadSchema.safeParse(normalizedPayload);
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
  // Access-request payloads name their requester differently.
  const requesterLabel =
    payload.requesterIdentifier?.trim() ||
    readPayloadString(contextPayload, "actorDisplayName")?.trim() ||
    readPayloadString(contextPayload, "senderIdentifier")?.trim();

  return {
    requestId,
    kind: payload.requestKind,
    intent,
    status: "pending",
    ...(requesterLabel ? { requesterLabel } : {}),
    ...(payload.toolName?.trim() ? { toolName: payload.toolName.trim() } : {}),
    ...(sourceView?.channel ? { sourceChannel: sourceView.channel } : {}),
    ...(sourceView
      ? { sourceContextLabel: describeApprovalSourceContext(sourceView) }
      : {}),
    ...(sourceView?.permalink ? { sourceUrl: sourceView.permalink } : {}),
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
 * Display label for the originating chat: the bare chat label from the
 * shared derivation (the bell's context line joins it with the tool, so
 * the channel word would be noise), or the channel id for channels the
 * view carries no chat facts for.
 */
function describeApprovalSourceContext(view: ToolApprovalSourceView): string {
  if (view.channel === "slack") {
    return describeSlackChatLabel(view) || view.channel;
  }
  return view.channel;
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
    // `patchFeedItemContent` resolves null both for a missing item and
    // for a failed file write, and only the second may gate a retry.
    // The pre-check splits them: an id present here that nulls below is
    // a lost write (or a concurrent removal, where a retry is harmless).
    if (!readHomeFeed().items.some((item) => item.id === itemId)) {
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
    const updated = await patchFeedItemContent(itemId, {
      urgency: "medium",
      guardianRequest: (existing) => ({
        ...existing,
        status: params.status,
        ...(params.decidedAction
          ? { decidedAction: params.decidedAction }
          : {}),
        decidedAt: new Date(params.decidedAtMs ?? Date.now()).toISOString(),
        ...(params.terminalReason
          ? { terminalReason: params.terminalReason }
          : {}),
      }),
    });
    if (!updated) {
      log.warn(
        { requestId: params.requestId, status: params.status },
        "Guardian feed receipt did not persist",
      );
      return false;
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

/**
 * Rewrite a request's feed item into its receipt when the canonical row
 * is already terminal. Converges the write-vs-resolve race from the
 * writer's side: a request decided while a pending item was being
 * written already ran its receipt fan-out against an item that did not
 * exist yet. Best-effort: a transport failure skips (never misreads a
 * hiccup as "request gone"), and the reconciliation sweep heals what
 * this misses.
 */
export async function receiptGuardianFeedItemIfRequestTerminal(
  requestId: string,
): Promise<void> {
  try {
    const request = await getGuardianRequest(requestId);
    if (!request || request.status === "pending") {
      return;
    }
    await writeGuardianFeedReceipt({
      requestId,
      status: request.status,
      decidedAtMs: request.updatedAt,
    });
  } catch (err) {
    log.warn(
      { err, requestId },
      "Failed to converge guardian feed item with terminal request",
    );
  }
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/**
 * Ceiling on backfills per reconciliation round, mirroring the expiry
 * sweep's batch bound: one round's IPC and file writes stay bounded
 * however large a backlog grows, and the remainder drains on later
 * rounds (the sweep runs every minute).
 */
const RECONCILE_BACKFILL_LIMIT = 50;

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

  const missing = pending.filter(
    (request) => !itemsByRequestId.has(request.id),
  );
  if (missing.length > RECONCILE_BACKFILL_LIMIT) {
    log.warn(
      { missing: missing.length, limit: RECONCILE_BACKFILL_LIMIT },
      "Guardian feed backfill backlog exceeds one round; remainder drains next round",
    );
  }
  for (const request of missing.slice(0, RECONCILE_BACKFILL_LIMIT)) {
    log.info(
      { requestId: request.id, kind: request.kind, surface: "home_feed" },
      "Backfilling feed projection for pending guardian request",
    );
    await appendFeedItem(buildBackfillGuardianFeedItem(request));
    // The request may have resolved between the pending listing and this
    // append; without the recheck the fresh item would restore live
    // actions for a terminal request until the next round.
    await receiptGuardianFeedItemIfRequestTerminal(request.id);
  }

  for (const [requestId, item] of itemsByRequestId) {
    if (!isPendingGuardianFeedItem(item) || pendingIds.has(requestId)) {
      continue;
    }
    // The item says pending but the canonical row does not: read the row
    // to learn its terminal status. Deliberately the throwing lookup: the
    // degrading variant returns null on a transport failure too, and a
    // hiccup must skip the row rather than receipt a live request as
    // cancelled. A row absent from the gateway reads as
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
