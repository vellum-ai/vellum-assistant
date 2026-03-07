import { verifyToken } from "../../auth/token-service.js";
import type { GatewayConfig } from "../../config.js";
import type { ConfigFileCache } from "../../config-file-cache.js";
import type { CredentialCache } from "../../credential-cache.js";
import { getLogger } from "../../logger.js";
import {
  reconcileTelegramWebhook,
  type WebhookManagerCaches,
} from "../../telegram/webhook-manager.js";

const log = getLogger("telegram-reconcile");

/**
 * Internal endpoint that triggers Telegram webhook reconciliation.
 * Called by the assistant daemon after an ingress URL change so that
 * the webhook re-registers immediately without a gateway restart.
 *
 * No longer mutates in-memory config — caches are the source of truth.
 * Invalidates the config file cache so the reconciler reads fresh values.
 */
export function createTelegramReconcileHandler(
  config: GatewayConfig,
  caches?: { credentials?: CredentialCache; configFile?: ConfigFileCache },
) {
  // Serialize reconcile operations so that concurrent requests don't race.
  let reconcileChain: Promise<void> = Promise.resolve();

  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // Validate JWT bearer token (aud=vellum-daemon) from the daemon
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
    // reconciler now reads the ingress URL from the config file cache.
    try {
      const text = await req.text();
      if (text) {
        JSON.parse(text); // validate JSON format
      }
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    // Chain this reconcile after any in-flight one
    const result = new Promise<Response>((resolve) => {
      reconcileChain = reconcileChain
        .then(async () => {
          // Force-refresh caches so the reconciler uses the latest values
          if (caches?.configFile) {
            caches.configFile.refreshNow();
          }

          const webhookCaches: WebhookManagerCaches | undefined = caches
            ? {
                credentials: caches.credentials,
                configFile: caches.configFile,
              }
            : undefined;

          try {
            await reconcileTelegramWebhook(config, webhookCaches);
            log.info("Telegram webhook reconciled via internal endpoint");
            resolve(Response.json({ ok: true }));
          } catch (err) {
            log.error(
              { err },
              "Failed to reconcile Telegram webhook via internal endpoint",
            );
            resolve(
              Response.json(
                { error: "Reconciliation failed" },
                { status: 502 },
              ),
            );
          }
        })
        // Swallow errors so the chain never rejects and subsequent requests
        // are not blocked by a previous failure.
        .catch(() => {});
    });

    return result;
  };
}
