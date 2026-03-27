import { verifyToken } from "../../auth/token-service.js";
import { getLogger } from "../../logger.js";

const log = getLogger("deliver-auth");

/**
 * Creates a fail-closed auth check for delivery routes.
 *
 * Delivery endpoints (runtime -> gateway) now validate a JWT bearer token
 * with aud=vellum-daemon. The caller resolves the bypass boolean from
 * ConfigFileCache before calling — intended for local development only.
 *
 * Returns null when auth passes (caller should continue), or a Response to
 * short-circuit with.
 */
export function checkDeliverAuth(
  req: Request,
  isBypassed: boolean,
): Response | null {
  // Check bypass flag first (local dev only)
  if (isBypassed) {
    return null;
  }

  const authHeader = req.headers.get("authorization");
  if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
    log.warn(
      { path: new URL(req.url).pathname },
      "Deliver auth rejected: missing or malformed Authorization header",
    );
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const token = authHeader.slice(7);
  const result = verifyToken(token, "vellum-daemon");
  if (!result.ok) {
    log.warn(
      { path: new URL(req.url).pathname, reason: result.reason },
      "Deliver auth rejected: token validation failed",
    );
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  return null;
}
