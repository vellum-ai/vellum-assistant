import { verifyToken } from "../../auth/token-service.js";

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
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const token = authHeader.slice(7);
  const result = verifyToken(token, "vellum-daemon");
  if (!result.ok) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  return null;
}
