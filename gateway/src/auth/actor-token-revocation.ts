/**
 * Hot-path admission for actor tokens ({@link admitActorToken}): one lookup
 * that both enforces revocation and stamps the presenting device's last-used
 * activity.
 *
 * Edge-token validation ({@link validateEdgeToken}) only verifies the JWT
 * (signature, audience, expiry, policy epoch), never the DB. That means
 * marking an actor token "revoked" in `actorTokenRecords` (on re-pair, device
 * unpair, etc.) has no effect on live requests until the token expires.
 *
 * Admission closes that gap: on the request hot path, after the JWT is
 * validated, reject an actor token whose recorded row is `status = 'revoked'`.
 *
 * Policy is **fail-OPEN**:
 *   - Non-actor tokens (svc/local) are never checked.
 *   - An actor token with NO record is allowed. Legacy/unrecorded tokens (and
 *     any mint path not yet recording to the DB) must never be broken.
 *   - Any DB error (incl. the gateway DB not being initialized) allows the
 *     request and logs a warning. A revocation check must never take down auth
 *     on a DB hiccup; we are no worse off than before this check existed.
 *
 * Only an explicit `status = 'revoked'` row results in rejection.
 */
import { createHash } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { getGatewayDb } from "../db/connection.js";
import { actorTokenRecords } from "../db/schema.js";
import { StringDedupCache } from "../dedup-cache.js";
import { getLogger } from "../logger.js";
import type { TokenClaims } from "./types.js";
import { parseSub } from "./subject.js";

const log = getLogger("actor-token-revocation");

/** One stamp per token per window; the label's resolution is this coarse. */
const STAMP_DEBOUNCE_MS = 5 * 60 * 1000;
/** Bound on the debounce cache so long-lived gateways cannot leak. */
const MAX_TRACKED_TOKENS = 5_000;

let stampDebounce = new StringDedupCache(STAMP_DEBOUNCE_MS, MAX_TRACKED_TOKENS);

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
  if (parts.length !== 3) {
    return trimmed;
  }
  try {
    return parts
      .map((seg) => Buffer.from(seg, "base64url").toString("base64url"))
      .join(".");
  } catch {
    return trimmed;
  }
}

/**
 * Hash a caller-supplied actor token exactly as admission lookups do.
 *
 * Use this for DB writes/reads that need to line up with
 * {@link admitActorToken}, including token-mint paths that persist derived
 * actor tokens for later device revocation.
 */
export function actorTokenRecordHash(rawToken: string): string {
  return hashToken(canonicalizeTokenForHash(rawToken));
}

/**
 * Decide whether a validated token may proceed, and record the activity of the
 * device that presented it. Returns false only for an actor token whose record
 * is explicitly `status = 'revoked'`; every other case is fail-open.
 *
 * One canonicalize + hash + indexed SELECT serves both jobs, and the two are
 * inseparable by construction: a caller cannot enforce revocation while
 * forgetting to stamp, which would silently drop that device off the "Paired
 * devices" list.
 *
 * The stamp is debounced to one DB round-trip per token per
 * {@link STAMP_DEBOUNCE_MS}, armed by a completed stamp and also by a
 * definitive "no such record" answer (unrecorded tokens are a permanent
 * supported state). A DB error arms nothing, leaving the next request free to
 * retry immediately.
 *
 * Resolved through the DEVICE rather than the presented row: `/auth/token`
 * mints `status = 'derived'` rows sharing the source row's `hashed_device_id`
 * and only the `active` row is ever displayed, so derived-token traffic counts.
 *
 * Deliberately leaves `updatedAt` alone: that column tracks row lifecycle
 * (status changes), and moving it every few minutes would destroy that signal.
 */
export function admitActorToken(
  rawToken: string,
  claims: TokenClaims,
): boolean {
  const parsed = parseSub(claims.sub);
  if (!parsed.ok || parsed.principalType !== "actor") {
    return true;
  }

  const tokenHash = actorTokenRecordHash(rawToken);

  try {
    const db = getGatewayDb();
    const record = db
      .select({
        status: actorTokenRecords.status,
        guardianPrincipalId: actorTokenRecords.guardianPrincipalId,
        hashedDeviceId: actorTokenRecords.hashedDeviceId,
      })
      .from(actorTokenRecords)
      .where(eq(actorTokenRecords.tokenHash, tokenHash))
      .get();

    // Verdict first: a rejected token must never stamp.
    if (record?.status === "revoked") {
      return false;
    }

    if (stampDebounce.has(tokenHash)) {
      return true;
    }

    if (!record) {
      // A stable answer, not a failure: arm the window like a completed stamp.
      stampDebounce.mark(tokenHash);
      return true;
    }

    db.update(actorTokenRecords)
      .set({ lastUsedAt: Date.now() })
      .where(
        and(
          eq(actorTokenRecords.guardianPrincipalId, record.guardianPrincipalId),
          eq(actorTokenRecords.hashedDeviceId, record.hashedDeviceId),
          eq(actorTokenRecords.status, "active"),
        ),
      )
      .run();

    stampDebounce.mark(tokenHash);
    return true;
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Actor-token admission failed, allowing request (fail-open)",
    );
    return true;
  }
}

/** Clears the last-used debounce state. Exists solely for tests. */
export function __resetLastUsedDebounceForTests(): void {
  stampDebounce = new StringDedupCache(STAMP_DEBOUNCE_MS, MAX_TRACKED_TOKENS);
}
