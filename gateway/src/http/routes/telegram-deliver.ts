import type { GatewayConfig } from "../../config.js";
import { validateBearerToken } from "../auth/bearer.js";
import { getLogger } from "../../logger.js";
import type { RuntimeAttachmentMeta } from "../../runtime/client.js";
import { sendTelegramAttachments, sendTelegramReply } from "../../telegram/send.js";

const log = getLogger("telegram-deliver");

export function createTelegramDeliverHandler(config: GatewayConfig) {
  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // Fail-closed auth: when no bearer token is configured and the explicit
    // dev-only bypass flag is not set, refuse to serve requests (503) rather
    // than silently allowing unauthenticated access.
    if (!config.runtimeProxyBearerToken) {
      if (config.telegramDeliverAuthBypass) {
        // Dev-only bypass — skip auth entirely.
      } else {
        return Response.json(
          { error: "Service not configured: bearer token required" },
          { status: 503 },
        );
      }
    } else {
      const authResult = validateBearerToken(
        req.headers.get("authorization"),
        config.runtimeProxyBearerToken,
      );
      if (!authResult.authorized) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
    }

    let body: {
      chatId?: string;
      text?: string;
      assistantId?: string;
      attachments?: RuntimeAttachmentMeta[];
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const { chatId, text, assistantId, attachments } = body;

    if (!chatId || typeof chatId !== "string") {
      return Response.json({ error: "chatId is required" }, { status: 400 });
    }

    if (!text && (!attachments || attachments.length === 0)) {
      return Response.json({ error: "text or attachments required" }, { status: 400 });
    }

    // Validate attachment array shape and element types before accessing properties.
    // Without these checks, null or non-object elements would throw a TypeError
    // outside the delivery try/catch, producing an unhandled 500 instead of a 400.
    if (attachments) {
      if (!Array.isArray(attachments)) {
        return Response.json({ error: "attachments must be an array" }, { status: 400 });
      }
      for (const att of attachments) {
        if (att === null || typeof att !== "object" || Array.isArray(att)) {
          return Response.json({ error: "each attachment must be an object" }, { status: 400 });
        }
        if (!att.id || typeof att.id !== "string") {
          return Response.json({ error: "each attachment must have an id" }, { status: 400 });
        }
      }
    }

    try {
      if (text) {
        await sendTelegramReply(config, chatId, text);
      }

      if (attachments && attachments.length > 0) {
        await sendTelegramAttachments(config, chatId, assistantId, attachments);
      }
    } catch (err) {
      log.error({ err, chatId }, "Failed to deliver Telegram reply");
      return Response.json({ error: "Delivery failed" }, { status: 502 });
    }

    return Response.json({ ok: true });
  };
}
