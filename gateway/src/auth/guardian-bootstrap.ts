/**
 * Gateway-native guardian bootstrap — mints credentials using the
 * gateway's own SQLite database for token persistence and the
 * assistant's database (via IPC proxy) for contact lookups and writes.
 *
 * Uses the gateway's own signing key for JWT minting.
 */

import { createHash, randomBytes } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { getGatewayDb } from "../db/connection.js";
import {
  assistantDbQuery,
  assistantDbRun,
  assistantDbExec,
} from "../db/assistant-db-proxy.js";
import {
  actorRefreshTokenRecords,
  actorTokenRecords,
  contacts as gwContacts,
  contactChannels as gwContactChannels,
} from "../db/schema.js";
import { readCredential } from "../credential-reader.js";
import { credentialKey } from "../credential-key.js";
import { getLogger } from "../logger.js";

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

interface GuardianLookupRow {
  contact_id: string;
  principal_id: string | null;
}

/**
 * Find the existing guardian contact for the "vellum" channel.
 * Mirrors assistant's `findGuardianForChannel("vellum")`.
 */
async function findVellumGuardian(): Promise<{ principalId: string } | null> {
  const rows = await assistantDbQuery<GuardianLookupRow>(
    `SELECT c.id AS contact_id, c.principal_id
     FROM contacts c
     INNER JOIN contact_channels cc ON cc.contact_id = c.id
     WHERE c.role = 'guardian'
       AND cc.type = 'vellum'
       AND cc.status = 'active'
     ORDER BY cc.verified_at DESC
     LIMIT 1`,
  );

  const row = rows[0];
  if (!row?.principal_id) return null;
  return { principalId: row.principal_id };
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

  const rows = await assistantDbQuery<GuardianLookupRow>(
    `SELECT c.id AS contact_id, c.principal_id
     FROM contacts c
     INNER JOIN contact_channels cc ON cc.contact_id = c.id
     WHERE c.role = 'guardian'
       AND cc.type = ?
       AND cc.external_user_id = ?
       AND cc.status = 'active'
     LIMIT 1`,
    [channelType, externalUserId],
  );

  const row = rows[0];
  if (!row?.principal_id) return null;
  return { principalId: row.principal_id };
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

/**
 * Create or update a guardian contact + channel binding.
 *
 * Writes to both the assistant DB (via IPC proxy, primary) and gateway DB
 * (secondary). Uses upsert semantics: looks up an existing contact by
 * principalId and an existing channel by (contactId, type), updating if found.
 */
export async function createGuardianBinding(
  params: CreateGuardianBindingParams,
): Promise<CreateGuardianBindingResult> {
  const now = Date.now();
  const displayName = params.displayName ?? params.externalUserId;
  const verifiedVia = params.verifiedVia ?? "challenge";

  let contactId: string;
  let channelId: string;

  // --- Assistant DB write (primary, via IPC proxy) ---
  await assistantDbExec("BEGIN IMMEDIATE");
  try {
    const existingContacts = await assistantDbQuery<{ id: string }>(
      `SELECT id FROM contacts WHERE role = 'guardian' AND principal_id = ? LIMIT 1`,
      [params.guardianPrincipalId],
    );

    contactId = existingContacts[0]?.id ?? uuid();

    let existingChannels: { id: string }[] = [];
    if (existingContacts[0]) {
      existingChannels = await assistantDbQuery<{ id: string }>(
        `SELECT id FROM contact_channels WHERE contact_id = ? AND type = ? LIMIT 1`,
        [contactId, params.channel],
      );
    }

    channelId = existingChannels[0]?.id ?? uuid();

    if (existingContacts[0]) {
      await assistantDbRun(
        `UPDATE contacts SET display_name = ?, updated_at = ? WHERE id = ?`,
        [displayName, now, contactId],
      );
    } else {
      await assistantDbRun(
        `INSERT INTO contacts (id, display_name, role, principal_id, notes, created_at, updated_at)
         VALUES (?, ?, 'guardian', ?, 'guardian', ?, ?)`,
        [contactId, displayName, params.guardianPrincipalId, now, now],
      );
    }

    if (existingChannels[0]) {
      await assistantDbRun(
        `UPDATE contact_channels
         SET address = ?, external_user_id = ?, external_chat_id = ?,
             status = 'active', policy = 'allow', verified_at = ?,
             verified_via = ?, updated_at = ?
         WHERE id = ?`,
        [
          params.externalUserId,
          params.externalUserId,
          params.deliveryChatId,
          now,
          verifiedVia,
          now,
          channelId,
        ],
      );
    } else {
      await assistantDbRun(
        `INSERT INTO contact_channels
           (id, contact_id, type, address, external_user_id, external_chat_id,
            is_primary, status, policy, verified_at, verified_via, interaction_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, 'active', 'allow', ?, ?, 0, ?)`,
        [
          channelId,
          contactId,
          params.channel,
          params.externalUserId,
          params.externalUserId,
          params.deliveryChatId,
          now,
          verifiedVia,
          now,
        ],
      );
    }

    await assistantDbExec("COMMIT");
  } catch (err) {
    try {
      await assistantDbExec("ROLLBACK");
    } catch {
      // best effort
    }
    throw err;
  }

  // --- Gateway DB dual-write (best-effort, transactional) ---
  try {
    const gwDb = getGatewayDb();
    gwDb.transaction((tx) => {
      tx.insert(gwContacts)
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
          set: { displayName, updatedAt: now },
        })
        .run();

      tx.insert(gwContactChannels)
        .values({
          id: channelId,
          contactId,
          type: params.channel,
          address: params.externalUserId,
          externalUserId: params.externalUserId,
          externalChatId: params.deliveryChatId,
          isPrimary: true,
          status: "active",
          policy: "allow",
          verifiedAt: now,
          verifiedVia,
          interactionCount: 0,
          createdAt: now,
        })
        .onConflictDoUpdate({
          target: gwContactChannels.id,
          set: {
            address: params.externalUserId,
            externalUserId: params.externalUserId,
            externalChatId: params.deliveryChatId,
            status: "active",
            policy: "allow",
            verifiedAt: now,
            verifiedVia,
          },
        })
        .run();
    });
  } catch (gwErr) {
    log.warn(
      { err: gwErr },
      "Failed to dual-write guardian binding to gateway DB",
    );
  }

  log.info(
    {
      contactId,
      channelId,
      channel: params.channel,
      guardianPrincipalId: params.guardianPrincipalId,
    },
    "Created guardian binding",
  );

  return {
    contactId,
    channelId,
    guardianPrincipalId: params.guardianPrincipalId,
    channel: params.channel,
  };
}

// ---------------------------------------------------------------------------
// Token operations (against the gateway's own DB — no cross-container issue)
// ---------------------------------------------------------------------------

/**
 * Revoke active actor tokens for a device binding.
 */
function revokeActorTokensByDevice(
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
        eq(actorTokenRecords.status, "active"),
      ),
    )
    .run();
}

/**
 * Revoke active refresh tokens for a device binding.
 */
function revokeRefreshTokensByDevice(
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
): { token: string; expiresAt: number } {
  const externalAssistantId = getExternalAssistantId();
  const sub = `actor:${externalAssistantId}:${guardianPrincipalId}`;

  const token = mintToken({
    aud: "vellum-gateway",
    sub,
    scope_profile: "actor_client_v1",
    policy_epoch: CURRENT_POLICY_EPOCH,
    ttlSeconds: ACCESS_TOKEN_TTL_SECONDS,
  });

  const now = Date.now();
  const expiresAt = now + ACCESS_TOKEN_TTL_MS;
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
 * Ensure a vellum guardian binding exists. If one already exists, returns
 * its principalId. Otherwise creates a new binding with a fresh principal
 * and dual-writes to both the assistant and gateway DBs.
 *
 * Called during gateway startup to backfill existing installations.
 */
export async function ensureVellumGuardianBinding(): Promise<string> {
  const existing = await findVellumGuardian();
  if (existing) {
    log.debug(
      { guardianPrincipalId: existing.principalId },
      "Vellum guardian binding already exists",
    );
    return existing.principalId;
  }

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
  const hashedDeviceId = createHash("sha256")
    .update(params.deviceId)
    .digest("hex");

  // 1. Ensure guardian principal
  let isNew = false;
  let guardianPrincipalId: string;

  const existing = await findVellumGuardian();
  if (existing) {
    guardianPrincipalId = existing.principalId;
  } else {
    guardianPrincipalId = `vellum-principal-${uuid()}`;
    await createGuardianBinding({
      channel: "vellum",
      externalUserId: guardianPrincipalId,
      deliveryChatId: "local",
      guardianPrincipalId,
      verifiedVia: "bootstrap",
    });
    isNew = true;
  }

  // 2. Revoke existing credentials for this device
  revokeActorTokensByDevice(guardianPrincipalId, hashedDeviceId);
  revokeRefreshTokensByDevice(guardianPrincipalId, hashedDeviceId);

  // 3. Mint new credentials
  const access = mintAccessToken(
    guardianPrincipalId,
    hashedDeviceId,
    params.platform,
  );
  const refresh = mintRefreshToken(
    guardianPrincipalId,
    hashedDeviceId,
    params.platform,
  );

  log.info(
    { platform: params.platform, guardianPrincipalId, isNew },
    "Guardian bootstrap completed",
  );

  return {
    guardianPrincipalId,
    accessToken: access.token,
    accessTokenExpiresAt: access.expiresAt,
    refreshToken: refresh.refreshToken,
    refreshTokenExpiresAt: refresh.refreshTokenExpiresAt,
    refreshAfter: refresh.refreshAfter,
    isNew,
  };
}
