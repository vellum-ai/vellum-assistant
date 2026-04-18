/**
 * Cloud OAuth token-minting endpoint for the Chrome extension.
 *
 * Called by the platform (via vembda) after a user authenticates through
 * WorkOS. Mints a guardian-bound JWT that the Chrome extension uses to
 * communicate with the gateway as a guardian client.
 *
 * POST /v1/internal/oauth/chrome-extension/token
 *   Body: { assistantId: string, actorPrincipalId: string }
 *   Auth: edge (service-token — only the platform calls this)
 *   Returns: { token: string, expiresIn: number, guardianId: string }
 */

import { getLogger } from "../../logger.js";
import { mintToken } from "../../auth/token-service.js";
import { validateEdgeToken } from "../../auth/token-exchange.js";
import { parseSub } from "../../auth/subject.js";
import { CURRENT_POLICY_EPOCH } from "../../auth/policy.js";

const log = getLogger("cloud-oauth-token");

/** TTL for minted guardian tokens — 1 hour. */
const GUARDIAN_TOKEN_TTL_SECONDS = 3600;

export function createCloudOAuthTokenHandler() {
  return {
    async handleMintToken(req: Request): Promise<Response> {
      // Restrict to service tokens only — the platform calls this via vembda.
      // Actor tokens from regular users must not be able to mint arbitrary
      // guardian JWTs (would allow impersonation). Fail closed: reject
      // unless we can positively confirm the caller is svc_gateway.
      const authHeader = req.headers.get("authorization");
      const bearerToken = authHeader?.replace(/^Bearer\s+/i, "");
      if (!bearerToken) {
        return Response.json({ error: "Forbidden" }, { status: 403 });
      }
      const tokenResult = validateEdgeToken(bearerToken);
      if (!tokenResult.ok) {
        return Response.json({ error: "Forbidden" }, { status: 403 });
      }
      const sub = parseSub(tokenResult.claims.sub);
      if (!sub.ok || sub.principalType !== "svc_gateway") {
        log.warn("Cloud OAuth token request rejected: not a service token");
        return Response.json({ error: "Forbidden" }, { status: 403 });
      }

      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return Response.json(
          { error: "Request body must be valid JSON" },
          { status: 400 },
        );
      }

      if (!body || typeof body !== "object") {
        return Response.json(
          { error: "Request body must be a JSON object" },
          { status: 400 },
        );
      }

      const { assistantId, actorPrincipalId } = body as Record<string, unknown>;

      if (typeof assistantId !== "string" || assistantId.trim() === "") {
        return Response.json(
          { error: "assistantId is required and must be a non-empty string" },
          { status: 400 },
        );
      }

      if (assistantId.includes(":")) {
        return Response.json(
          { error: "assistantId must not contain colon characters" },
          { status: 400 },
        );
      }

      if (
        typeof actorPrincipalId !== "string" ||
        actorPrincipalId.trim() === ""
      ) {
        return Response.json(
          {
            error:
              "actorPrincipalId is required and must be a non-empty string",
          },
          { status: 400 },
        );
      }

      if (actorPrincipalId.includes(":")) {
        return Response.json(
          { error: "actorPrincipalId must not contain colon characters" },
          { status: 400 },
        );
      }

      const sub = `actor:${assistantId}:${actorPrincipalId}`;

      try {
        const token = mintToken({
          aud: "vellum-gateway",
          sub,
          scope_profile: "actor_client_v1",
          policy_epoch: CURRENT_POLICY_EPOCH,
          ttlSeconds: GUARDIAN_TOKEN_TTL_SECONDS,
        });

        log.info(
          { assistantId, actorPrincipalId },
          "Minted cloud OAuth guardian token",
        );

        return Response.json({
          token,
          expiresIn: GUARDIAN_TOKEN_TTL_SECONDS,
          guardianId: actorPrincipalId,
        });
      } catch (err) {
        log.error({ err }, "Failed to mint cloud OAuth guardian token");
        return Response.json(
          { error: "Failed to mint token" },
          { status: 500 },
        );
      }
    },
  };
}
