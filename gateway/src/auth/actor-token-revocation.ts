/**
 * Hot-path actor-token revocation check.
 *
 * Edge-token validation ({@link validateEdgeToken}) only verifies the JWT
 * (signature, audience, expiry, policy epoch) — it never consults the DB. That
 * means marking an actor token "revoked" in `actorTokenRecords` (on re-pair,
 * device unpair, etc.) has no effect on live requests until the token expires.
 *
 * This check closes that gap: on the request hot path, after the JWT is
 * validated, reject an actor token whose recorded row is `status = 'revoked'`.
 *
 * Policy is **fail-OPEN**:
 *   - Non-actor tokens (svc/local) are never checked.
 *   - An actor token with NO record is allowed — legacy/unrecorded tokens (and
 *     any mint path not yet recording to the DB) must never be broken.
 *   - Any DB error (incl. the gateway DB not being initialized) allows the
 *     request and logs a warning — a revocation check must never take down auth
 *     on a DB hiccup; we are no worse off than before this check existed.
 *
 * Only an explicit `status = 'revoked'` row results in rejection.
 */
import { createHash } from "node:crypto";

import { eq } from "drizzle-orm";

import { getGatewayDb } from "../db/connection.js";
import { actorTokenRecords } from "../db/schema.js";
import { getLogger } from "../logger.js";
import type { TokenClaims } from "./types.js";
import { parseSub } from "./subject.js";

const log = getLogger("actor-token-revocation");

/**
 * SHA-256 hex digest, matching how tokens are hashed at mint time. Inlined
 * (rather than imported from guardian-bootstrap, which several test suites
 * mock.module) so this hot-path check has no dependency on that module.
 */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Canonicalize a token's base64url encoding so the revocation hash reproduces
 * the canonical minted string that was stored.
 *
 * Tokens are stored/revoked under the hash of their CANONICAL minted string
 * (mintToken encodes every segment with Buffer#toString("base64url") — no
 * padding, canonical alphabet). But validateEdgeToken verifies the signature by
 * decoding the signature segment to BYTES and comparing bytes — it never checks
 * the segment's textual encoding. So a revoked token can be re-encoded (append
 * `=` padding, swap to the +/ alphabet, embed whitespace, perturb non-canonical
 * trailing bits) and still verify with identical signature bytes, yet hash to a
 * different string and MISS the revoked record — letting a revoked token keep
 * authenticating. Re-encoding each segment via a base64url decode→encode
 * round-trip reproduces the canonical minted string, so the lookup hash matches
 * regardless of how the caller spelled the token. (Only the signature segment
 * is actually malleable — header/payload are the HMAC input and are already
 * verified by the time we run — but round-tripping all three is the simplest
 * exact reproduction. Also subsumes the previous `.trim()`, which only handled
 * surrounding whitespace e.g. a `?token=<jwt>%20` WebSocket query param.)
 */
function canonicalizeTokenForHash(rawToken: string): string {
  const trimmed = rawToken.trim();
  const parts = trimmed.split(".");
  if (parts.length !== 3) return trimmed;
  try {
    return parts
      .map((seg) => Buffer.from(seg, "base64url").toString("base64url"))
      .join(".");
  } catch {
    return trimmed;
  }
}

/**
 * Hash a caller-supplied actor token exactly as revocation lookups do.
 *
 * Use this for DB writes/reads that need to line up with
 * `isActorTokenRevoked`, including token-mint paths that persist derived
 * actor tokens for later device revocation.
 */
export function actorTokenRecordHash(rawToken: string): string {
  return hashToken(canonicalizeTokenForHash(rawToken));
}

/**
 * True only when `rawToken` is an actor token with an explicitly revoked record.
 * Fail-open in every other case (non-actor, no record, DB error).
 */
export function isActorTokenRevoked(
  rawToken: string,
  claims: TokenClaims,
): boolean {
  const parsed = parseSub(claims.sub);
  if (!parsed.ok || parsed.principalType !== "actor") {
    return false;
  }

  const tokenHash = actorTokenRecordHash(rawToken);

  try {
    const record = getGatewayDb()
      .select({ status: actorTokenRecords.status })
      .from(actorTokenRecords)
      .where(eq(actorTokenRecords.tokenHash, tokenHash))
      .get();
    return record?.status === "revoked";
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Actor-token revocation lookup failed — allowing request (fail-open)",
    );
    return false;
  }
}
