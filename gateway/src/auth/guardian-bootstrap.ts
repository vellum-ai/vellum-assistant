/**
 * Gateway-native guardian bootstrap — mints credentials by operating
 * directly on the assistant's SQLite database (shared workspace volume)
 * for contacts and token persistence. Uses the gateway's own signing
 * key for JWT minting.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { Database } from "bun:sqlite";

import { getGatewayDb } from "../db/connection.js";
import {
  contacts as gwContacts,
  contactChannels as gwContactChannels,
} from "../db/schema.js";
import { getLogger } from "../logger.js";
import { getWorkspaceDir } from "../paths.js";

import { CURRENT_POLICY_EPOCH } from "./policy.js";
import { mintToken } from "./token-service.js";

const log = getLogger("guardian-bootstrap");

// ---------------------------------------------------------------------------
// Constants (mirrored from assistant/src/runtime/auth/credential-service.ts)
// ---------------------------------------------------------------------------

/** Access token TTL: 30 days in seconds. */
const ACCESS_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Access token TTL in ms. */
const ACCESS_TOKEN_TTL_MS = ACCESS_TOKEN_TTL_SECONDS * 1000;

/** Refresh token absolute expiry: 365 days. */
const REFRESH_ABSOLUTE_TTL_MS = 365 * 24 * 60 * 60 * 1000;

/** Refresh token inactivity expiry: 90 days. */
const REFRESH_INACTIVITY_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** Suggest refresh at 80% of access token TTL. */
const REFRESH_AFTER_FRACTION = 0.8;

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
function getAssistantDb(): Database {
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

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function uuid(): string {
  return crypto.randomUUID();
}

function getExternalAssistantId(): string {
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
 * Create a guardian contact + vellum channel binding.
 *
 * Persona-file seeding (`users/<slug>.md`) and trust-rule cache
 * invalidation are handled by the assistant on startup when it detects
 * a guardian contact without a persona file. The gateway doesn't need
 * to duplicate that logic.
 */
function createVellumGuardianBinding(
  db: Database,
  guardianPrincipalId: string,
): void {
  const now = Date.now();
  const contactId = uuid();
  const channelId = uuid();

  // --- Assistant DB write (primary) ---
  db.exec("BEGIN IMMEDIATE");
  try {
    db.run(
      `INSERT INTO contacts (id, display_name, role, principal_id, notes, created_at, updated_at)
       VALUES (?, ?, 'guardian', ?, 'guardian', ?, ?)`,
      [contactId, guardianPrincipalId, guardianPrincipalId, now, now],
    );

    db.run(
      `INSERT INTO contact_channels
         (id, contact_id, type, address, external_user_id, external_chat_id,
          is_primary, status, policy, verified_at, verified_via, interaction_count, created_at)
       VALUES (?, ?, 'vellum', ?, ?, 'local', 1, 'active', 'allow', ?, 'bootstrap', 0, ?)`,
      [
        channelId,
        contactId,
        guardianPrincipalId,
        guardianPrincipalId,
        now,
        now,
      ],
    );

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  // --- Gateway DB dual-write (best-effort) ---
  try {
    const gwDb = getGatewayDb();
    gwDb
      .insert(gwContacts)
      .values({
        id: contactId,
        displayName: guardianPrincipalId,
        role: "guardian",
        principalId: guardianPrincipalId,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .run();

    gwDb
      .insert(gwContactChannels)
      .values({
        id: channelId,
        contactId,
        type: "vellum",
        address: guardianPrincipalId,
        externalUserId: guardianPrincipalId,
        externalChatId: "local",
        isPrimary: true,
        status: "active",
        policy: "allow",
        verifiedAt: now,
        verifiedVia: "bootstrap",
        interactionCount: 0,
        createdAt: now,
      })
      .onConflictDoNothing()
      .run();
  } catch (gwErr) {
    log.warn(
      { err: gwErr },
      "Failed to dual-write guardian binding to gateway DB",
    );
  }

  log.info(
    { contactId, guardianPrincipalId },
    "Created vellum guardian binding",
  );
}

// ---------------------------------------------------------------------------
// Token operations (against the assistant's DB)
// ---------------------------------------------------------------------------

/**
 * Revoke active actor tokens for a device binding.
 */
function revokeActorTokensByDevice(
  db: Database,
  guardianPrincipalId: string,
  hashedDeviceId: string,
): void {
  db.run(
    `UPDATE actor_token_records
     SET status = 'revoked', updated_at = ?
     WHERE guardian_principal_id = ?
       AND hashed_device_id = ?
       AND status = 'active'`,
    [Date.now(), guardianPrincipalId, hashedDeviceId],
  );
}

/**
 * Revoke active refresh tokens for a device binding.
 */
function revokeRefreshTokensByDevice(
  db: Database,
  guardianPrincipalId: string,
  hashedDeviceId: string,
): void {
  db.run(
    `UPDATE actor_refresh_token_records
     SET status = 'revoked', updated_at = ?
     WHERE guardian_principal_id = ?
       AND hashed_device_id = ?
       AND status = 'active'`,
    [Date.now(), guardianPrincipalId, hashedDeviceId],
  );
}

/**
 * Mint a JWT access token and persist its hash in the assistant DB.
 */
function mintAccessToken(
  db: Database,
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

  db.run(
    `INSERT INTO actor_token_records
       (id, token_hash, guardian_principal_id, hashed_device_id, platform,
        status, issued_at, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
    [
      uuid(),
      tokenHash,
      guardianPrincipalId,
      hashedDeviceId,
      platform,
      now,
      expiresAt,
      now,
      now,
    ],
  );

  return { token, expiresAt };
}

/**
 * Mint an opaque refresh token and persist its hash in the assistant DB.
 */
function mintRefreshToken(
  db: Database,
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

  db.run(
    `INSERT INTO actor_refresh_token_records
       (id, token_hash, family_id, guardian_principal_id, hashed_device_id,
        platform, status, issued_at, absolute_expires_at, inactivity_expires_at,
        last_used_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, NULL, ?, ?)`,
    [
      uuid(),
      refreshTokenHash,
      familyId,
      guardianPrincipalId,
      hashedDeviceId,
      platform,
      now,
      absoluteExpiresAt,
      inactivityExpiresAt,
      now,
      now,
    ],
  );

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
 * Execute the full guardian bootstrap flow:
 *   1. Ensure a guardian principal exists for the vellum channel
 *   2. Revoke existing credentials for this device
 *   3. Mint new JWT access token + opaque refresh token
 *   4. Persist token hashes
 *
 * All operations run against the assistant's SQLite database.
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
  revokeActorTokensByDevice(db, guardianPrincipalId, hashedDeviceId);
  revokeRefreshTokensByDevice(db, guardianPrincipalId, hashedDeviceId);

  // 3. Mint new credentials
  const access = mintAccessToken(
    db,
    guardianPrincipalId,
    hashedDeviceId,
    params.platform,
  );
  const refresh = mintRefreshToken(
    db,
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
