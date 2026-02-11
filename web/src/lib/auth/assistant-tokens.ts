/**
 * Assistant auth token helpers.
 *
 * Tokens are SHA-256 hashed at rest.  The first 8 characters of the
 * plaintext token are stored as `token_prefix` for quick lookups so we
 * only need to hash-compare against a small candidate set.
 */

import crypto from "node:crypto";

import { getDb } from "@/lib/db";

// ---------------------------------------------------------------------------
// Token generation + hashing
// ---------------------------------------------------------------------------

const TOKEN_BYTE_LENGTH = 32;
const PREFIX_LENGTH = 8;

export function generateToken(): string {
  return crypto.randomBytes(TOKEN_BYTE_LENGTH).toString("hex");
}

export function hashToken(plaintext: string): string {
  return crypto.createHash("sha256").update(plaintext).digest("hex");
}

export function tokenPrefix(plaintext: string): string {
  return plaintext.slice(0, PREFIX_LENGTH);
}

// ---------------------------------------------------------------------------
// Database operations
// ---------------------------------------------------------------------------

export interface AssistantAuthToken {
  id: string;
  assistantId: string;
  tokenPrefix: string;
  tokenHash: string;
  scopes: unknown;
  revokedAt: Date | null;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date | null;
}

interface TokenRow {
  id: string;
  assistant_id: string;
  token_prefix: string;
  token_hash: string;
  scopes: unknown;
  revoked_at: Date | null;
  expires_at: Date | null;
  last_used_at: Date | null;
  created_at: Date | null;
}

function toToken(row: TokenRow): AssistantAuthToken {
  return {
    id: row.id,
    assistantId: row.assistant_id,
    tokenPrefix: row.token_prefix,
    tokenHash: row.token_hash,
    scopes: row.scopes,
    revokedAt: row.revoked_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
  };
}

/**
 * Create a new assistant auth token.
 * Returns the plaintext token (shown to the user once) and the stored record.
 */
export async function createAssistantToken(
  assistantId: string,
  scopes: string[] = [],
): Promise<{ plaintext: string; token: AssistantAuthToken }> {
  const sql = getDb();
  const plaintext = generateToken();
  const hash = hashToken(plaintext);
  const prefix = tokenPrefix(plaintext);

  const rows = await sql.unsafe<TokenRow[]>(
    `
      INSERT INTO assistant_auth_tokens (assistant_id, token_prefix, token_hash, scopes)
      VALUES ($1, $2, $3, $4::jsonb)
      RETURNING *
    `,
    [assistantId, prefix, hash, JSON.stringify(scopes)],
  );

  return { plaintext, token: toToken(rows[0]) };
}

/**
 * Verify a plaintext token against stored records.
 * Returns the matching token record if valid, or `null` if the token is
 * invalid, revoked, or expired.
 */
export async function verifyAssistantToken(
  assistantId: string,
  plaintext: string,
): Promise<AssistantAuthToken | null> {
  const sql = getDb();
  const prefix = tokenPrefix(plaintext);
  const hash = hashToken(plaintext);

  const rows = await sql.unsafe<TokenRow[]>(
    `
      SELECT *
      FROM assistant_auth_tokens
      WHERE assistant_id = $1
        AND token_prefix = $2
        AND token_hash = $3
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > NOW())
    `,
    [assistantId, prefix, hash],
  );

  if (rows.length === 0) {
    return null;
  }

  const token = toToken(rows[0]);

  // Update last_used_at without blocking the response
  sql.unsafe(
    `UPDATE assistant_auth_tokens SET last_used_at = NOW() WHERE id = $1`,
    [token.id],
  ).catch(() => {});

  return token;
}

/**
 * Revoke a token by ID.
 */
export async function revokeAssistantToken(tokenId: string): Promise<void> {
  const sql = getDb();
  await sql.unsafe(
    `UPDATE assistant_auth_tokens SET revoked_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [tokenId],
  );
}

/**
 * Revoke all tokens for an assistant.
 */
export async function revokeAllAssistantTokens(assistantId: string): Promise<number> {
  const sql = getDb();
  const result = await sql.unsafe(
    `
      UPDATE assistant_auth_tokens
      SET revoked_at = NOW(), updated_at = NOW()
      WHERE assistant_id = $1 AND revoked_at IS NULL
    `,
    [assistantId],
  );
  return result.count;
}
