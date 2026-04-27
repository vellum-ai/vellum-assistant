/**
 * Gateway-native guardian bootstrap — mints credentials using the
 * gateway's own SQLite database for token persistence and the
 * assistant's database for contact lookups (contacts migration is
 * separate). Uses the gateway's own signing key for JWT minting.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { Database } from "bun:sqlite";
import { and, eq } from "drizzle-orm";

import { getGatewayDb } from "../db/connection.js";
import {
  actorRefreshTokenRecords,
  actorTokenRecords,
  contacts as gwContacts,
  contactChannels as gwContactChannels,
} from "../db/schema.js";
import { getLogger } from "../logger.js";
import { getWorkspaceDir } from "../paths.js";

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
// Assistant DB access (lazy singleton)
// ---------------------------------------------------------------------------

let assistantDb: Database | null = null;

function getAssistantDbPath(): string {
  return join(getWorkspaceDir(), "data", "db", "assistant.db");
}

/**
 * Open a connection to the assistant's SQLite database.
 *
 * Short-term workaround: the gateway accesses the assistant's DB directly
 * rather than owning its own contacts/token tables. This avoids a risky
 * data migration (copying contacts + tokens from assistant → gateway while
 * both processes are running). Once the migration is complete, this will
 * be replaced with a gateway-owned database.
 */
export function getAssistantDb(): Database {
  if (assistantDb) return assistantDb;

  const dbPath = getAssistantDbPath();
  if (!existsSync(dbPath)) {
    throw new Error(
      `Assistant database not found at ${dbPath} — the assistant may not have started yet`,
    );
  }

  assistantDb = new Database(dbPath);
  assistantDb.exec("PRAGMA journal_mode=WAL");
  assistantDb.exec("PRAGMA busy_timeout=5000");
  assistantDb.exec("PRAGMA foreign_keys=ON");

  log.info({ dbPath }, "Opened assistant database for guardian bootstrap");
  return assistantDb;
}

/** Close the assistant DB connection. Exported for tests. */
export function closeAssistantDb(): void {
  if (assistantDb) {
    try {
      assistantDb.close();
    } catch {
      // best effort
    }
    assistantDb = null;
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
// Contact operations (against the assistant's DB)
// ---------------------------------------------------------------------------

interface GuardianLookupRow {
  contact_id: string;
  principal_id: string | null;
}

/**
 * Find the existing guardian contact for the "vellum" channel.
 * Mirrors assistant's `findGuardianForChannel("vellum")`.
 */
function findVellumGuardian(db: Database): { principalId: string } | null {
  const row = db
    .query<GuardianLookupRow, []>(
      `SELECT c.id AS contact_id, c.principal_id
       FROM contacts c
       INNER JOIN contact_channels cc ON cc.contact_id = c.id
       WHERE c.role = 'guardian'
         AND cc.type = 'vellum'
         AND cc.status = 'active'
       ORDER BY cc.verified_at DESC
       LIMIT 1`,
    )
    .get();

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
export function findGuardianForChannelActor(
  channelType: string,
  externalUserId: string,
): { principalId: string } | null {
  if (!channelType || !externalUserId) return null;

  const db = getAssistantDb();
  const row = db
    .query<GuardianLookupRow, [string, string]>(
      `SELECT c.id AS contact_id, c.principal_id
       FROM contacts c
       INNER JOIN contact_channels cc ON cc.contact_id = c.id
       WHERE c.role = 'guardian'
         AND cc.type = ?
         AND cc.external_user_id = ?
         AND cc.status = 'active'
       LIMIT 1`,
    )
    .get(channelType, externalUserId);

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
 * Writes to both the assistant DB (primary) and gateway DB (secondary).
 * Uses upsert semantics: looks up an existing contact by principalId
 * and an existing channel by (contactId, type), updating if found.
 *
 * Persona-file seeding and trust-rule cache invalidation are
 * assistant-side concerns — the assistant handles them independently.
 */
export function createGuardianBinding(
  params: CreateGuardianBindingParams,
): CreateGuardianBindingResult {
  const db = getAssistantDb();
  const now = Date.now();
  const displayName = params.displayName ?? params.externalUserId;
  const verifiedVia = params.verifiedVia ?? "challenge";

  const existingContact = db
    .query<{ id: string }, [string]>(
      `SELECT id FROM contacts WHERE role = 'guardian' AND principal_id = ? LIMIT 1`,
    )
    .get(params.guardianPrincipalId);

  const contactId = existingContact?.id ?? uuid();

  const existingChannel = existingContact
    ? db
        .query<{ id: string }, [string, string]>(
          `SELECT id FROM contact_channels WHERE contact_id = ? AND type = ? LIMIT 1`,
        )
        .get(contactId, params.channel)
    : null;

  const channelId = existingChannel?.id ?? uuid();

  // --- Assistant DB write (primary) ---
  db.exec("BEGIN IMMEDIATE");
  try {
    if (existingContact) {
      db.run(
        `UPDATE contacts SET display_name = ?, updated_at = ? WHERE id = ?`,
        [displayName, now, contactId],
      );
    } else {
      db.run(
        `INSERT INTO contacts (id, display_name, role, principal_id, notes, created_at, updated_at)
         VALUES (?, ?, 'guardian', ?, 'guardian', ?, ?)`,
        [contactId, displayName, params.guardianPrincipalId, now, now],
      );
    }

    if (existingChannel) {
      db.run(
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
      db.run(
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

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
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

/**
 * Thin wrapper for the vellum bootstrap path — creates a vellum channel
 * guardian binding with bootstrap-specific defaults.
 */
function createVellumGuardianBinding(
  _db: Database,
  guardianPrincipalId: string,
): void {
  createGuardianBinding({
    channel: "vellum",
    externalUserId: guardianPrincipalId,
    deliveryChatId: "local",
    guardianPrincipalId,
    verifiedVia: "bootstrap",
  });
}

// ---------------------------------------------------------------------------
// Token operations (against the assistant's DB)
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
 * Ensure a vellum guardian binding exists. If one already exists, returns
 * its principalId. Otherwise creates a new binding with a fresh principal
 * and dual-writes to both the assistant and gateway DBs.
 *
 * Called during gateway startup to backfill existing installations.
 */
export function ensureVellumGuardianBinding(): string {
  const db = getAssistantDb();
  const existing = findVellumGuardian(db);
  if (existing) {
    log.debug(
      { guardianPrincipalId: existing.principalId },
      "Vellum guardian binding already exists",
    );
    return existing.principalId;
  }

  const guardianPrincipalId = `vellum-principal-${uuid()}`;
  createVellumGuardianBinding(db, guardianPrincipalId);
  return guardianPrincipalId;
}

/**
 * Execute the full guardian bootstrap flow:
 *   1. Ensure a guardian principal exists for the vellum channel
 *   2. Revoke existing credentials for this device
 *   3. Mint new JWT access token + opaque refresh token
 *   4. Persist token hashes
 */
export function bootstrapGuardian(params: {
  platform: string;
  deviceId: string;
}): GuardianBootstrapResult {
  const db = getAssistantDb();
  const hashedDeviceId = createHash("sha256")
    .update(params.deviceId)
    .digest("hex");

  // 1. Ensure guardian principal
  let isNew = false;
  let guardianPrincipalId: string;

  const existing = findVellumGuardian(db);
  if (existing) {
    guardianPrincipalId = existing.principalId;
  } else {
    guardianPrincipalId = `vellum-principal-${uuid()}`;
    createVellumGuardianBinding(db, guardianPrincipalId);
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
