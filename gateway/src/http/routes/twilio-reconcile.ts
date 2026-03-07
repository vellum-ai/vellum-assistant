import { verifyToken } from "../../auth/token-service.js";
import type { GatewayConfig } from "../../config.js";
import type { ConfigFileCache } from "../../config-file-cache.js";
import type { CredentialCache } from "../../credential-cache.js";
import { getLogger } from "../../logger.js";

const log = getLogger("twilio-reconcile");

/**
 * Internal endpoint that refreshes Twilio validation state after ingress or
 * credential changes so webhook validation can use the latest config without
 * waiting for file watchers or a gateway restart.
 *
 * No longer mutates in-memory config or reads credentials from disk directly.
 * Simply invalidates the credential and config file caches so subsequent
 * webhook validation reads pick up fresh values via their normal TTL path.
 */
export function createTwilioReconcileHandler(
  _config: GatewayConfig,
  caches?: { credentials?: CredentialCache; configFile?: ConfigFileCache },
) {
  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    const authHeader = req.headers.get("authorization");
    if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    const token = authHeader.slice(7);
    const authResult = verifyToken(token, "vellum-daemon");
    if (!authResult.ok) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Accept (and ignore) the body — the daemon may still send
    // `{ ingressPublicBaseUrl }` for backward compatibility, but the
    // validator now reads values from caches.
    try {
      const text = await req.text();
      if (text) {
        JSON.parse(text); // validate JSON format
      }
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    // Force-refresh caches so subsequent webhook validations use the latest values
    if (caches?.credentials) {
      caches.credentials.invalidate();
    }
    if (caches?.configFile) {
      caches.configFile.refreshNow();
    }

    log.info("Twilio validation caches refreshed via internal endpoint");
    return Response.json({ ok: true });
  };
}
