import pino from "pino";
import type { GatewayConfig } from "../../config.js";
import { verifyWebhookSecret } from "../../telegram/verify.js";
import { normalizeTelegramUpdate } from "../../telegram/normalize.js";

const log = pino({ name: "gateway:telegram-webhook" });

export type InboundHandler = (
  event: import("../../types.js").GatewayInboundEventV1,
) => Promise<void>;

export function createTelegramWebhookHandler(
  config: GatewayConfig,
  onInbound: InboundHandler,
) {
  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // Verify webhook secret
    if (!verifyWebhookSecret(req.headers, config.telegramWebhookSecret)) {
      log.warn("Telegram webhook request failed secret verification");
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    let payload: Record<string, unknown>;
    try {
      payload = (await req.json()) as Record<string, unknown>;
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    // Normalize the update
    const normalized = normalizeTelegramUpdate(payload);
    if (!normalized) {
      log.debug({ updateId: payload.update_id }, "Unsupported Telegram update, ignoring");
      return Response.json({ ok: true });
    }

    // Return 200 immediately, process async
    // We need routing to build the full event, but that's wired up in PR 3.
    // For now, fire-and-forget the processing.
    const processAsync = async () => {
      try {
        // Routing placeholder — will be filled in PR 3
        const event = {
          ...normalized,
          routing: { assistantId: "", routeSource: "default" as const },
        };
        await onInbound(event);
      } catch (err) {
        log.error({ err, updateId: payload.update_id }, "Failed to process inbound event");
      }
    };

    processAsync();

    return Response.json({ ok: true });
  };
}
