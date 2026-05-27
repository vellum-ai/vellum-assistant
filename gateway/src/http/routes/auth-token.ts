import type { Server } from "bun";

import { ensureVellumGuardianBinding } from "../../auth/guardian-bootstrap.js";
import { CURRENT_POLICY_EPOCH } from "../../auth/policy.js";
import { mintToken } from "../../auth/token-service.js";
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
