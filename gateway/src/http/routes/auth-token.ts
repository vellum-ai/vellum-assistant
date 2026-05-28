import type { Server } from "bun";

import { ensureVellumGuardianBinding } from "../../auth/guardian-bootstrap.js";
import { CURRENT_POLICY_EPOCH } from "../../auth/policy.js";
import { mintToken, verifyToken } from "../../auth/token-service.js";
import { getLogger } from "../../logger.js";
import { isLoopbackPeer } from "../../util/is-loopback-address.js";

const log = getLogger("auth-token");

const WEB_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

const TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export async function handleCreateToken(
  req: Request,
  server: Server<unknown> | undefined,
): Promise<Response> {
  if (!server || !isLoopbackPeer(server, req)) {
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
    log.warn("Token create rejected: missing or malformed Authorization header");
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const bearerToken = authHeader.slice(7);
  const verifyResult = verifyToken(bearerToken, "vellum-gateway");
  if (!verifyResult.ok) {
    log.warn({ reason: verifyResult.reason }, "Token create rejected: invalid guardian token");
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (verifyResult.claims.scope_profile !== "actor_client_v1") {
    log.warn({ scope: verifyResult.claims.scope_profile }, "Token create rejected: insufficient scope");
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const guardianPrincipalId = await ensureVellumGuardianBinding();

  const token = mintToken({
    aud: "vellum-gateway",
    sub: `actor:self:${guardianPrincipalId}`,
    scope_profile: "actor_client_v1",
    policy_epoch: CURRENT_POLICY_EPOCH,
    ttlSeconds: TOKEN_TTL_SECONDS,
  });

  const expiresAt = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
  log.info("Bearer token minted for web local mode");

  return Response.json({ token, expiresAt });
}
