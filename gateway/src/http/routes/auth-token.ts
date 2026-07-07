import type { Server } from "bun";

import { eq } from "drizzle-orm";

import {
  actorTokenRecordHash,
  isActorTokenRevoked,
} from "../../auth/actor-token-revocation.js";
import {
  ensureVellumGuardianBinding,
  VellumGuardianMintRefusedError,
} from "../../auth/guardian-bootstrap.js";
import { guardianIntegrityState } from "../../auth/guardian-integrity.js";
import { CURRENT_POLICY_EPOCH } from "../../auth/policy.js";
import { mintToken, verifyToken } from "../../auth/token-service.js";
import { getGatewayDb } from "../../db/connection.js";
import { actorTokenRecords } from "../../db/schema.js";
import { getLogger } from "../../logger.js";
import { isLoopbackPeer } from "../../util/is-loopback-address.js";

const log = getLogger("auth-token");

const WEB_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

const TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

interface SourceActorTokenRecord {
  guardianPrincipalId: string;
  hashedDeviceId: string;
  platform: string;
}

function findSourceActorTokenRecord(
  sourceToken: string,
): SourceActorTokenRecord | null {
  try {
    return (
      getGatewayDb()
        .select({
          guardianPrincipalId: actorTokenRecords.guardianPrincipalId,
          hashedDeviceId: actorTokenRecords.hashedDeviceId,
          platform: actorTokenRecords.platform,
        })
        .from(actorTokenRecords)
        .where(
          eq(actorTokenRecords.tokenHash, actorTokenRecordHash(sourceToken)),
        )
        .get() ?? null
    );
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Source actor-token lookup failed — minting unrecorded compatibility token",
    );
    return null;
  }
}

function guardianRepairRequiredResponse(): Response {
  return Response.json({ error: "guardian_repair_required" }, { status: 401 });
}

/** Best-effort: a thrown integrity check must never block a healthy refresh. */
function guardianKnownMissing(): boolean {
  try {
    return guardianIntegrityState() === "missing_guardian";
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Guardian integrity check threw — proceeding with token refresh",
    );
    return false;
  }
}

function recordDerivedActorToken(
  sourceRecord: SourceActorTokenRecord | null,
  derivedToken: string,
): void {
  if (!sourceRecord) return;

  const now = Date.now();
  try {
    getGatewayDb()
      .insert(actorTokenRecords)
      .values({
        id: crypto.randomUUID(),
        tokenHash: actorTokenRecordHash(derivedToken),
        guardianPrincipalId: sourceRecord.guardianPrincipalId,
        hashedDeviceId: sourceRecord.hashedDeviceId,
        platform: sourceRecord.platform,
        status: "derived",
        issuedAt: now,
        expiresAt: now + TOKEN_TTL_SECONDS * 1000,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Derived actor-token record insert failed — minted token remains compatible but unrecorded",
    );
  }
}

export async function handleCreateToken(
  req: Request,
  server: Server<unknown> | undefined,
  trustProxy = false,
): Promise<Response> {
  // With a trusted reverse proxy declared, judge loopback-ness by the real
  // client IP (first X-Forwarded-For entry) rather than the raw socket peer,
  // which is always 127.0.0.1 behind a same-host proxy/tunnel. Defaults false,
  // so direct-loopback callers are unaffected.
  if (!server || !isLoopbackPeer(server, req, { trustProxy })) {
    log.warn("Token create rejected: not a loopback peer");
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const origin = req.headers.get("origin");
  if (!origin || !WEB_ORIGIN_RE.test(origin)) {
    log.warn({ origin }, "Token create rejected: missing or invalid Origin");
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const authHeader = req.headers.get("authorization");
  if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
    log.warn(
      "Token create rejected: missing or malformed Authorization header",
    );
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const bearerToken = authHeader.slice(7);
  const verifyResult = verifyToken(bearerToken, "vellum-gateway");
  if (!verifyResult.ok) {
    log.warn(
      { reason: verifyResult.reason },
      "Token create rejected: invalid guardian token",
    );
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (verifyResult.claims.scope_profile !== "actor_client_v1") {
    log.warn(
      { scope: verifyResult.claims.scope_profile },
      "Token create rejected: insufficient scope",
    );
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  // Don't let a revoked token re-mint a fresh one — that would be an escape
  // hatch around device revocation, since the source token still verifies by
  // signature until it expires.
  if (isActorTokenRevoked(bearerToken, verifyResult.claims)) {
    log.warn("Token create rejected: source token revoked");
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sourceRecord = findSourceActorTokenRecord(bearerToken);
  let guardianPrincipalId = sourceRecord?.guardianPrincipalId;
  if (guardianPrincipalId) {
    // Recorded refresh skips the guardian-binding bootstrap, so check
    // integrity explicitly: a DB that lost its guardian rows would otherwise
    // keep re-minting tokens that every trust verdict denies, and the client
    // would never see the repair flow.
    if (guardianKnownMissing()) {
      log.error(
        "Token refresh refused: guardian rows missing over evidence of prior onboarding — repair via guardian init",
      );
      return guardianRepairRequiredResponse();
    }
  } else {
    try {
      guardianPrincipalId = await ensureVellumGuardianBinding();
    } catch (err) {
      // Guardian rows lost but the DB shows prior onboarding: minting here
      // would diverge from prior clients' tokens. Fail closed as a 401 — the
      // status the web client treats as repairable — so callers offer the
      // guardian re-init flow instead of dead-ending on a generic retry.
      if (err instanceof VellumGuardianMintRefusedError) {
        log.error(
          "Token create refused: guardian binding missing over evidence of prior onboarding — repair via guardian init",
        );
        return guardianRepairRequiredResponse();
      }
      throw err;
    }
  }

  const token = mintToken({
    aud: "vellum-gateway",
    sub: `actor:self:${guardianPrincipalId}`,
    scope_profile: "actor_client_v1",
    policy_epoch: CURRENT_POLICY_EPOCH,
    ttlSeconds: TOKEN_TTL_SECONDS,
  });

  recordDerivedActorToken(sourceRecord, token);

  const expiresAt = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
  log.info("Bearer token minted for web local mode");

  return Response.json({ token, expiresAt });
}
