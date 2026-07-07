/**
 * Gateway-native guardian bootstrap — mints credentials using the
 * gateway's own SQLite database for token persistence and mirror-writes
 * contact bindings to the assistant's database via IPC proxy.
 *
 * Uses the gateway's own signing key for JWT minting.
 */

import { createHash, randomBytes } from "node:crypto";

import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";

import { getGatewayDb } from "../db/connection.js";
import {
  actorRefreshTokenRecords,
  actorTokenRecords,
  contacts as gwContacts,
  contactChannels as gwContactChannels,
} from "../db/schema.js";
import { readCredential } from "../credential-reader.js";
import { credentialKey } from "../credential-key.js";
import { arePlatformFeaturesEnabled } from "../feature-flag-resolver.js";
import { ipcCallAssistant } from "../ipc/assistant-client.js";
import { getLogger } from "../logger.js";
import { deleteContactIfOrphaned } from "../verification/contact-helpers.js";

import {
  bustGuardianIntegrityCache,
  guardianIntegrityState,
  hasEvidenceOfPriorGuardian,
} from "./guardian-integrity.js";
import { CURRENT_POLICY_EPOCH } from "./policy.js";
import { mintToken } from "./token-service.js";

const log = getLogger("guardian-bootstrap");

// ---------------------------------------------------------------------------
// Constants — canonical values for token TTLs and refresh thresholds.
// ---------------------------------------------------------------------------

/** Access token TTL: 30 days in seconds. */
export const ACCESS_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Access token TTL in ms. */
export const ACCESS_TOKEN_TTL_MS = ACCESS_TOKEN_TTL_SECONDS * 1000;

/** Refresh token absolute expiry: 365 days. */
export const REFRESH_ABSOLUTE_TTL_MS = 365 * 24 * 60 * 60 * 1000;

/** Refresh token inactivity expiry: 90 days. */
export const REFRESH_INACTIVITY_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** Suggest refresh at 80% of access token TTL. */
export const REFRESH_AFTER_FRACTION = 0.8;

/** The daemon's internal assistant scope identifier. */
const DAEMON_INTERNAL_ASSISTANT_ID = "self";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GuardianBootstrapResult {
  guardianPrincipalId: string;
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken: string;
  refreshTokenExpiresAt: number;
  refreshAfter: number;
  isNew: boolean;
  /** True when the mint overrode evidence of a prior guardian (re-pair). */
  mintedOverPriorEvidence: boolean;
}

/**
 * Thrown when a vellum guardian mint is refused: the gateway DB has no active
 * vellum guardian binding but carries evidence of prior onboarding, so a mint
 * would permanently diverge from prior clients' tokens. Recovery is the
 * explicit /v1/guardian/init flow.
 */
export class VellumGuardianMintRefusedError extends Error {
  constructor() {
    super(
      "refusing to mint a vellum guardian principal: the gateway DB has " +
        "evidence of a prior guardian — re-pair via guardian init to recover",
    );
    this.name = "VellumGuardianMintRefusedError";
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function uuid(): string {
  return crypto.randomUUID();
}

export function getExternalAssistantId(): string {
  return (
    process.env.VELLUM_ASSISTANT_NAME?.trim() || DAEMON_INTERNAL_ASSISTANT_ID
  );
}

// ---------------------------------------------------------------------------
// Contact operations (via IPC proxy to assistant's DB)
// ---------------------------------------------------------------------------

/**
 * Find the existing guardian contact for the "vellum" channel.
 * Mirrors assistant's `findGuardianForChannel("vellum")`.
 */
export async function findVellumGuardian(): Promise<{
  principalId: string;
} | null> {
  const row = getGatewayDb()
    .select({ principalId: gwContacts.principalId })
    .from(gwContacts)
    .innerJoin(
      gwContactChannels,
      eq(gwContactChannels.contactId, gwContacts.id),
    )
    .where(
      and(
        eq(gwContacts.role, "guardian"),
        eq(gwContactChannels.type, "vellum"),
        eq(gwContactChannels.status, "active"),
      ),
    )
    .orderBy(desc(gwContactChannels.verifiedAt))
    .limit(1)
    .get();

  return row?.principalId ? { principalId: row.principalId } : null;
}

/**
 * Look up the guardian binding for a given external user on a specific
 * channel type (e.g. `"slack"`, `"telegram"`, `"whatsapp"`). Returns the
 * guardian's principal ID when the actor is bound as a guardian on an
 * active channel of that type, or `null` otherwise.
 *
 * Used by channel ingress paths to decide whether an inbound message
 * came from the assistant's owner — see `index.ts` Slack upload flow.
 */
export async function findGuardianForChannelActor(
  channelType: string,
  externalUserId: string,
): Promise<{ principalId: string } | null> {
  if (!channelType || !externalUserId) return null;

  const row = getGatewayDb()
    .select({ principalId: gwContacts.principalId })
    .from(gwContacts)
    .innerJoin(
      gwContactChannels,
      eq(gwContactChannels.contactId, gwContacts.id),
    )
    .where(
      and(
        eq(gwContacts.role, "guardian"),
        eq(gwContactChannels.type, channelType),
        eq(gwContactChannels.status, "active"),
        sql`${gwContactChannels.address} = ${externalUserId} COLLATE NOCASE`,
      ),
    )
    .limit(1)
    .get();

  return row?.principalId ? { principalId: row.principalId } : null;
}

// ---------------------------------------------------------------------------
// Guardian binding creation — writes to both assistant + gateway DBs
// ---------------------------------------------------------------------------

export interface CreateGuardianBindingParams {
  /** Channel type (e.g. "vellum", "telegram", "slack", "phone", "whatsapp"). */
  channel: string;
  /** Canonical external user ID for this channel (pre-canonicalized by caller). */
  externalUserId: string;
  /** Delivery chat/conversation ID for this channel. */
  deliveryChatId: string;
  /** Guardian's principal ID — links all channel bindings to one identity. */
  guardianPrincipalId: string;
  /** Display name for the contact. Defaults to externalUserId. */
  displayName?: string;
  /** How this binding was verified. Defaults to "challenge". */
  verifiedVia?: string;
}

export interface CreateGuardianBindingResult {
  contactId: string;
  channelId: string;
  guardianPrincipalId: string;
  channel: string;
}

/** Result of the sync gateway-authoritative writes, consumed by the mirror. */
export interface GuardianBindingGatewayWrites {
  contactId: string;
  channelId: string;
  channel: string;
  address: string;
  deliveryChatId: string;
  displayName: string;
  guardianPrincipalId: string;
  /** Contact a claimed channel was re-parented away from (orphan-GC input). */
  claimedFromContactId: string | null;
}

/**
 * Gateway-authoritative writes for a guardian binding — fully synchronous so
 * callers can compose it inside a single SQLite transaction (e.g. atomically
 * with a verification-session consume). Runs the id resolution and the
 * contact + channel upserts as plain statements; the caller owns the
 * transaction boundary.
 */
export function applyGuardianBindingGatewayWrites(
  params: CreateGuardianBindingParams,
): GuardianBindingGatewayWrites {
  const now = Date.now();
  const displayName = params.displayName ?? params.externalUserId;
  const verifiedVia = params.verifiedVia ?? "challenge";

  // The gateway DB is the source of truth for contact ids; resolve them
  // directly from it.
  const gwReadDb = getGatewayDb();

  const existingGuardianContact = gwReadDb
    .select({ id: gwContacts.id })
    .from(gwContacts)
    .where(
      and(
        eq(gwContacts.role, "guardian"),
        eq(gwContacts.principalId, params.guardianPrincipalId),
      ),
    )
    .limit(1)
    .get();

  const claimableChannel = gwReadDb
    .select({
      id: gwContactChannels.id,
      contactId: gwContactChannels.contactId,
    })
    .from(gwContactChannels)
    .where(
      and(
        eq(gwContactChannels.type, params.channel),
        ne(gwContactChannels.status, "blocked"),
        sql`${gwContactChannels.address} = ${params.externalUserId} COLLATE NOCASE`,
      ),
    )
    .orderBy(
      sql`CASE WHEN ${gwContactChannels.contactId} = ${existingGuardianContact?.id ?? ""} THEN 0 ELSE 1 END`,
      sql`CASE ${gwContactChannels.status} WHEN 'active' THEN 0 WHEN 'unverified' THEN 1 ELSE 2 END`,
      desc(gwContactChannels.updatedAt),
    )
    .limit(1)
    .get();

  const contactId =
    existingGuardianContact?.id ?? claimableChannel?.contactId ?? uuid();

  const existingChannel =
    !claimableChannel && existingGuardianContact
      ? gwReadDb
          .select({ id: gwContactChannels.id })
          .from(gwContactChannels)
          .where(
            and(
              eq(gwContactChannels.contactId, contactId),
              eq(gwContactChannels.type, params.channel),
            ),
          )
          .limit(1)
          .get()
      : undefined;

  const channelId = claimableChannel?.id ?? existingChannel?.id ?? uuid();

  // --- Gateway DB write (authoritative) ---
  // The gateway owns the guardian ACL; a failure here means the binding failed,
  // so let it propagate (rolling back the caller's transaction).
  const gwDb = getGatewayDb();
  gwDb
    .insert(gwContacts)
    .values({
      id: contactId,
      displayName,
      role: "guardian",
      principalId: params.guardianPrincipalId,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: gwContacts.id,
      set: {
        displayName,
        role: "guardian",
        principalId: params.guardianPrincipalId,
        updatedAt: now,
      },
    })
    .run();

  const channelSet = {
    contactId,
    address: params.externalUserId,
    externalChatId: params.deliveryChatId,
    isPrimary: true,
    status: "active",
    policy: "allow",
    verifiedAt: now,
    verifiedVia,
    revokedReason: null,
    blockedReason: null,
    updatedAt: now,
  };

  // Heal a divergent (type,address) row (m0006): adopt it by its own id
  // rather than insert and throw on idx_contact_channels_type_address_unique.
  const existingGw = gwDb
    .select({
      id: gwContactChannels.id,
      status: gwContactChannels.status,
    })
    .from(gwContactChannels)
    .where(
      and(
        eq(gwContactChannels.type, params.channel),
        sql`${gwContactChannels.address} = ${params.externalUserId} COLLATE NOCASE`,
      ),
    )
    .get();

  if (existingGw) {
    // Never reactivate a blocked gateway row by code-match — leave it
    // intact (mirrors text-verification / contact-helpers guards).
    if (existingGw.status !== "blocked") {
      gwDb
        .update(gwContactChannels)
        .set(channelSet)
        .where(eq(gwContactChannels.id, existingGw.id))
        .run();
    }
  } else {
    gwDb
      .insert(gwContactChannels)
      .values({
        id: channelId,
        type: params.channel,
        interactionCount: 0,
        createdAt: now,
        ...channelSet,
      })
      .onConflictDoUpdate({
        target: gwContactChannels.id,
        set: channelSet,
      })
      .run();
  }

  // The guardian row just written supersedes any cached missing-guardian
  // state. Busting here covers every binding-commit path (createGuardianBinding
  // and the outbound phone rebind in verification/session-service.ts).
  bustGuardianIntegrityCache();

  return {
    contactId,
    channelId,
    channel: params.channel,
    address: params.externalUserId,
    deliveryChatId: params.deliveryChatId,
    displayName,
    guardianPrincipalId: params.guardianPrincipalId,
    claimedFromContactId:
      claimableChannel && claimableChannel.contactId !== contactId
        ? claimableChannel.contactId
        : null,
  };
}

/**
 * Post-commit assistant-side effects for a committed guardian binding:
 * identity mirror, orphaned-stub GC, daemon cache invalidation. All
 * best-effort — the gateway binding is already authoritative.
 */
export async function mirrorGuardianBinding(
  writes: GuardianBindingGatewayWrites,
): Promise<void> {
  const {
    contactId,
    channelId,
    channel,
    address,
    deliveryChatId,
    displayName,
  } = writes;

  // --- Assistant DB identity mirror (best-effort, via typed transactional IPC) ---
  // A non-authoritative convenience copy; its failure must not undo or abort
  // the committed gateway binding. One atomic daemon-side transaction upserts
  // the guardian contact + its primary channel under the gateway-minted ids,
  // reusing the same channel-id alignment the gateway wrote. The upsert
  // reparents a claimable channel that inbound seeding attached elsewhere and
  // refreshes the display name to match this binding.
  try {
    await ipcCallAssistant("contacts_mirror_apply", {
      body: {
        ops: [
          {
            op: "upsert_channel",
            contactId,
            channelId,
            type: channel,
            address,
            externalChatId: deliveryChatId,
            displayName,
            isPrimary: true,
            refreshDisplayName: true,
            reassignConflictingChannels: true,
          },
        ],
      },
    });
  } catch (mirrorErr) {
    log.warn(
      { err: mirrorErr },
      "Failed to mirror guardian binding identity to assistant DB",
    );
  }

  // The claim above can re-parent a channel that inbound seeding attached to
  // a stub contact (first message from a then-unbound guardian identity).
  // Garbage-collect that stub when the claim stripped its last channel, so
  // the guardian doesn't end up with a duplicate of themselves in the
  // Contacts pane (LUM-2672). Best-effort — never fails the binding.
  if (writes.claimedFromContactId) {
    await deleteContactIfOrphaned(writes.claimedFromContactId);
  }

  log.info(
    {
      contactId,
      channelId,
      channel,
      guardianPrincipalId: writes.guardianPrincipalId,
    },
    "Created guardian binding",
  );

  // Invalidate the daemon guardian-id/role caches after a gateway-owned
  // guardian rebind.
  void ipcCallAssistant("emit_event", {
    body: { kind: "contacts_changed" },
  } as unknown as Record<string, unknown>).catch(() => {});
}

/**
 * Create or update a guardian contact + channel binding.
 *
 * Writes the gateway DB (authoritative) first in its own transaction, then
 * mirrors identity to the assistant DB (best-effort, via IPC proxy). Uses
 * upsert semantics: looks up an existing contact by principalId, then claims
 * any preseeded channel for the same actor before falling back to an existing
 * guardian channel by (contactId, type).
 */
export async function createGuardianBinding(
  params: CreateGuardianBindingParams,
): Promise<CreateGuardianBindingResult> {
  const writes = getGatewayDb().transaction(() =>
    applyGuardianBindingGatewayWrites(params),
  );

  await mirrorGuardianBinding(writes);

  return {
    contactId: writes.contactId,
    channelId: writes.channelId,
    guardianPrincipalId: writes.guardianPrincipalId,
    channel: writes.channel,
  };
}

// ---------------------------------------------------------------------------
// Token operations (against the gateway's own DB — no cross-container issue)
// ---------------------------------------------------------------------------

export interface RefreshableTokenPair {
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken: string;
  refreshTokenExpiresAt: number;
  refreshAfter: number;
}

/**
 * A freshly minted, DB-recorded access + refresh token pair bound to a device.
 */
export type DeviceBoundTokenPair = RefreshableTokenPair;

/**
 * Revoke active actor tokens for a device binding.
 */
export function revokeActorTokensByDevice(
  guardianPrincipalId: string,
  hashedDeviceId: string,
): void {
  const now = Date.now();
  getGatewayDb()
    .update(actorTokenRecords)
    .set({ status: "revoked", updatedAt: now })
    .where(
      and(
        eq(actorTokenRecords.guardianPrincipalId, guardianPrincipalId),
        eq(actorTokenRecords.hashedDeviceId, hashedDeviceId),
        inArray(actorTokenRecords.status, ["active", "derived"]),
      ),
    )
    .run();
}

/**
 * Revoke active refresh tokens for a device binding.
 */
export function revokeRefreshTokensByDevice(
  guardianPrincipalId: string,
  hashedDeviceId: string,
): void {
  const now = Date.now();
  getGatewayDb()
    .update(actorRefreshTokenRecords)
    .set({ status: "revoked", updatedAt: now })
    .where(
      and(
        eq(actorRefreshTokenRecords.guardianPrincipalId, guardianPrincipalId),
        eq(actorRefreshTokenRecords.hashedDeviceId, hashedDeviceId),
        eq(actorRefreshTokenRecords.status, "active"),
      ),
    )
    .run();
}

/**
 * Mint a JWT access token and persist its hash in the gateway DB.
 */
function mintAccessToken(
  guardianPrincipalId: string,
  hashedDeviceId: string,
  platform: string,
  ttlSeconds: number = ACCESS_TOKEN_TTL_SECONDS,
): { token: string; expiresAt: number } {
  const externalAssistantId = getExternalAssistantId();
  const sub = `actor:${externalAssistantId}:${guardianPrincipalId}`;

  const token = mintToken({
    aud: "vellum-gateway",
    sub,
    scope_profile: "actor_client_v1",
    policy_epoch: CURRENT_POLICY_EPOCH,
    ttlSeconds,
  });

  const now = Date.now();
  const expiresAt = now + ttlSeconds * 1000;
  const tokenHash = hashToken(token);

  getGatewayDb()
    .insert(actorTokenRecords)
    .values({
      id: uuid(),
      tokenHash,
      guardianPrincipalId,
      hashedDeviceId,
      platform,
      status: "active",
      issuedAt: now,
      expiresAt,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  return { token, expiresAt };
}

/**
 * Mint an opaque refresh token and persist its hash in the gateway DB.
 */
function mintRefreshToken(
  guardianPrincipalId: string,
  hashedDeviceId: string,
  platform: string,
  options: { browserRefreshCookiePath?: string } = {},
): {
  refreshToken: string;
  refreshTokenExpiresAt: number;
  refreshAfter: number;
} {
  const now = Date.now();
  const refreshToken = randomBytes(32).toString("base64url");
  const refreshTokenHash = hashToken(refreshToken);
  const familyId = randomBytes(16).toString("hex");
  const absoluteExpiresAt = now + REFRESH_ABSOLUTE_TTL_MS;
  const inactivityExpiresAt = now + REFRESH_INACTIVITY_TTL_MS;

  getGatewayDb()
    .insert(actorRefreshTokenRecords)
    .values({
      id: uuid(),
      tokenHash: refreshTokenHash,
      familyId,
      guardianPrincipalId,
      hashedDeviceId,
      platform,
      status: "active",
      issuedAt: now,
      absoluteExpiresAt,
      inactivityExpiresAt,
      lastUsedAt: null,
      browserRefreshCookiePath: options.browserRefreshCookiePath,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  return {
    refreshToken,
    refreshTokenExpiresAt: Math.min(absoluteExpiresAt, inactivityExpiresAt),
    refreshAfter:
      now + Math.floor(ACCESS_TOKEN_TTL_MS * REFRESH_AFTER_FRACTION),
  };
}

/**
 * Revoke any existing credentials for a (guardian, device) pair and mint a
 * fresh, DB-recorded access + refresh token pair bound to that device.
 *
 * This is the shared core used by guardian bootstrap (and any other flow that
 * needs a full refreshable credential). The device binding enforces one active
 * token per (guardianPrincipalId, hashedDeviceId) via a unique index, so
 * re-minting for the same device first revokes the prior tokens.
 */
export function mintAndRecordDeviceBoundTokenPair(params: {
  guardianPrincipalId: string;
  deviceId: string;
  platform: string;
}): DeviceBoundTokenPair {
  const hashedDeviceId = hashToken(params.deviceId);

  revokeActorTokensByDevice(params.guardianPrincipalId, hashedDeviceId);
  revokeRefreshTokensByDevice(params.guardianPrincipalId, hashedDeviceId);

  const access = mintAccessToken(
    params.guardianPrincipalId,
    hashedDeviceId,
    params.platform,
  );
  const refresh = mintRefreshToken(
    params.guardianPrincipalId,
    hashedDeviceId,
    params.platform,
  );

  return {
    accessToken: access.token,
    accessTokenExpiresAt: access.expiresAt,
    refreshToken: refresh.refreshToken,
    refreshTokenExpiresAt: refresh.refreshTokenExpiresAt,
    refreshAfter: refresh.refreshAfter,
  };
}

/**
 * Mint a refreshable browser credential without requiring the browser to track a
 * separate device id. The current token tables still require a binding column,
 * so remote web uses an internal random binding that never leaves the gateway.
 */
export function mintAndRecordBrowserTokenPair(params: {
  guardianPrincipalId: string;
  platform: string;
  browserRefreshCookiePath: string;
}): RefreshableTokenPair {
  const internalBinding = randomBytes(32).toString("base64url");
  const hashedDeviceId = hashToken(internalBinding);

  const access = mintAccessToken(
    params.guardianPrincipalId,
    hashedDeviceId,
    params.platform,
  );
  const refresh = mintRefreshToken(
    params.guardianPrincipalId,
    hashedDeviceId,
    params.platform,
    { browserRefreshCookiePath: params.browserRefreshCookiePath },
  );

  return {
    accessToken: access.token,
    accessTokenExpiresAt: access.expiresAt,
    refreshToken: refresh.refreshToken,
    refreshTokenExpiresAt: refresh.refreshTokenExpiresAt,
    refreshAfter: refresh.refreshAfter,
  };
}

// ---------------------------------------------------------------------------
// Public: guardian bootstrap
// ---------------------------------------------------------------------------

/**
 * Attempt to fetch the assistant owner's display name from the platform.
 *
 * Only runs when IS_PLATFORM=true. Reads platform_base_url and
 * assistant_api_key from the credential store, then calls
 * GET /v1/internal/gateway/guardian/ with a 5-second timeout.
 * Returns null on any missing credential, timeout, or network/parse failure —
 * callers fall back to a generated principal ID in that case.
 */
async function fetchPlatformOwnerDisplayName(): Promise<string | null> {
  if (!arePlatformFeaturesEnabled()) {
    log.debug(
      "Platform features disabled — skipping platform owner display name fetch",
    );
    return null;
  }

  const isPlatform =
    process.env.IS_PLATFORM?.trim().toLowerCase() === "true" ||
    process.env.IS_PLATFORM?.trim() === "1";
  if (!isPlatform) return null;

  const [platformBaseUrl, assistantApiKey] = await Promise.all([
    readCredential(credentialKey("vellum", "platform_base_url")),
    readCredential(credentialKey("vellum", "assistant_api_key")),
  ]);

  if (!platformBaseUrl || !assistantApiKey) {
    return null;
  }

  try {
    const url = `${platformBaseUrl.replace(/\/+$/, "")}/v1/internal/gateway/guardian/`;
    const response = await fetch(url, {
      headers: { Authorization: `Api-Key ${assistantApiKey}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      log.warn(
        { status: response.status },
        "Failed to fetch platform owner display name",
      );
      return null;
    }
    const data = (await response.json()) as { display_name?: string | null };
    return data.display_name?.trim() || null;
  } catch (err) {
    log.warn({ err }, "Failed to fetch platform owner display name");
    return null;
  }
}

/**
 * Resolve the vellum guardian principal: (a) gateway fast path, then
 * (b) mint a fresh principal when the gateway has no guardian.
 *
 * Shared by ensureVellumGuardianBinding + bootstrapGuardian. `isNew` is true
 * only on the mint path.
 *
 * A gateway miss with evidence of a prior guardian (guardian-integrity.ts)
 * means the guardian rows were lost, not that this is a fresh install — a
 * mint there would permanently diverge from prior clients' tokens. Only the
 * explicit operator-driven guardian init may mint over evidence
 * (`allowMintWithEvidence`); implicit paths throw
 * {@link VellumGuardianMintRefusedError} instead.
 */
async function resolveOrCreateVellumGuardian(options: {
  allowMintWithEvidence: boolean;
}): Promise<{
  guardianPrincipalId: string;
  isNew: boolean;
  mintedOverPriorEvidence: boolean;
}> {
  const gw = await findVellumGuardian();
  if (gw) {
    log.debug(
      { guardianPrincipalId: gw.principalId },
      "Vellum guardian binding already exists",
    );
    return {
      guardianPrincipalId: gw.principalId,
      isNew: false,
      mintedOverPriorEvidence: false,
    };
  }

  const priorEvidence = hasEvidenceOfPriorGuardian();
  if (priorEvidence && !options.allowMintWithEvidence) {
    // Fires the missing-guardian reporter (error log + telemetry,
    // rate-limited there) when the DB is truly guardian-less.
    guardianIntegrityState();
    log.error(
      "no active vellum guardian binding but the gateway DB carries evidence of prior onboarding — refusing to mint a divergent principal; re-pair via guardian init to recover",
    );
    throw new VellumGuardianMintRefusedError();
  }
  if (priorEvidence) {
    log.warn(
      "minting a fresh vellum guardian principal over evidence of a prior guardian — prior clients' tokens will not match",
    );
  }

  // No gateway guardian — mint a fresh principal.
  const displayName = await fetchPlatformOwnerDisplayName();
  const guardianPrincipalId = `vellum-principal-${uuid()}`;
  await createGuardianBinding({
    channel: "vellum",
    externalUserId: guardianPrincipalId,
    deliveryChatId: "local",
    guardianPrincipalId,
    verifiedVia: "bootstrap",
    ...(displayName ? { displayName } : {}),
  });
  return {
    guardianPrincipalId,
    isNew: true,
    mintedOverPriorEvidence: priorEvidence,
  };
}

/**
 * Ensure a vellum guardian binding exists, returning its principalId.
 * Resolves from the gateway DB, minting a fresh principal on a miss — unless
 * the DB carries evidence of a prior guardian, in which case it throws
 * {@link VellumGuardianMintRefusedError}. Every caller must handle that
 * refusal explicitly: the startup backfill degrades boot non-fatally
 * (post-assistant-ready), and the /auth/token + remote-web pairing routes
 * map it to a 503 repair-required response.
 *
 * Called during gateway startup to backfill existing installations.
 */
export async function ensureVellumGuardianBinding(): Promise<string> {
  const { guardianPrincipalId } = await resolveOrCreateVellumGuardian({
    allowMintWithEvidence: false,
  });
  return guardianPrincipalId;
}

/**
 * Execute the full guardian bootstrap flow:
 *   1. Ensure a guardian principal exists for the vellum channel
 *   2. Revoke existing credentials for this device
 *   3. Mint new JWT access token + opaque refresh token
 *   4. Persist token hashes
 */
export async function bootstrapGuardian(params: {
  platform: string;
  deviceId: string;
}): Promise<GuardianBootstrapResult> {
  // 1. Resolve (or mint) the guardian principal. Guardian init is the
  //    sanctioned operator-driven recovery path, so it may mint over evidence
  //    of a prior guardian (loud warn inside).
  const { guardianPrincipalId, isNew, mintedOverPriorEvidence } =
    await resolveOrCreateVellumGuardian({ allowMintWithEvidence: true });

  // 2. Revoke existing credentials for this device and mint a fresh pair.
  const pair = mintAndRecordDeviceBoundTokenPair({
    guardianPrincipalId,
    deviceId: params.deviceId,
    platform: params.platform,
  });

  log.info(
    {
      platform: params.platform,
      guardianPrincipalId,
      isNew,
      mintedOverPriorEvidence,
    },
    "Guardian bootstrap completed",
  );

  return {
    guardianPrincipalId,
    accessToken: pair.accessToken,
    accessTokenExpiresAt: pair.accessTokenExpiresAt,
    refreshToken: pair.refreshToken,
    refreshTokenExpiresAt: pair.refreshTokenExpiresAt,
    refreshAfter: pair.refreshAfter,
    isNew,
    mintedOverPriorEvidence,
  };
}
