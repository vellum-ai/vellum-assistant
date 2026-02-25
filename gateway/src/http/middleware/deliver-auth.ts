import type { GatewayConfig } from "../../config.js";
import { validateBearerToken } from "../auth/bearer.js";

/**
 * Creates a fail-closed auth check for delivery routes.
 *
 * When no bearer token is configured and the route-specific bypass flag is
 * not set, the request is refused (503) rather than silently allowing
 * unauthenticated access. The bypass flag is intended for local development
 * only.
 *
 * Returns null when auth passes (caller should continue), or a Response to
 * short-circuit with.
 */
export function checkDeliverAuth(
  req: Request,
  config: GatewayConfig,
  bypassFlag: keyof GatewayConfig,
): Response | null {
  if (!config.runtimeProxyBearerToken) {
    if (config[bypassFlag]) {
      return null;
    }
    return Response.json(
      { error: "Service not configured: bearer token required" },
      { status: 503 },
    );
  }

  const authResult = validateBearerToken(
    req.headers.get("authorization"),
    config.runtimeProxyBearerToken,
  );
  if (!authResult.authorized) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  return null;
}
