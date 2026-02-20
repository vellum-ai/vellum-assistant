import type { GatewayConfig } from "../../config.js";
import { getLogger } from "../../logger.js";
import type { RuntimeAttachmentMeta } from "../../runtime/client.js";
import { sendTelegramAttachments, sendTelegramReply } from "../../telegram/send.js";

const log = getLogger("telegram-deliver");

export function createTelegramDeliverHandler(config: GatewayConfig) {
  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
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

    try {
      if (text) {
        await sendTelegramReply(config, chatId, text);
      }

      if (attachments && attachments.length > 0 && assistantId) {
        await sendTelegramAttachments(config, chatId, assistantId, attachments);
      }
    } catch (err) {
      log.error({ err, chatId }, "Failed to deliver Telegram reply");
      return Response.json({ error: "Delivery failed" }, { status: 502 });
    }

    return Response.json({ ok: true });
  };
}
