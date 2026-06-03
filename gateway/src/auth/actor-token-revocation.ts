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

  // Canonicalize before hashing. validateEdgeToken tolerates surrounding
  // whitespace (base64url signature decode ignores it), but tokens are stored
  // hashed in their canonical form — so a token supplied with trailing
  // whitespace (e.g. a `?token=<jwt>%20` WebSocket query param) would hash to a
  // different value and miss the revoked record. Trim so the lookup matches.
  const tokenHash = hashToken(rawToken.trim());

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
