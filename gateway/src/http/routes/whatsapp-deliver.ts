import type { GatewayConfig } from "../../config.js";
import { getLogger } from "../../logger.js";
import { checkDeliverAuth } from "../middleware/deliver-auth.js";
import { sendWhatsAppReply } from "../../whatsapp/send.js";

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
      attachments?: unknown[];
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

    const { text } = body;

    // When text is missing but attachments are present, produce a graceful fallback
    // since WhatsApp media delivery is not yet implemented.
    const hasAttachments = Array.isArray(body.attachments) && body.attachments.length > 0;
    const effectiveText =
      (!text || (typeof text === "string" && text.trim().length === 0)) && hasAttachments
        ? "I have a media attachment to share, but WhatsApp media delivery is not yet supported."
        : text;

    if (!effectiveText || typeof effectiveText !== "string") {
      return Response.json({ error: "text is required" }, { status: 400 });
    }

    try {
      await sendWhatsAppReply(config, to, effectiveText);
    } catch (err) {
      tlog.error({ err, to }, "Failed to deliver WhatsApp reply");
      return Response.json({ error: "Delivery failed" }, { status: 502 });
    }

    tlog.info({ to, textLength: effectiveText.length }, "WhatsApp reply sent");
    return Response.json({ ok: true });
  };
}
