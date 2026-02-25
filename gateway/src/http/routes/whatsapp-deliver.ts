import type { GatewayConfig } from "../../config.js";
import { getLogger } from "../../logger.js";
import type { RuntimeAttachmentMeta } from "../../runtime/client.js";
import { checkDeliverAuth } from "../middleware/deliver-auth.js";
import { sendWhatsAppAttachments, sendWhatsAppReply } from "../../whatsapp/send.js";

const log = getLogger("whatsapp-deliver");

export function createWhatsAppDeliverHandler(config: GatewayConfig) {
  return async (req: Request): Promise<Response> => {
    const traceId = req.headers.get("x-trace-id") ?? undefined;
    const tlog = traceId ? log.child({ traceId }) : log;

    if (req.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    const authResponse = checkDeliverAuth(req, config, "whatsappDeliverAuthBypass");
    if (authResponse) return authResponse;

    // Verify WhatsApp sending is configured
    if (!config.whatsappPhoneNumberId || !config.whatsappAccessToken) {
      tlog.error("WhatsApp credentials not configured");
      return Response.json(
        { error: "WhatsApp integration not configured" },
        { status: 503 },
      );
    }

    let body: {
      chatId?: string;
      to?: string;
      text?: string;
      assistantId?: string;
      attachments?: RuntimeAttachmentMeta[];
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    // Accept `chatId` as an alias for `to` — runtime channel callbacks send `{ chatId, text }`.
    const to = body.to ?? body.chatId;

    if (!to || typeof to !== "string") {
      return Response.json({ error: "to is required" }, { status: 400 });
    }

    const { text, assistantId, attachments } = body;

    if (!text && (!attachments || attachments.length === 0)) {
      return Response.json({ error: "text or attachments required" }, { status: 400 });
    }

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
        await sendWhatsAppReply(config, to, text);
      }

      if (attachments && attachments.length > 0) {
        await sendWhatsAppAttachments(config, to, assistantId, attachments);
      }
    } catch (err) {
      tlog.error({ err, to }, "Failed to deliver WhatsApp reply");
      return Response.json({ error: "Delivery failed" }, { status: 502 });
    }

    tlog.info({ to, hasText: !!text, attachmentCount: attachments?.length ?? 0 }, "WhatsApp reply sent");
    return Response.json({ ok: true });
  };
}
