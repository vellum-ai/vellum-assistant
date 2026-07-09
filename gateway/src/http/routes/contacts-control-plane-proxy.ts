/**
 * Gateway endpoints for ingress contacts/invites control-plane routes.
 *
 * These routes are registered as explicit gateway routes for dedicated
 * auth handling rather than falling through to the catch-all proxy.
 * Contact routes proxy to the assistant runtime; invite routes are
 * gateway-native against the gateway DB's ingress_invites table.
 */

import { randomUUID } from "node:crypto";

import { proxyForward } from "@vellumai/assistant-client";
import {
  generateInviteCode,
  generateInviteToken,
  hashInviteCode,
  hashInviteToken,
  isValidE164,
} from "@vellumai/gateway-client";
import { eq } from "drizzle-orm";

import { mintServiceToken } from "../../auth/token-exchange.js";
import type { GatewayConfig } from "../../config.js";
import { getGatewayDb } from "../../db/connection.js";
import {
  ContactStore,
  CannotRevokeBlockedError,
  MergeContactsError,
  NO_INVITE_CODE_HASH,
  type ChannelAcl,
  type ContactAcl,
  type ContactWithInfo,
  type IngressInviteRow,
} from "../../db/contact-store.js";
import { contacts } from "../../db/schema.js";
import { fetchImpl } from "../../fetch.js";
import {
  IpcHandlerError,
  ipcCallAssistant,
} from "../../ipc/assistant-client.js";
import { probeContactMirror } from "../../ipc/contacts-info-client.js";
import { getLogger } from "../../logger.js";
import { ensureInviteLive } from "../../verification/invite-liveness.js";
import {
  redeemInviteByToken,
  redeemVoiceInvite,
  resolveInviteeName,
} from "../../verification/invite-redemption.js";
import {
  parseCreateInviteBody,
  parseListInviteQuery,
  parseRedeemInviteBody,
  type CreateInviteInput,
  type ListInviteQuery,
  type RedeemInviteInput,
} from "./invite-validation.js";

const log = getLogger("contacts-control-plane-proxy");

// ---------------------------------------------------------------------------
// Transport-agnostic invite native errors
// ---------------------------------------------------------------------------

/**
 * Error thrown by the transport-agnostic invite native functions to signal a
 * client-facing failure with a stable code + status. The HTTP handlers map it
 * to `Response.json`; the gateway IPC routes let it propagate (the IPC server
 * stringifies thrown errors into the wire `error` field).
 */
export class InviteNativeError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(message: string, statusCode: number, code: string) {
    super(message);
    this.name = "InviteNativeError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

/**
 * Error thrown by the transport-agnostic contact-channel core to signal a
 * client-facing failure with a stable code + status. The HTTP handler maps it
 * to `Response.json`; the gateway IPC route lets it propagate (the IPC server
 * stringifies thrown errors and mirrors `statusCode`/`code` into the wire
 * envelope).
 */
export class ContactChannelNativeError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(message: string, statusCode: number, code: string) {
    super(message);
    this.name = "ContactChannelNativeError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

/** Map an InviteNativeError (or generic error) to the HTTP error Response. */
function inviteErrorResponse(err: unknown): Response {
  if (err instanceof InviteNativeError) {
    return Response.json(
      { error: { code: err.code, message: err.message } },
      { status: err.statusCode },
    );
  }
  if (err instanceof IpcHandlerError) {
    return Response.json(
      { error: { code: err.code, message: err.message } },
      { status: err.statusCode },
    );
  }
  return Response.json(
    { error: { code: "INTERNAL_ERROR", message: "Internal error" } },
    { status: 500 },
  );
}

// ---------------------------------------------------------------------------
// Validation constants (mirrored from assistant/src/runtime/routes/contact-routes.ts)
// ---------------------------------------------------------------------------

const VALID_CONTACT_TYPES = ["human", "assistant"] as const;

// ---------------------------------------------------------------------------
// Invite hashing + response sanitization
// ---------------------------------------------------------------------------

/**
 * Strip code/token hashes from a gateway invite row before returning it over
 * HTTP. `inviteCodeHash` and `voiceCodeHash` are unsalted SHA-256 of a
 * 6-digit code; returning either lets any list-capable caller brute-force the
 * ~10^6 keyspace offline and redeem an active invite. `tokenHash` is the
 * redemption secret for link invites. All invite responses MUST go through
 * this.
 */
function sanitizeInviteRow<
  T extends {
    inviteCodeHash?: unknown;
    tokenHash?: unknown;
    voiceCodeHash?: unknown;
  },
>(row: T): Omit<T, "inviteCodeHash" | "tokenHash" | "voiceCodeHash"> {
  const {
    inviteCodeHash: _code,
    tokenHash: _token,
    voiceCodeHash: _voice,
    ...rest
  } = row;
  return rest;
}

// ---------------------------------------------------------------------------
// Transport-agnostic invite native functions
//
// These hold the ONE implementation shared by the gateway HTTP invite handlers
// and the gateway IPC invite routes (gateway/src/ipc/invite-handlers.ts). They
// return plain data (never a `Response`) and signal failures by throwing
// InviteNativeError / IpcHandlerError so each transport can translate the
// error into its own envelope (HTTP status code vs IPC error string). Behavior
// here MUST stay identical to the prior inline HTTP handler bodies.
// ---------------------------------------------------------------------------

/**
 * List invites from the gateway DB (single source of truth for invite rows,
 * including the voice/display columns), sanitized (no inviteCodeHash /
 * tokenHash / voiceCodeHash). Throws InviteNativeError(500) when the gateway
 * read fails.
 */
export async function listInvitesNative(
  query: ListInviteQuery,
): Promise<{ invites: Array<Record<string, unknown>> }> {
  let rows;
  try {
    rows = new ContactStore().listInvites(query);
  } catch (err) {
    log.error({ err }, "list_invites: gateway-native read failed");
    throw new InviteNativeError(
      "Failed to list invites",
      500,
      "INTERNAL_ERROR",
    );
  }

  const invites: Array<Record<string, unknown>> = rows.map((r) =>
    sanitizeInviteRow(r),
  );

  log.info(
    { count: invites.length, ...query },
    "list_invites: handled natively",
  );
  return { invites };
}

/** Default invite lifetime when the caller supplies no `expiresInMs`. */
const DEFAULT_INVITE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Create an invite natively: verify the contact exists, mint the secrets via
 * the shared invite-contract helpers, and write the single canonical gateway
 * row. Voice invites (`sourceChannel === "phone"`) get an identity-bound
 * spoken code and NO link token; every other channel gets a link token plus a
 * 6-digit code for guardian-mediated redemption. Plaintext secrets
 * (`token` / `inviteCode` / `voiceCode`) are returned exactly once on the
 * invite payload and never persisted — only their hashes reach the row.
 * Presentation fields (share link, guardian instruction, channel handle) are
 * daemon-owned and layered on by each create transport exactly once: the
 * daemon's create relay composes in-process; the gateway HTTP handler
 * composes via the `invites_compose_presentation` daemon IPC.
 *
 * Throws InviteNativeError(404) when the contact is unknown, (400) on invalid
 * voice parameters, and (500) when the gateway write fails.
 */
export async function createInviteNative(
  input: CreateInviteInput,
): Promise<{ invite: Record<string, unknown>; rawToken?: string }> {
  const store = new ContactStore();

  // A2A invites live in the daemon's a2a_invites store, not in gateway
  // ingress_invites — a gateway row here would be unredeemable.
  if (input.sourceChannel === "a2a") {
    throw new InviteNativeError(
      'sourceChannel "a2a" is not a gateway invite channel (A2A invites are daemon-managed)',
      400,
      "BAD_REQUEST",
    );
  }

  const contact = store.getContact(input.contactId);
  if (!contact) {
    throw new InviteNativeError(
      `Contact "${input.contactId}" not found`,
      404,
      "NOT_FOUND",
    );
  }

  const isVoice = input.sourceChannel === "phone";

  let rawToken: string | undefined;
  let tokenHash: string | undefined;
  let inviteCode: string | undefined;
  let inviteCodeHash: string | undefined;
  let voiceCode: string | undefined;
  let voiceCodeHash: string | undefined;
  let friendName: string | undefined;

  if (isVoice) {
    if (!input.expectedExternalUserId) {
      throw new InviteNativeError(
        "expectedExternalUserId is required for voice invites",
        400,
        "BAD_REQUEST",
      );
    }
    if (!isValidE164(input.expectedExternalUserId)) {
      throw new InviteNativeError(
        "expectedExternalUserId must be in E.164 format (e.g., +15551234567)",
        400,
        "BAD_REQUEST",
      );
    }
    voiceCode = generateInviteCode(6);
    voiceCodeHash = hashInviteCode(voiceCode);
    // The invitee's canonical name is the bound contact's displayName —
    // mirrored onto the row so voice greeting/call reads need no extra lookup.
    friendName = contact.displayName?.trim() || undefined;
  } else {
    rawToken = generateInviteToken();
    tokenHash = hashInviteToken(rawToken);
    inviteCode = generateInviteCode(6);
    inviteCodeHash = hashInviteCode(inviteCode);
  }

  let row: IngressInviteRow;
  try {
    row = store.createInvite({
      id: randomUUID(),
      sourceChannel: input.sourceChannel,
      contactId: input.contactId,
      note: input.note ?? null,
      maxUses: input.maxUses,
      expiresAt: Date.now() + (input.expiresInMs ?? DEFAULT_INVITE_EXPIRY_MS),
      inviteCodeHash: inviteCodeHash ?? NO_INVITE_CODE_HASH,
      tokenHash: tokenHash ?? null,
      voiceCodeHash: voiceCodeHash ?? null,
      voiceCodeDigits: isVoice ? 6 : null,
      expectedExternalUserId: isVoice ? input.expectedExternalUserId : null,
      friendName: friendName ?? null,
      guardianName: input.guardianName ?? null,
      sourceConversationId: input.sourceConversationId ?? null,
    });
  } catch (err) {
    log.error(
      { err, contactId: input.contactId },
      "create_invite: gateway DB write failed",
    );
    throw new InviteNativeError(
      "Failed to record invite",
      500,
      "INTERNAL_ERROR",
    );
  }

  // Notify connected clients.
  void ipcCallAssistant("emit_event", {
    body: { kind: "contacts_changed" },
  } as unknown as Record<string, unknown>).catch(() => {});

  log.info(
    { inviteId: row.id, contactId: input.contactId },
    "create_invite: handled natively",
  );

  // One-time create payload: row fields plus the plaintext secrets. tokenHash
  // is included for response compatibility with the historical create shape;
  // the brute-forceable code hashes never leave the DB.
  const invite: Record<string, unknown> = {
    id: row.id,
    sourceChannel: row.sourceChannel,
    ...(rawToken ? { token: rawToken } : {}),
    ...(row.tokenHash ? { tokenHash: row.tokenHash } : {}),
    maxUses: row.maxUses,
    useCount: row.useCount,
    expiresAt: row.expiresAt,
    status: row.status,
    ...(row.note ? { note: row.note } : {}),
    ...(row.expectedExternalUserId
      ? { expectedExternalUserId: row.expectedExternalUserId }
      : {}),
    ...(voiceCode ? { voiceCode } : {}),
    ...(row.voiceCodeDigits != null
      ? { voiceCodeDigits: row.voiceCodeDigits }
      : {}),
    ...(row.friendName ? { friendName: row.friendName } : {}),
    ...(row.guardianName ? { guardianName: row.guardianName } : {}),
    ...(inviteCode ? { inviteCode } : {}),
    createdAt: row.createdAt,
  };
  return { invite, rawToken };
}

/**
 * Layer the daemon-owned presentation fields (share link, guardian
 * instruction, channel handle) onto a gateway-minted invite payload via the
 * `invites_compose_presentation` daemon IPC. Best-effort: presentation is
 * display-only UX, so a daemon failure logs and returns the raw minted
 * payload — invite creation never fails because composition failed.
 */
async function composePresentationBestEffort(params: {
  contactId?: string;
  invite: Record<string, unknown>;
  rawToken?: string;
}): Promise<Record<string, unknown>> {
  try {
    const result = (await ipcCallAssistant("invites_compose_presentation", {
      body: params,
    })) as { invite?: Record<string, unknown> } | null;
    if (result?.invite && typeof result.invite === "object") {
      return result.invite;
    }
    log.warn(
      { inviteId: params.invite.id },
      "create_invite: daemon presentation response missing invite (best-effort)",
    );
  } catch (err) {
    log.warn(
      { err, inviteId: params.invite.id },
      "create_invite: daemon presentation composition failed (best-effort)",
    );
  }
  return params.invite;
}

/**
 * Revoke an invite: a single gateway UPDATE (source of truth). Idempotent —
 * revoking an already-terminal (redeemed/revoked/expired) invite returns the
 * row's current state. Returns the sanitized invite. Throws
 * InviteNativeError(404) when the invite id is unknown, InviteNativeError(500)
 * on unexpected gateway error.
 */
export async function revokeInviteNative(
  inviteId: string,
): Promise<{ invite: Record<string, unknown> }> {
  let invite;
  try {
    invite = new ContactStore().revokeInvite(inviteId);
  } catch (err) {
    log.error({ err, inviteId }, "revoke_invite: gateway-native revoke failed");
    throw new InviteNativeError(
      "Failed to revoke invite",
      500,
      "INTERNAL_ERROR",
    );
  }

  if (!invite) {
    throw new InviteNativeError(
      `Invite "${inviteId}" not found`,
      404,
      "NOT_FOUND",
    );
  }

  void ipcCallAssistant("emit_event", {
    body: { kind: "contacts_changed" },
  } as unknown as Record<string, unknown>).catch(() => {});

  log.info({ inviteId }, "revoke_invite: handled natively");
  return { invite: sanitizeInviteRow(invite) };
}

/**
 * Redeem an invite natively through the gateway redemption engine
 * (verification/invite-redemption.ts): validation, membership gate, atomic
 * claim, the verified-channel ACL upsert, and the best-effort
 * `invite_redeemed` daemon info-mirror event all run inside the engine.
 *
 * Returns the transport-agnostic redeem payload:
 *   - voice: `{ ok, type, memberId, inviteId? }` (memberId = the invite's
 *     target contact id; inviteId only on a real redeem)
 *   - token: `{ ok, invite, type }` (the sanitized post-claim gateway row)
 *
 * Every engine failure throws InviteNativeError(400, BAD_REQUEST) whose
 * message is the engine reason — voice collapses to the single generic
 * `invalid_or_expired` so callers probing codes learn nothing.
 */
export async function redeemInviteNative(
  input: RedeemInviteInput,
): Promise<Record<string, unknown>> {
  const store = new ContactStore();

  if (input.kind === "voice") {
    const result = await redeemVoiceInvite({
      callerExternalUserId: input.callerExternalUserId,
      code: input.code,
      store,
    });
    if (result.status === "failed") {
      throw new InviteNativeError(result.reason, 400, "BAD_REQUEST");
    }
    log.info(
      { inviteId: result.outcome.inviteId, type: result.status },
      "redeem_invite(voice): handled natively",
    );
    return {
      ok: true,
      type: result.status,
      memberId: result.outcome.contactId,
      ...(result.status === "redeemed"
        ? { inviteId: result.outcome.inviteId }
        : {}),
    };
  }

  const result = await redeemInviteByToken({
    token: input.token,
    sourceChannel: input.sourceChannel,
    externalUserId: input.externalUserId,
    externalChatId: input.externalChatId,
    displayName: input.displayName,
    username: input.username,
    store,
  });
  if (result.status === "no_match" || result.status === "failed") {
    // Token hashes are globally unique so the engine never yields no_match
    // for a token; treat it as the same definitive invalid invite.
    const reason = result.status === "failed" ? result.reason : "invalid_token";
    throw new InviteNativeError(reason, 400, "BAD_REQUEST");
  }

  const row = store.getInviteById(result.outcome.inviteId);
  if (!row) {
    throw new InviteNativeError(
      "Invite not found after redemption",
      400,
      "BAD_REQUEST",
    );
  }
  log.info(
    { inviteId: row.id, type: result.status },
    "redeem_invite(token): handled natively",
  );
  return { ok: true, invite: sanitizeInviteRow(row), type: result.status };
}

/**
 * Trigger the provider-specific outbound call for an invite. The gateway row
 * is the lifecycle source of truth: the invite must exist, be `active`,
 * unexpired, and be a phone invite with a bound caller number. The resolved
 * call fields (number + display names) are relayed to the daemon, which only
 * places the provider call. Returns the provider call sid. Throws
 * InviteNativeError(404) when the invite id is unknown, InviteNativeError(400)
 * when the invite isn't callable, InviteNativeError(500) on relay failure, and
 * propagates an assistant IpcHandlerError unchanged.
 */
export async function triggerInviteCallNative(
  inviteId: string,
): Promise<{ callSid: string }> {
  const store = new ContactStore();
  const invite = store.getInviteById(inviteId);
  if (!invite) {
    throw new InviteNativeError(
      `Invite "${inviteId}" not found`,
      404,
      "NOT_FOUND",
    );
  }
  const liveness = ensureInviteLive(store, invite);
  if (!liveness.live) {
    throw new InviteNativeError(
      liveness.reason === "expired"
        ? `Invite "${inviteId}" has expired`
        : `Invite "${inviteId}" is not active`,
      400,
      "BAD_REQUEST",
    );
  }
  if (invite.sourceChannel !== "phone") {
    throw new InviteNativeError(
      "Only phone invites support call triggering",
      400,
      "BAD_REQUEST",
    );
  }
  if (!invite.expectedExternalUserId) {
    throw new InviteNativeError(
      "Invite is missing required voice metadata",
      400,
      "BAD_REQUEST",
    );
  }

  try {
    // `invites_trigger_call` reads params from RouteHandlerArgs (the assistant
    // IPC server spreads params): pathParams.id for the route path, body for
    // the resolved call fields.
    const result = (await ipcCallAssistant("invites_trigger_call", {
      pathParams: { id: inviteId },
      body: {
        phoneNumber: invite.expectedExternalUserId,
        friendName: resolveInviteeName(store, invite),
        guardianName: invite.guardianName ?? null,
      },
    } as unknown as Record<string, unknown>)) as { callSid: string };
    log.info(
      { inviteId, callSid: result.callSid },
      "call_invite: handled natively",
    );
    return { callSid: result.callSid };
  } catch (err) {
    if (err instanceof IpcHandlerError) {
      throw err;
    }
    log.error({ err, inviteId }, "call_invite: relay failed");
    throw new InviteNativeError(
      "Failed to trigger invite call",
      500,
      "INTERNAL_ERROR",
    );
  }
}

// ---------------------------------------------------------------------------
// ContactWithInfo -> ContactPayload mapping (gateway-native read path)
// ---------------------------------------------------------------------------

/**
 * Map a gateway-native ContactWithInfo to the wire ContactPayload shape the
 * UI expects (matching assistant/src/daemon/message-types/contacts.ts).
 *
 * Includes the `withChannelCompat` transform: older macOS clients expect
 * `externalUserId` on each channel (= address). The guardian-name override
 * (`withGuardianNameOverride`) is not applied — it reads the guardian persona
 * file which is assistant-side state, not available to the gateway process.
 */
function toContactPayload(c: ContactWithInfo): Record<string, unknown> {
  return {
    id: c.id,
    displayName: c.displayName,
    role: c.role,
    notes: c.notes,
    contactType: c.contactType,
    principalId: c.principalId,
    userFile: c.userFile,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    interactionCount: c.interactionCount,
    lastInteraction: c.lastInteraction,
    assistantMetadata: c.assistantMetadata,
    channels: c.channels.map((ch) => ({
      id: ch.id,
      contactId: ch.contactId,
      type: ch.type,
      address: ch.address,
      isPrimary: ch.isPrimary,
      externalChatId: ch.externalChatId,
      // Compat: externalUserId = address for older macOS clients.
      externalUserId: ch.address,
      status: ch.status,
      policy: ch.policy,
      verifiedAt: ch.verifiedAt,
      verifiedVia: ch.verifiedVia,
      inviteId: ch.inviteId,
      revokedReason: ch.revokedReason,
      blockedReason: ch.blockedReason,
      lastSeenAt: ch.lastSeenAt,
      interactionCount: ch.interactionCount,
      lastInteraction: ch.lastInteraction,
      createdAt: ch.createdAt,
      updatedAt: ch.updatedAt,
    })),
  };
}
const VALID_ASSISTANT_SPECIES = ["vellum"] as const;
const VALID_CHANNEL_STATUSES = [
  "active",
  "pending",
  "revoked",
  "blocked",
  "unverified",
] as const;
const VALID_CHANNEL_POLICIES = ["allow", "deny", "escalate"] as const;

type ContactType = (typeof VALID_CONTACT_TYPES)[number];
type AssistantSpecies = (typeof VALID_ASSISTANT_SPECIES)[number];
type ChannelStatus = (typeof VALID_CHANNEL_STATUSES)[number];
type ChannelPolicy = (typeof VALID_CHANNEL_POLICIES)[number];

function isContactType(v: unknown): v is ContactType {
  return VALID_CONTACT_TYPES.includes(v as ContactType);
}
function isAssistantSpecies(v: unknown): v is AssistantSpecies {
  return VALID_ASSISTANT_SPECIES.includes(v as AssistantSpecies);
}
function isChannelStatus(v: unknown): v is ChannelStatus {
  return VALID_CHANNEL_STATUSES.includes(v as ChannelStatus);
}
function isChannelPolicy(v: unknown): v is ChannelPolicy {
  return VALID_CHANNEL_POLICIES.includes(v as ChannelPolicy);
}

/**
 * Transport-agnostic channel status/policy write.
 *
 * Shared by the HTTP `handleUpdateContactChannel` and the gateway IPC
 * `update_contact_channel` route. Validates status/policy, performs the
 * gateway DB write (source of truth) via `ContactStore.updateChannelStatus`
 * — which preserves the revoke-of-blocked guard and resolves assistant-side
 * channel IDs via the (contactId, type, address) backward-compat path —
 * best-effort mirrors into the assistant DB, emits `contacts_changed`, and
 * returns the parent contact payload.
 *
 * Throws `ContactChannelNativeError` for client-facing failures (400 bad
 * status/policy, 404 unknown channel, 409 revoke-of-blocked). Unexpected
 * errors propagate so each transport surfaces a 500-equivalent — never a
 * silent fallback.
 */
export async function updateContactChannelCore(params: {
  contactChannelId: string;
  status?: string;
  policy?: string;
  reason?: string | null;
}): Promise<{ ok: true; contact?: Record<string, unknown> }> {
  const { contactChannelId } = params;
  const status = params.status;
  const policy = params.policy;
  const reason = params.reason ?? null;

  if (status !== undefined && !isChannelStatus(status)) {
    throw new ContactChannelNativeError(
      `Invalid status "${status}". Must be one of: ${VALID_CHANNEL_STATUSES.join(", ")}`,
      400,
      "BAD_REQUEST",
    );
  }
  if (policy !== undefined && !isChannelPolicy(policy)) {
    throw new ContactChannelNativeError(
      `Invalid policy "${policy}". Must be one of: ${VALID_CHANNEL_POLICIES.join(", ")}`,
      400,
      "BAD_REQUEST",
    );
  }
  if (status === undefined && policy === undefined) {
    throw new ContactChannelNativeError(
      "At least one of status or policy must be provided",
      400,
      "BAD_REQUEST",
    );
  }

  const store = new ContactStore();
  let updated;
  try {
    updated = await store.updateChannelStatus(contactChannelId, {
      status,
      policy,
      reason,
    });
  } catch (err) {
    if (err instanceof CannotRevokeBlockedError) {
      throw new ContactChannelNativeError(err.message, 409, "CONFLICT");
    }
    throw err;
  }

  if (!updated) {
    throw new ContactChannelNativeError(
      `Channel "${contactChannelId}" not found`,
      404,
      "NOT_FOUND",
    );
  }

  // Emit contacts_changed so connected clients refresh.
  void ipcCallAssistant("emit_event", {
    body: { kind: "contacts_changed" },
  } as unknown as Record<string, unknown>).catch(() => {});

  const contact = await store.getContactWithInfo(updated.contactId);
  log.info(
    { contactChannelId, contactId: updated.contactId, status, policy },
    "update_channel: handled natively",
  );
  return {
    ok: true,
    contact: contact ? toContactPayload(contact) : undefined,
  };
}

/**
 * Validate that metadata matches the expected shape for the given species.
 * Mirrors `validateSpeciesMetadata` in `assistant/src/contacts/contact-store.ts`.
 */
function validateSpeciesMetadata(
  species: AssistantSpecies,
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  if (metadata == null) return null;

  if (species === "vellum") {
    if (typeof metadata.assistantId !== "string" || !metadata.assistantId) {
      return 'Vellum assistant metadata requires a non-empty "assistantId" string';
    }
    if (typeof metadata.gatewayUrl !== "string" || !metadata.gatewayUrl) {
      return 'Vellum assistant metadata requires a non-empty "gatewayUrl" string';
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// ACL overlay for daemon-forwarded (filtered/search) contact reads
// ---------------------------------------------------------------------------
//
// The gateway DB is the ACL source of truth. The daemon's search /
// contactType-filtered reads carry NEUTRAL ACL (role "contact", channels with
// no status/policy/verified*/reason), so we overlay authoritative ACL onto the
// forwarded body before returning.

/** Copy the six ACL fields from a gateway ChannelAcl onto a daemon channel. */
function applyChannelAcl(
  channel: Record<string, unknown>,
  acl: ChannelAcl,
): void {
  channel.status = acl.status;
  channel.policy = acl.policy;
  channel.verifiedAt = acl.verifiedAt;
  channel.verifiedVia = acl.verifiedVia;
  channel.revokedReason = acl.revokedReason;
  channel.blockedReason = acl.blockedReason;
}

/**
 * Logical channel key: (type, lower(address)) — mirrors the case-insensitive
 * key the gateway ACL uses (UNIQUE(type, address) collates NOCASE). The
 * escaped NUL delimiter cannot appear in either field, so keys never collide.
 */
function channelKey(type: string, address: string): string {
  return `${type}\u0000${address.toLowerCase()}`;
}

/**
 * Overlay authoritative gateway ACL onto a parsed daemon contact-list body
 * (in place). For each contact, replace contact-level `role` and per-channel
 * ACL fields from the gateway map. Channels match by `id` first, then by
 * `(type, address)`; an unmatched channel keeps the daemon's ACL. A contact
 * absent from the gateway map (dual-write gap) is left untouched + warned.
 *
 * Pure aside from the warn log; mutates the passed contacts array's elements.
 */
function overlayAclOntoContacts(
  contacts: Array<Record<string, unknown>>,
  aclByContactId: Map<string, ContactAcl>,
): void {
  for (const contact of contacts) {
    const id = contact.id;
    if (typeof id !== "string") continue;
    const acl = aclByContactId.get(id);
    if (!acl) {
      // Dual-write gap: present in the daemon read but absent from the gateway
      // ACL source of truth. Leave the daemon's ACL; don't drop the contact.
      log.warn(
        { contactId: id },
        "overlayAclOntoContacts: contact missing from gateway ACL (dual-write gap); leaving daemon ACL",
      );
      continue;
    }

    contact.role = acl.role;

    const channels = contact.channels;
    if (!Array.isArray(channels)) continue;

    // Index gateway channels by (type, lower(address)) for the id-miss fallback.
    const byTypeAddress = new Map<string, ChannelAcl>();
    for (const ch of acl.channels.values()) {
      byTypeAddress.set(channelKey(ch.type, ch.address), ch);
    }

    for (const ch of channels) {
      if (typeof ch !== "object" || ch === null) continue;
      const channel = ch as Record<string, unknown>;
      const chId = channel.id;
      let match = typeof chId === "string" ? acl.channels.get(chId) : undefined;
      if (!match) {
        const type = channel.type;
        const address = channel.address;
        if (typeof type === "string" && typeof address === "string") {
          match = byTypeAddress.get(channelKey(type, address));
        }
      }
      if (match) applyChannelAcl(channel, match);
    }
  }
}

/** Locate the contacts array within the daemon `/v1/contacts` envelope. */
function extractContactsArray(
  body: unknown,
): Array<Record<string, unknown>> | null {
  if (typeof body !== "object" || body === null) return null;
  const contacts = (body as Record<string, unknown>).contacts;
  if (!Array.isArray(contacts)) return null;
  return contacts as Array<Record<string, unknown>>;
}

export function createContactsControlPlaneProxyHandler(config: GatewayConfig) {
  async function forward(
    req: Request,
    upstreamPath: string,
    upstreamSearch?: string,
  ): Promise<Response> {
    const start = performance.now();
    const result = await proxyForward(req, {
      baseUrl: config.assistantRuntimeBaseUrl,
      path: upstreamPath,
      search: upstreamSearch,
      serviceToken: mintServiceToken(),
      timeoutMs: config.runtimeTimeoutMs,
      fetchImpl,
    });

    const duration = Math.round(performance.now() - start);

    if (result.gatewayError) {
      log.error(
        { path: upstreamPath, duration },
        result.status === 504
          ? "Ingress control-plane proxy upstream timed out"
          : "Ingress control-plane proxy upstream connection failed",
      );
    } else if (result.status >= 400) {
      log.warn(
        { path: upstreamPath, status: result.status, duration },
        "Ingress control-plane proxy upstream error",
      );
    } else {
      log.info(
        { path: upstreamPath, status: result.status, duration },
        "Ingress control-plane proxy completed",
      );
    }

    return new Response(result.body, {
      status: result.status,
      headers: result.headers,
    });
  }

  /**
   * Forward the filtered/search contact list to the daemon, then overlay
   * authoritative gateway-DB ACL onto the response body (role + per-channel
   * status/policy/verified/reasons). The daemon owns filter/search + info;
   * the gateway owns ACL (the daemon emits neutral ACL).
   *
   * SOFT-FAIL: if the upstream status isn't 2xx, the body isn't the expected
   * JSON envelope, or the gateway ACL read throws — the ORIGINAL daemon bytes
   * are returned unchanged (preserving status). The overlay never turns a
   * working (if stale) read into a 500.
   *
   * Entity headers (content-length, content-encoding) are dropped on both
   * paths: we always emit a freshly-serialized string body, so the runtime
   * recomputes content-length — reusing the upstream length would truncate the
   * (resized) overlaid body.
   */
  async function forwardListWithAclOverlay(
    req: Request,
    upstreamSearch: string,
  ): Promise<Response> {
    const upstream = await forward(req, "/v1/contacts", upstreamSearch);

    // Capture the body once; we both read it for overlay and replay it raw on
    // any soft-fail. A Response body can only be consumed once.
    const text = await upstream.text();
    const headers = new Headers(upstream.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    const respond = (payload: string) =>
      new Response(payload, { status: upstream.status, headers });

    if (upstream.status < 200 || upstream.status >= 300) {
      return respond(text);
    }

    try {
      const body = JSON.parse(text) as unknown;
      const contacts = extractContactsArray(body);
      if (!contacts) return respond(text);

      const ids = contacts
        .map((c) => c.id)
        .filter((id): id is string => typeof id === "string");
      const aclByContactId = await new ContactStore().getAclByContactIds(ids);

      overlayAclOntoContacts(contacts, aclByContactId);

      return respond(JSON.stringify(body));
    } catch (err) {
      log.warn(
        { err },
        "list_contacts: ACL overlay failed; returning daemon response unchanged",
      );
      return respond(text);
    }
  }

  return {
    // ── Contact CRUD ──
    /**
     * GET /v1/contacts — gateway-native contact list.
     *
     * Reads ACL shape from gateway DB + info shape from assistant DB (single
     * batched join). Falls back to the daemon proxy for search-style queries
     * (query, channelAddress, channelType) which require searchContacts logic
     * not yet implemented in the gateway.
     *
     * Supported natively: limit, role, contactType.
     */
    async handleListContacts(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const role = url.searchParams.get("role") ?? undefined;
      const contactType = url.searchParams.get("contactType") ?? undefined;
      const query = url.searchParams.get("query") ?? undefined;
      const channelAddress =
        url.searchParams.get("channelAddress") ?? undefined;
      const channelType = url.searchParams.get("channelType") ?? undefined;

      // Validate contactType before any proxy fallback.
      if (contactType && !VALID_CONTACT_TYPES.includes(contactType as never)) {
        return Response.json(
          {
            error: {
              code: "BAD_REQUEST",
              message: `Invalid contactType "${contactType}". Must be one of: ${VALID_CONTACT_TYPES.join(", ")}`,
            },
          },
          { status: 400 },
        );
      }

      // Search-style queries and contactType filter go through the daemon
      // (it owns filter/search + info/identity). The daemon emits NEUTRAL ACL,
      // so overlay authoritative gateway-DB ACL onto the forwarded body before
      // returning.
      if (query || channelAddress || channelType || contactType) {
        return forwardListWithAclOverlay(req, url.search);
      }

      try {
        const store = new ContactStore();
        const contacts = await store.listContactsWithInfo({
          limit,
          role: role ?? undefined,
        });
        log.info(
          { count: contacts.length, role, contactType, limit },
          "list_contacts: handled natively",
        );
        return Response.json({
          ok: true,
          contacts: contacts.map(toContactPayload),
        });
      } catch (err) {
        log.error(
          { err },
          "list_contacts: gateway-native read failed, falling back to proxy",
        );
        return forward(req, "/v1/contacts", url.search);
      }
    },

    /**
     * POST /v1/contacts — gateway-native contact upsert.
     *
     * Writes the gateway DB (auth/authz fields: id, displayName, role,
     * principalId + channels) and mirrors the identity/info fields (notes,
     * userFile, contactType, assistantMetadata) to the assistant DB via the
     * typed `contacts_mirror_upsert_full` op (best-effort).
     *
     * Resolution order mirrors the assistant's upsertContact:
     *  1. Match by `body.id` if provided.
     *  2. Match by (type, address) on any provided channel.
     *  3. Create a new contact with a generated id.
     */
    async handleUpsertContact(req: Request): Promise<Response> {
      // ── Parse body ──────────────────────────────────────────────────
      let body: Record<string, unknown>;
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        return Response.json(
          { error: { code: "BAD_REQUEST", message: "Invalid JSON body" } },
          { status: 400 },
        );
      }

      // ── Validate ────────────────────────────────────────────────────
      if (
        !body.displayName ||
        typeof body.displayName !== "string" ||
        !body.displayName.trim()
      ) {
        return Response.json(
          {
            error: {
              code: "BAD_REQUEST",
              message: "displayName is required and must be a non-empty string",
            },
          },
          { status: 400 },
        );
      }
      const displayName = (body.displayName as string).trim();

      if (body.contactType !== undefined && !isContactType(body.contactType)) {
        return Response.json(
          {
            error: {
              code: "BAD_REQUEST",
              message: `Invalid contactType "${body.contactType}". Must be one of: ${VALID_CONTACT_TYPES.join(", ")}`,
            },
          },
          { status: 400 },
        );
      }

      const assistantMeta = body.assistantMetadata as
        | { species?: unknown; metadata?: unknown }
        | undefined;

      if (body.contactType === "assistant") {
        if (!assistantMeta) {
          return Response.json(
            {
              error: {
                code: "BAD_REQUEST",
                message:
                  'assistantMetadata is required when contactType is "assistant"',
              },
            },
            { status: 400 },
          );
        }
        if (!isAssistantSpecies(assistantMeta.species)) {
          return Response.json(
            {
              error: {
                code: "BAD_REQUEST",
                message: `Invalid species "${assistantMeta.species}". Must be one of: ${VALID_ASSISTANT_SPECIES.join(", ")}`,
              },
            },
            { status: 400 },
          );
        }
        const speciesError = validateSpeciesMetadata(
          assistantMeta.species,
          assistantMeta.metadata as Record<string, unknown> | null | undefined,
        );
        if (speciesError) {
          return Response.json(
            { error: { code: "BAD_REQUEST", message: speciesError } },
            { status: 400 },
          );
        }
      }
      if (body.contactType === "human" && assistantMeta) {
        return Response.json(
          {
            error: {
              code: "BAD_REQUEST",
              message:
                'assistantMetadata must not be provided when contactType is "human"',
            },
          },
          { status: 400 },
        );
      }
      if (assistantMeta && !body.contactType) {
        return Response.json(
          {
            error: {
              code: "BAD_REQUEST",
              message:
                'contactType must be "assistant" when assistantMetadata is provided',
            },
          },
          { status: 400 },
        );
      }

      type ChannelInput = {
        type: string;
        address: string;
        isPrimary?: boolean;
        externalUserId?: string | null;
        externalChatId?: string | null;
        status?: string;
        policy?: string;
      };

      const channelInputs = body.channels as ChannelInput[] | undefined;
      if (channelInputs !== undefined) {
        if (!Array.isArray(channelInputs)) {
          return Response.json(
            {
              error: {
                code: "BAD_REQUEST",
                message: "channels must be an array",
              },
            },
            { status: 400 },
          );
        }
        for (const ch of channelInputs) {
          if (typeof ch?.type !== "string" || !ch.type.trim()) {
            return Response.json(
              {
                error: {
                  code: "BAD_REQUEST",
                  message:
                    "channel.type is required and must be a non-empty string",
                },
              },
              { status: 400 },
            );
          }
          if (typeof ch?.address !== "string" || !ch.address.trim()) {
            return Response.json(
              {
                error: {
                  code: "BAD_REQUEST",
                  message:
                    "channel.address is required and must be a non-empty string",
                },
              },
              { status: 400 },
            );
          }
          if (ch.status !== undefined && !isChannelStatus(ch.status)) {
            return Response.json(
              {
                error: {
                  code: "BAD_REQUEST",
                  message: `Invalid channel status "${ch.status}". Must be one of: ${VALID_CHANNEL_STATUSES.join(", ")}`,
                },
              },
              { status: 400 },
            );
          }
          if (ch.policy !== undefined && !isChannelPolicy(ch.policy)) {
            return Response.json(
              {
                error: {
                  code: "BAD_REQUEST",
                  message: `Invalid channel policy "${ch.policy}". Must be one of: ${VALID_CHANNEL_POLICIES.join(", ")}`,
                },
              },
              { status: 400 },
            );
          }
        }
      }

      // ── Service-layer write (gateway DB + typed assistant mirror) ────
      //
      // SECURITY: `role` and `principalId` are auth/authz fields. They are
      // NEVER read from the request body. The route is protected by generic
      // edge auth, not a guardian-specific check — accepting these fields
      // from the body would let any authenticated caller rebind the guardian
      // (e.g. POST /v1/contacts with the guardian's id + role:"guardian" +
      // their own principalId). Guardian role is set exclusively through
      // guardian-bootstrap, which uses raw SQL with its own privileged path.
      const store = new ContactStore();
      const { contact, created } = await store.upsertContact({
        id: body.id as string | undefined,
        displayName,
        notes: body.notes as string | null | undefined,
        contactType: body.contactType as string | undefined,
        assistantMetadata:
          body.contactType === "assistant" && assistantMeta
            ? {
                species: assistantMeta.species as string,
                metadata:
                  (assistantMeta.metadata as
                    | Record<string, unknown>
                    | null
                    | undefined) ?? null,
              }
            : undefined,
        channels: channelInputs?.map((ch) => ({
          type: ch.type,
          address: ch.address,
          isPrimary: ch.isPrimary,
          externalChatId: ch.externalChatId ?? null,
          status: ch.status,
          policy: ch.policy,
        })),
      });

      // ── Emit contacts_changed ────────────────────────────────────────
      void ipcCallAssistant("emit_event", {
        body: { kind: "contacts_changed" },
      } as unknown as Record<string, unknown>).catch(() => {});

      log.info(
        { contactId: contact.id, created },
        "upsert_contact: handled natively",
      );
      // ACL (role/principalId, channel status/policy) is sourced from the
      // gateway DB inside upsertContact's read-back, so this response reflects
      // the just-written source of truth, not assistant-mirror defaults.
      return Response.json({ ok: true, contact: toContactPayload(contact) });
    },

    /**
     * GET /v1/contacts/:id — gateway-native single contact read.
     *
     * Reads ACL shape from gateway DB + info shape from assistant DB. Falls
     * back to the daemon proxy if the gateway-native read throws.
     */
    async handleGetContact(req: Request, contactId: string): Promise<Response> {
      try {
        const store = new ContactStore();
        const contact = await store.getContactWithInfo(contactId);
        if (!contact) {
          return Response.json(
            {
              error: {
                code: "NOT_FOUND",
                message: `Contact "${contactId}" not found`,
              },
            },
            { status: 404 },
          );
        }
        log.info({ contactId }, "get_contact: handled natively");

        // Match the daemon's response shape: { ok, contact, assistantMetadata }
        const payload = toContactPayload(contact);
        const assistantMetadata =
          contact.contactType === "assistant" && contact.assistantMetadata
            ? {
                contactId: contact.id,
                species: contact.assistantMetadata.species,
                metadata: contact.assistantMetadata.metadata,
              }
            : undefined;
        return Response.json({
          ok: true,
          contact: payload,
          assistantMetadata: assistantMetadata ?? undefined,
        });
      } catch (err) {
        log.error(
          { err, contactId },
          "get_contact: gateway-native read failed, falling back to proxy",
        );
        return forward(req, `/v1/contacts/${contactId}`);
      }
    },

    async handleDeleteContact(contactId: string): Promise<Response> {
      // The gateway DB is the source of truth for role + ACL, but the assistant
      // DB is a best-effort mirror that can hold a contact the gateway never
      // recorded (a dual-write gap on inbound seeding: the mirror row lands, then
      // the gateway write is swallowed on error or a (type,address) conflict).
      // The contacts list can surface such an orphan (search/filter reads fall
      // back to the daemon), so resolve the contact in BOTH stores and delete it
      // from whichever holds it; 404 only when it exists in neither. Channels
      // cascade on delete in each DB.
      const gatewayRow = getGatewayDb()
        .select({ role: contacts.role })
        .from(contacts)
        .where(eq(contacts.id, contactId))
        .get();

      // Best-effort mirror lookup: if the assistant DB is unavailable, degrade
      // to a gateway-only decision rather than failing the delete. The gateway
      // DB is the source of truth; the mirror is only a cleanup target.
      let inMirror = false;
      try {
        const probe = await probeContactMirror(contactId);
        inMirror = probe.exists;
      } catch (err) {
        log.warn(
          { err, contactId },
          "delete_contact: mirror lookup failed (best-effort); proceeding with gateway-only check",
        );
      }

      if (!gatewayRow && !inMirror) {
        log.warn(
          { contactId },
          "delete_contact: not found in gateway or assistant DB",
        );
        return Response.json(
          {
            error: {
              code: "NOT_FOUND",
              message: `Contact "${contactId}" not found`,
            },
          },
          { status: 404 },
        );
      }

      // Guardian role is gateway-DB source of truth. Guardians are always
      // created gateway-first, so an absent gateway row is never a guardian; a
      // gateway guardian row is protected regardless of the mirror state.
      if (gatewayRow?.role === "guardian") {
        log.warn({ contactId }, "delete_contact: attempted to delete guardian");
        return Response.json(
          {
            error: {
              code: "FORBIDDEN",
              message: "Cannot delete a guardian contact",
            },
          },
          { status: 403 },
        );
      }

      // Delete from both stores (a delete against the store lacking the row is a
      // harmless no-op), so an assistant-only orphan is cleaned up and stops
      // showing in the UI. The mirror delete is best-effort — the gateway
      // (source of truth) delete below always applies, even if the mirror is
      // unavailable.
      try {
        await ipcCallAssistant("contacts_mirror_delete_contact", {
          body: { contactId },
        });
      } catch (err) {
        log.warn(
          { err, contactId },
          "delete_contact: mirror delete failed (best-effort); gateway delete still applied",
        );
      }
      getGatewayDb().delete(contacts).where(eq(contacts.id, contactId)).run();
      void ipcCallAssistant("emit_event", {
        body: { kind: "contacts_changed" },
      } as unknown as Record<string, unknown>).catch(() => {});
      log.info(
        { contactId, gateway: !!gatewayRow, mirror: inMirror },
        "delete_contact: deleted",
      );
      return new Response(null, { status: 204 });
    },

    /**
     * POST /v1/contacts/merge — gateway-native contact merge.
     *
     * Moves channels from donor to survivor, deletes the donor in the
     * gateway DB (single transaction), then best-effort concatenates notes
     * and deletes the donor in the assistant DB. Returns the survivor
     * contact with channels + info.
     *
     * No proxy fallback: the body is already consumed by req.json(), and
     * falling back to the daemon would create split-brain (daemon moves
     * channels in assistant DB while gateway DB is stale).
     */
    async handleMergeContacts(req: Request): Promise<Response> {
      let body: Record<string, unknown>;
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        return Response.json(
          {
            error: {
              code: "BAD_REQUEST",
              message: "Request body must be valid JSON",
            },
          },
          { status: 400 },
        );
      }

      const keepId = body.keepId as string | undefined;
      const mergeId = body.mergeId as string | undefined;

      if (!keepId || !mergeId) {
        return Response.json(
          {
            error: {
              code: "BAD_REQUEST",
              message: "keepId and mergeId are required",
            },
          },
          { status: 400 },
        );
      }

      try {
        const store = new ContactStore();
        const contact = await store.mergeContacts(keepId, mergeId);

        // Emit contacts_changed so connected clients refresh.
        void ipcCallAssistant("emit_event", {
          body: { kind: "contacts_changed" },
        } as unknown as Record<string, unknown>).catch(() => {});

        log.info({ keepId, mergeId }, "merge_contacts: handled natively");
        return Response.json({
          ok: true,
          contact: contact ? toContactPayload(contact) : undefined,
        });
      } catch (err) {
        if (err instanceof MergeContactsError) {
          return Response.json(
            {
              error: {
                code: "BAD_REQUEST",
                message: err.message,
              },
            },
            { status: 400 },
          );
        }
        log.error(
          { keepId, mergeId, err },
          "merge_contacts: gateway-native merge failed",
        );
        return Response.json(
          {
            error: {
              code: "INTERNAL_ERROR",
              message: "Failed to merge contacts",
            },
          },
          { status: 500 },
        );
      }
    },

    /**
     * PATCH /v1/contact-channels/:id — gateway-native channel status/policy
     * update.
     *
     * Updates the channel in the gateway DB (ACL source of truth) and
     * best-effort dual-writes to the assistant DB. Returns the parent
     * contact via getContactWithInfo so the UI gets the full updated shape.
     */
    async handleUpdateContactChannel(
      req: Request,
      contactChannelId: string,
    ): Promise<Response> {
      let body: Record<string, unknown>;
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        return Response.json(
          {
            error: {
              code: "BAD_REQUEST",
              message: "Request body must be valid JSON",
            },
          },
          { status: 400 },
        );
      }

      const status = body.status as string | undefined;
      const policy = body.policy as string | undefined;
      const reason = (body.reason as string | null | undefined) ?? null;

      try {
        const result = await updateContactChannelCore({
          contactChannelId,
          status,
          policy,
          reason,
        });
        return Response.json(result);
      } catch (err) {
        if (err instanceof ContactChannelNativeError) {
          return Response.json(
            { error: { code: err.code, message: err.message } },
            { status: err.statusCode },
          );
        }
        log.error(
          { contactChannelId, err },
          "update_channel: gateway-native update failed",
        );
        return Response.json(
          {
            error: {
              code: "INTERNAL_ERROR",
              message: "Failed to update channel",
            },
          },
          { status: 500 },
        );
      }
    },

    /**
     * POST /v1/contact-channels/:id/verify — guardian-only manual verify.
     *
     * Gateway-native + dual-write: the channel mutation happens in the
     * gateway DB first (source of truth); a best-effort mirror is written
     * to the assistant DB so the daemon stays in sync during the
     * gateway-security-migration transition period.
     *
     * Migration-window backfill: when the gateway DB has never seen the
     * channel but the assistant DB has it, the channel (and its parent
     * contact) is mirrored into the gateway before the verify write so the
     * user-visible channel id from the assistant UI doesn't 404 here.
     *
     * Idempotent: a row that's already active+verifiedVia=manual returns
     * the same shape (200 with channel) but no second write occurs.
     */
    async handleVerifyContactChannel(
      _req: Request,
      contactChannelId: string,
    ): Promise<Response> {
      const result = await new ContactStore().markChannelVerified(
        contactChannelId,
      );
      if (!result) {
        return Response.json(
          {
            error: {
              code: "NOT_FOUND",
              message: `Channel "${contactChannelId}" not found`,
            },
          },
          { status: 404 },
        );
      }
      log.info(
        {
          contactChannelId,
          didWrite: result.didWrite,
          status: result.channel.status,
        },
        "manual_verify: channel attested verified by guardian",
      );
      return Response.json({ ok: true, channel: result.channel });
    },

    // ── Invite routes (gateway-native) ──
    //
    // The gateway DB's ingress_invites is the source of truth for invite
    // lifecycle and secrets: mint and redemption are fully gateway-native.
    // Outbound calls validate the gateway row then relay the provider call
    // to the assistant. None of these handlers fall back to `forward` on
    // error — mutations 500 instead.

    /**
     * GET /v1/contacts/invites — gateway-native invite list.
     *
     * A single gateway-DB read: the ingress_invites row carries the voice UX
     * fields (voiceCodeDigits, friendName, etc.) alongside lifecycle state.
     * Rows are sanitized (no code/token hashes) before returning.
     */
    async handleListInvites(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const query = parseListInviteQuery(url.searchParams);
      try {
        const { invites } = await listInvitesNative(query);
        return Response.json({ ok: true, invites });
      } catch (err) {
        return inviteErrorResponse(err);
      }
    },

    /**
     * POST /v1/contacts/invites — gateway-native invite create.
     *
     * The gateway mints the secrets and writes the single canonical invite
     * row in its own DB. The response carries the one-time plaintext secrets
     * plus the daemon-owned presentation fields (share link, guardian
     * instruction, channel handle), composed best-effort via the
     * `invites_compose_presentation` daemon IPC — a daemon failure degrades
     * to the raw minted payload rather than failing the create.
     */
    async handleCreateInvite(req: Request): Promise<Response> {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return Response.json(
          { error: { code: "BAD_REQUEST", message: "Invalid JSON body" } },
          { status: 400 },
        );
      }

      const parsed = parseCreateInviteBody(body);
      if (!parsed.ok) {
        return Response.json(
          { error: { code: "BAD_REQUEST", message: parsed.message } },
          { status: 400 },
        );
      }

      try {
        const result = await createInviteNative(parsed.value);
        const invite = await composePresentationBestEffort({
          contactId: parsed.value.contactId,
          invite: result.invite,
          rawToken: result.rawToken,
        });
        return Response.json(
          { ok: true, invite, rawToken: result.rawToken },
          { status: 201 },
        );
      } catch (err) {
        return inviteErrorResponse(err);
      }
    },

    /**
     * POST /v1/contacts/invites/redeem — gateway-native invite redeem.
     *
     * Voice-code and token redemption both run through the gateway
     * redemption engine directly (redeemInviteNative); no assistant
     * round-trip. Engine failures surface as 400 BAD_REQUEST with the
     * engine reason; anything else is a 500.
     */
    async handleRedeemInvite(req: Request): Promise<Response> {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return Response.json(
          { error: { code: "BAD_REQUEST", message: "Invalid JSON body" } },
          { status: 400 },
        );
      }

      const parsed = parseRedeemInviteBody(body);
      if (!parsed.ok) {
        return Response.json(
          { error: { code: "BAD_REQUEST", message: parsed.message } },
          { status: 400 },
        );
      }

      try {
        return Response.json(await redeemInviteNative(parsed.value));
      } catch (err) {
        if (err instanceof InviteNativeError) {
          return inviteErrorResponse(err);
        }
        log.error({ err }, "redeem_invite: native redemption failed");
        return Response.json(
          {
            error: {
              code: "INTERNAL_ERROR",
              message: "Failed to redeem invite",
            },
          },
          { status: 500 },
        );
      }
    },

    /**
     * POST /v1/contacts/invites/:id/call — gateway-native outbound call relay.
     *
     * Verifies the invite exists + is active in the gateway DB (source of
     * truth for lifecycle), then relays the provider-specific call to the
     * assistant. The gateway gates; the assistant places the call.
     */
    async handleCallInvite(_req: Request, inviteId: string): Promise<Response> {
      try {
        const result = await triggerInviteCallNative(inviteId);
        return Response.json({ ok: true, callSid: result.callSid });
      } catch (err) {
        return inviteErrorResponse(err);
      }
    },

    /**
     * DELETE /v1/contacts/invites/:id — gateway-native invite revoke.
     *
     * A single gateway-DB UPDATE (source of truth). 404 if the id is unknown.
     */
    async handleRevokeInvite(
      _req: Request,
      inviteId: string,
    ): Promise<Response> {
      try {
        const { invite } = await revokeInviteNative(inviteId);
        return Response.json({ ok: true, invite });
      } catch (err) {
        return inviteErrorResponse(err);
      }
    },
  };
}
