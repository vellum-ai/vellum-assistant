/**
 * Gateway-native guardian-request service (ATL-463).
 *
 * Thin lifecycle layer over the guardian-request store, serving the
 * `guardian_requests_*` IPC routes. Store-row ↔ wire-DTO mapping lives here:
 * the row type is the wire DTO minus `sourceType`, which the mapper computes
 * from `sourceChannel` (phone → voice, vellum → desktop, else channel).
 *
 * Create integrity: the store throws `GuardianRequestIntegrityError` (with a
 * machine-readable `code` the IPC error envelope mirrors into `errorCode`)
 * when a decisionable kind lacks `guardianPrincipalId`; the create IPC schema
 * enforces the same invariant at the boundary.
 *
 * `decideGuardianRequest` commits the pending→approved/denied status CAS and
 * the decision's ACL side effect (verified-channel activation, unverified
 * contact seed, channel block, or outbound-session mint) in ONE gateway
 * transaction: a crash or failed outcome write can never leave an approved
 * request without its ACL write — the outcome throw rolls the CAS back and
 * the request stays pending and retryable. Assistant info-mirrors run
 * post-commit, best-effort.
 */

import type {
  CreateGuardianRequestDeliveryIpcParams,
  CreateGuardianRequestIpcParams,
  CreateOutboundSessionIpcResponse,
  DecideGuardianRequestIpcParams,
  DecideGuardianRequestIpcResponse,
  ExpireInteractionBoundIpcResponse,
  GuardianRequestAclOutcome,
  GuardianRequestDeliveryWire,
  GuardianRequestPatch,
  GuardianRequestStatus,
  GuardianRequestWire,
  ListGuardianRequestsIpcParams,
  ListPendingGuardianRequestsByDestinationIpcParams,
  SweepExpiredGuardianRequestsIpcResponse,
  UpdateGuardianRequestDeliveryIpcParams,
} from "@vellumai/gateway-client";

import { getGatewayDb } from "../db/connection.js";
import { ContactStore } from "../db/contact-store.js";
import type { GuardianRequest } from "../db/guardian-request-store.js";
import {
  createDelivery,
  createGuardianRequest as storeCreateGuardianRequest,
  deriveSourceType,
  expireAllPendingInteractionBound,
  expireGuardianRequest as storeExpireGuardianRequest,
  getByPendingQuestionId,
  getGuardianRequest as storeGetGuardianRequest,
  getGuardianRequestByCode as storeGetGuardianRequestByCode,
  getPendingByCallSessionId,
  getPendingByDestinationMessage,
  isRequestInConversationScope,
  listDeliveries,
  listGuardianRequests as storeListGuardianRequests,
  listPendingByConversationScope,
  listPendingByDestinationChat,
  listPendingByDestinationConversation,
  resolveGuardianRequest,
  sweepExpiredGuardianRequests,
  updateDelivery,
  updateGuardianRequest as storeUpdateGuardianRequest,
} from "../db/guardian-request-store.js";
import { getLogger } from "../logger.js";
import {
  applyVerifiedChannelGatewayWrites,
  findContactChannelByAddress,
  mirrorVerifiedChannel,
} from "../verification/contact-helpers.js";
import { canonicalizeInboundIdentity } from "../verification/identity.js";
import { createOutboundSessionGuarded } from "../verification/session-service.js";

const log = getLogger("guardian-request-service");

// Stateless facade over the gateway DB (the connection resolves per call).
const contactStore = new ContactStore();

/** Map a store row onto the wire DTO by computing `sourceType`. */
export function toGuardianRequestWire(
  row: GuardianRequest,
): GuardianRequestWire {
  return { ...row, sourceType: deriveSourceType(row.sourceChannel) };
}

function toWireOrNull(row: GuardianRequest | null): GuardianRequestWire | null {
  return row ? toGuardianRequestWire(row) : null;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export function createGuardianRequest(
  params: CreateGuardianRequestIpcParams,
): GuardianRequestWire {
  return toGuardianRequestWire(storeCreateGuardianRequest(params));
}

export function getGuardianRequest(id: string): GuardianRequestWire | null {
  return toWireOrNull(storeGetGuardianRequest(id));
}

/** Pending requests only — resolved requests never match by code. */
export function getGuardianRequestByCode(
  code: string,
): GuardianRequestWire | null {
  return toWireOrNull(storeGetGuardianRequestByCode(code));
}

export function listGuardianRequests(
  filters: ListGuardianRequestsIpcParams,
): GuardianRequestWire[] {
  return storeListGuardianRequests(filters).map(toGuardianRequestWire);
}

export function updateGuardianRequest(
  id: string,
  patch: GuardianRequestPatch,
): void {
  storeUpdateGuardianRequest(id, patch);
}

/** CAS reopen (`fromStatus` → pending); a missed swap is a no-op. */
export function reopenGuardianRequest(
  id: string,
  fromStatus: GuardianRequestStatus,
): void {
  resolveGuardianRequest(id, fromStatus, { status: "pending" });
}

export function expireGuardianRequest(id: string): void {
  storeExpireGuardianRequest(id);
}

/**
 * Daemon-boot expiry: interaction-bound kinds unconditionally, persistent
 * kinds only past their `expiresAt`. Returns the expired-row count.
 */
export function expireInteractionBoundRequests(): ExpireInteractionBoundIpcResponse {
  return { expired: expireAllPendingInteractionBound() };
}

/**
 * Deadline sweep: CAS-expires past-`expiresAt` pending requests and returns
 * the expired rows for daemon-side card-withdrawal / notification fan-out.
 */
export function sweepExpiredRequests(
  now?: number,
): SweepExpiredGuardianRequestsIpcResponse {
  return {
    expired: sweepExpiredGuardianRequests(now).map(toGuardianRequestWire),
  };
}

// ---------------------------------------------------------------------------
// Deliveries
// ---------------------------------------------------------------------------

export function createGuardianRequestDelivery(
  params: CreateGuardianRequestDeliveryIpcParams,
): GuardianRequestDeliveryWire {
  return createDelivery(params);
}

export function updateGuardianRequestDelivery(
  id: string,
  patch: UpdateGuardianRequestDeliveryIpcParams["patch"],
): void {
  updateDelivery(id, patch);
}

export function listGuardianRequestDeliveries(
  requestId: string,
): GuardianRequestDeliveryWire[] {
  return listDeliveries(requestId);
}

// ---------------------------------------------------------------------------
// Destination + scope lookups
// ---------------------------------------------------------------------------

/** Reaction routing: the pending request delivered as a specific message. */
export function getPendingRequestByDestinationMessage(
  channel: string,
  chatId: string,
  messageId: string,
): GuardianRequestWire | null {
  return toWireOrNull(
    getPendingByDestinationMessage(channel, chatId, messageId),
  );
}

/**
 * Reply routing: pending requests delivered to a destination conversation
 * (optionally narrowed by channel) or to a channel + chat pair.
 */
export function listPendingRequestsByDestination(
  params: ListPendingGuardianRequestsByDestinationIpcParams,
): GuardianRequestWire[] {
  if (params.conversationId) {
    return listPendingByDestinationConversation(
      params.conversationId,
      params.channel,
    ).map(toGuardianRequestWire);
  }
  if (params.channel && params.chatId) {
    return listPendingByDestinationChat(params.channel, params.chatId).map(
      toGuardianRequestWire,
    );
  }
  throw new Error("conversationId or channel+chatId required");
}

export function listPendingRequestsByScope(
  conversationId: string,
  channel?: string,
): GuardianRequestWire[] {
  return listPendingByConversationScope(conversationId, channel).map(
    toGuardianRequestWire,
  );
}

export function isGuardianRequestInScope(
  requestId: string,
  conversationId: string,
  channel?: string,
): boolean {
  return isRequestInConversationScope(requestId, conversationId, channel);
}

export function getPendingRequestByCallSession(
  callSessionId: string,
): GuardianRequestWire | null {
  return toWireOrNull(getPendingByCallSessionId(callSessionId));
}

export function getRequestByPendingQuestion(
  pendingQuestionId: string,
): GuardianRequestWire | null {
  return toWireOrNull(getByPendingQuestionId(pendingQuestionId));
}

// ---------------------------------------------------------------------------
// Decide — status CAS + ACL outcome in one transaction
// ---------------------------------------------------------------------------

/**
 * Thrown when a decision's ACL outcome cannot be applied. Raised inside the
 * decide transaction, so the status CAS rolls back with it — the request
 * stays `pending` and the guardian can decide again. The IPC error envelope
 * mirrors `statusCode`/`code`.
 */
export class GuardianRequestOutcomeError extends Error {
  readonly statusCode = 409;
  readonly code = "acl_outcome_failed";

  constructor(message: string) {
    super(message);
    this.name = "GuardianRequestOutcomeError";
  }
}

/** Gateway writes applied for an ACL outcome inside the decide transaction. */
interface OutcomeGatewayWrites {
  mintedSession?: CreateOutboundSessionIpcResponse;
  /** Post-commit assistant info-mirror (best-effort; run by the caller). */
  postCommit?: () => Promise<void>;
}

type ActivateMemberOutcome = Extract<
  GuardianRequestAclOutcome,
  { type: "activate_member" }
>;

type ContactSeedOutcome = Pick<
  Extract<GuardianRequestAclOutcome, { type: "seed_unverified" }>,
  "sourceChannel" | "externalUserId" | "displayName"
>;

/**
 * Decide a pending guardian request: the pending→approved/denied CAS and the
 * optional ACL outcome commit in ONE gateway transaction (invariant 1 of the
 * gateway-native plan — the ATL-463 crash window between "row says approved"
 * and "ACL write landed" cannot exist). A CAS miss returns `status_conflict`
 * with zero side effects; a thrown outcome write rolls the CAS back, leaving
 * the request pending and retryable. Assistant info-mirrors run post-commit,
 * best-effort — a mirror failure never disturbs the committed decision.
 */
export async function decideGuardianRequest(
  params: DecideGuardianRequestIpcParams,
): Promise<DecideGuardianRequestIpcResponse> {
  const outcome = params.aclOutcome;

  // The assistant-mirror identity lookup is async IPC, so it runs before the
  // transaction (bun:sqlite transactions are synchronous). Best-effort: a
  // failed lookup degrades to gateway-only resolution by logical key.
  const existingMirrorChannel =
    outcome?.type === "activate_member"
      ? await lookupActivationMirrorChannel(outcome)
      : null;

  const txn = getGatewayDb().transaction(() => {
    const cas = resolveGuardianRequest(params.id, params.expectedStatus, {
      status: params.status,
      answerText: params.answerText,
      decidedByExternalUserId: params.decidedByExternalUserId,
      decidedByPrincipalId: params.decidedByPrincipalId,
    });
    if (!cas.applied) {
      return { applied: false as const };
    }

    const writes = outcome
      ? applyAclOutcomeGatewayWrites(outcome, existingMirrorChannel)
      : undefined;

    return {
      applied: true as const,
      request: cas.request,
      mintedSession: writes?.mintedSession,
      postCommit: writes?.postCommit,
    };
  });

  if (!txn.applied) {
    return { applied: false, reason: "status_conflict" };
  }

  if (txn.postCommit) {
    try {
      await txn.postCommit();
    } catch (err) {
      log.warn(
        { err, requestId: params.id },
        "Guardian-request decide: post-commit assistant mirror failed (best-effort); the committed decision stands",
      );
    }
  }

  return {
    applied: true,
    request: toGuardianRequestWire(txn.request),
    ...(txn.mintedSession ? { mintedSession: txn.mintedSession } : {}),
  };
}

/**
 * Pre-transaction identity read for the activation outcome: the existing
 * assistant-mirror channel (id + parent contact) for the (type, address) key,
 * or null when absent/unreachable — the gateway pre-check owns the ACL
 * decision either way.
 */
async function lookupActivationMirrorChannel(
  outcome: ActivateMemberOutcome,
): Promise<{ channelId: string; contactId: string } | null> {
  const identity = outcome.externalUserId ?? outcome.externalChatId;
  if (!identity) {
    return null;
  }
  const address =
    canonicalizeInboundIdentity(outcome.sourceChannel, identity) ?? identity;
  try {
    const channel = await findContactChannelByAddress(
      outcome.sourceChannel,
      address,
    );
    return channel
      ? { channelId: channel.channelId, contactId: channel.contactId }
      : null;
  } catch (err) {
    log.warn(
      { err, sourceChannel: outcome.sourceChannel },
      "Assistant mirror lookup failed; resolving activation gateway-only",
    );
    return null;
  }
}

/**
 * Apply the outcome's gateway writes synchronously (inside the decide
 * transaction). Throws {@link GuardianRequestOutcomeError} — or a typed
 * store error like the guardian-downgrade guard — when the outcome cannot
 * land, rolling back the decision CAS.
 */
function applyAclOutcomeGatewayWrites(
  outcome: GuardianRequestAclOutcome,
  existingMirrorChannel: { channelId: string; contactId: string } | null,
): OutcomeGatewayWrites {
  switch (outcome.type) {
    case "activate_member":
      return applyActivateMemberOutcome(outcome, existingMirrorChannel);
    case "seed_unverified":
      return applyContactSeedOutcome(outcome);
    case "block":
      return applyBlockOutcome(outcome);
    case "mint_outbound_session": {
      const { type: _type, ...mintParams } = outcome;
      const minted = createOutboundSessionGuarded(mintParams);
      if ("conflict" in minted) {
        throw new GuardianRequestOutcomeError(
          `outbound session mint conflicted: ${minted.reason}`,
        );
      }
      return { mintedSession: minted };
    }
  }
}

/**
 * Verified-channel activation (approve → trusted contact / voice caller).
 * Address and chat id backfill each other, `verifiedVia` defaults to
 * "invite", and revoked members may be reactivated; blocked actors are
 * refused by the gateway guard, and that refusal throws here, rolling back
 * the approval.
 */
function applyActivateMemberOutcome(
  outcome: ActivateMemberOutcome,
  existingMirrorChannel: { channelId: string; contactId: string } | null,
): OutcomeGatewayWrites {
  const address = outcome.externalUserId ?? outcome.externalChatId;
  const externalChatId = outcome.externalChatId ?? outcome.externalUserId;
  if (!address || !externalChatId) {
    throw new GuardianRequestOutcomeError(
      "activate_member outcome carries no channel identity (externalUserId or externalChatId required)",
    );
  }

  const result = applyVerifiedChannelGatewayWrites({
    sourceChannel: outcome.sourceChannel,
    externalUserId: address,
    externalChatId,
    displayName: outcome.displayName,
    username: outcome.username,
    verifiedVia: outcome.verifiedVia ?? "invite",
    contactId: outcome.contactId,
    allowRevokedReactivation: true,
    existingMirrorChannel,
  });
  if (!result.verified) {
    throw new GuardianRequestOutcomeError(
      "gateway refused the member activation (channel blocked)",
    );
  }

  return { postCommit: () => mirrorVerifiedChannel(result.mirror) };
}

/**
 * Unverified contact seed (deny → leave_unverified). A brand-new channel
 * lands at status `unverified`; an existing channel's status is preserved,
 * so a blocked/revoked/active row is never reactivated or downgraded.
 */
function applyContactSeedOutcome(
  outcome: ContactSeedOutcome,
): OutcomeGatewayWrites & { contactId: string; canonicalAddress: string } {
  const store = contactStore;
  const canonicalAddress =
    canonicalizeInboundIdentity(
      outcome.sourceChannel,
      outcome.externalUserId,
    ) ?? outcome.externalUserId.trim();

  const { contactId, mirrorParams } = store.upsertContactGatewayWrites({
    displayName: outcome.displayName,
    channels: [
      {
        type: outcome.sourceChannel,
        address: canonicalAddress,
        isPrimary: true,
      },
    ],
  });

  return {
    contactId,
    canonicalAddress,
    postCommit: () =>
      store.mirrorContactUpsertBestEffort(contactId, mirrorParams),
  };
}

/**
 * Channel block (deny → block): seed the contact/channel row, then mark it
 * revoked so future inbound from the sender resolves as `unknown`.
 * Idempotent: an already-revoked/blocked row is a no-op success; the
 * guardian-downgrade guard throws, rolling back the denial.
 */
function applyBlockOutcome(
  outcome: Extract<GuardianRequestAclOutcome, { type: "block" }>,
): OutcomeGatewayWrites {
  const seeded = applyContactSeedOutcome(outcome);

  const store = contactStore;
  const channel = store
    .getChannelsForContact(seeded.contactId)
    .find(
      (ch) =>
        ch.type === outcome.sourceChannel &&
        ch.address.toLowerCase() === seeded.canonicalAddress.toLowerCase(),
    );
  if (!channel) {
    throw new GuardianRequestOutcomeError(
      "block outcome produced no gateway channel row to revoke",
    );
  }

  const revoked = store.markChannelRevokedById(channel.id, outcome.reason);
  if (!revoked) {
    throw new GuardianRequestOutcomeError(
      "block outcome: gateway channel row missing at revoke",
    );
  }

  return { postCommit: seeded.postCommit };
}
