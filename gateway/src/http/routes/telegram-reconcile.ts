import type { GatewayConfig } from "../../config.js";
import { validateBearerToken } from "../auth/bearer.js";
import { getLogger } from "../../logger.js";
import { reconcileTelegramWebhook } from "../../telegram/webhook-manager.js";

const log = getLogger("telegram-reconcile");

/**
 * Internal endpoint that triggers Telegram webhook reconciliation.
 * Called by the assistant daemon after an ingress URL change so that
 * the webhook re-registers immediately without a gateway restart.
 */
export function createTelegramReconcileHandler(config: GatewayConfig) {
  // Serialize reconcile operations so that concurrent requests don't race.
  // Without this, overlapping calls could each mutate config.ingressPublicBaseUrl
  // and then call reconcileTelegramWebhook independently, leaving Telegram
  // pointed at a stale URL from an earlier request.
  let reconcileChain: Promise<void> = Promise.resolve();

  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // Fail-closed: require a bearer token to be configured.
    if (!config.runtimeProxyBearerToken) {
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

    let body: { ingressPublicBaseUrl?: string } = {};
    try {
      const text = await req.text();
      if (text) {
        body = JSON.parse(text) as typeof body;
      }
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    // Chain this reconcile after any in-flight one so config mutation +
    // webhook registration are atomic with respect to other requests.
    const result = new Promise<Response>((resolve) => {
      reconcileChain = reconcileChain
        .then(async () => {
          // If a new ingress URL is provided, update the in-memory config so that
          // reconcile uses the latest value without requiring a gateway restart.
          if (typeof body.ingressPublicBaseUrl === "string") {
            const normalized = body.ingressPublicBaseUrl.trim().replace(/\/+$/, "");
            config.ingressPublicBaseUrl = normalized || undefined;
            log.info({ ingressPublicBaseUrl: config.ingressPublicBaseUrl }, "Updated in-memory ingress URL");
          }

          try {
            await reconcileTelegramWebhook(config);
            log.info("Telegram webhook reconciled via internal endpoint");
            resolve(Response.json({ ok: true }));
          } catch (err) {
            log.error({ err }, "Failed to reconcile Telegram webhook via internal endpoint");
            resolve(Response.json({ error: "Reconciliation failed" }, { status: 502 }));
          }
        })
        // Swallow errors so the chain never rejects and subsequent requests
        // are not blocked by a previous failure.
        .catch(() => {});
    });

    return result;
  };
}
