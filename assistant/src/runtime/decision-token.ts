/**
 * Lightweight informational decision token for interactive UI outcomes.
 *
 * Minted when a confirmation-style surface is `submitted`. The token is
 * **non-authoritative** — it carries metadata about the decision for
 * audit and correlation purposes only. It does not grant any capability
 * and must not be used for enforcement or replay protection (that is
 * explicitly out of scope for v1).
 *
 * Format: base64url-encoded JSON payload + `.` + random nonce.
 * The nonce makes tokens unique even for identical payloads; the
 * payload is readable by any consumer without a secret.
 *
 * This module is intentionally decoupled from the existing auth/token
 * infrastructure in `runtime/auth/` — it serves a different purpose
 * and should remain independent.
 */

import { randomBytes } from "node:crypto";

// ── Token shape ──────────────────────────────────────────────────────

export interface DecisionTokenPayload {
  /** Conversation the decision belongs to. */
  conversationId: string;
  /** Surface identifier that was displayed. */
  surfaceId: string;
  /** The action ID the user selected (e.g. "confirm"). Only present on affirmative confirmation. */
  action: string;
  /** ISO-8601 timestamp when the decision was recorded. */
  issuedAt: string;
  /** ISO-8601 timestamp after which the token should be considered stale. */
  expiresAt: string;
}

/** Default token lifetime: 5 minutes. */
const DEFAULT_TTL_MS = 5 * 60 * 1000;

// ── Minting ──────────────────────────────────────────────────────────

/**
 * Mint an informational decision token.
 *
 * The returned string is `<base64url-payload>.<random-nonce>`. It is
 * short-lived (default 5 minutes) and non-authoritative.
 *
 * @param opts - Decision metadata.
 * @param opts.conversationId - Conversation scope.
 * @param opts.surfaceId - Surface that was displayed.
 * @param opts.action - Terminal action taken by the user.
 * @param opts.ttlMs - Token lifetime in milliseconds (default 5 min).
 * @returns The minted token string.
 */
export function mintDecisionToken(opts: {
  conversationId: string;
  surfaceId: string;
  action: string;
  ttlMs?: number;
}): string {
  const now = new Date();
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const expiresAt = new Date(now.getTime() + ttl);

  const payload: DecisionTokenPayload = {
    conversationId: opts.conversationId,
    surfaceId: opts.surfaceId,
    action: opts.action,
    issuedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };

  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const nonce = randomBytes(12).toString("hex");

  return `${encoded}.${nonce}`;
}

// ── Decoding (informational only) ────────────────────────────────────

/**
 * Decode a decision token's payload.
 *
 * This is a pure decoding step — there is no signature verification
 * because the token is non-authoritative. Consumers should treat the
 * payload as informational metadata, not a trust assertion.
 *
 * @param token - The token string produced by {@link mintDecisionToken}.
 * @returns The decoded payload, or `null` if the token is malformed.
 */
export function decodeDecisionToken(
  token: string,
): DecisionTokenPayload | null {
  const dotIdx = token.indexOf(".");
  if (dotIdx < 0) return null;

  const encodedPayload = token.slice(0, dotIdx);
  try {
    const json = Buffer.from(encodedPayload, "base64url").toString("utf-8");
    const parsed = JSON.parse(json) as Record<string, unknown>;

    // Minimal structural validation
    if (
      typeof parsed.conversationId !== "string" ||
      typeof parsed.surfaceId !== "string" ||
      typeof parsed.action !== "string" ||
      typeof parsed.issuedAt !== "string" ||
      typeof parsed.expiresAt !== "string"
    ) {
      return null;
    }

    return parsed as unknown as DecisionTokenPayload;
  } catch {
    return null;
  }
}
