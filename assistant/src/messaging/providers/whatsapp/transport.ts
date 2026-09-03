import { ChannelDeliveryError } from "@vellumai/gateway-client/http-delivery";

import { getLogger } from "../../../util/logger.js";
import type { ChannelTransport } from "../channel-transport.js";
import { sendWhatsAppAttachments, sendWhatsAppReply } from "./send.js";

const log = getLogger("whatsapp-transport");

export const whatsappTransport: ChannelTransport = {
  channel: "whatsapp",

  async deliver(_ctx, payload) {
    const { chatId, text, attachments, approval } = payload;

    let messageIds: string[] = [];
    if (text) {
      const sent = await sendWhatsAppReply(chatId, text, approval);
      messageIds = sent.messageIds;
    } else if (approval) {
      const sent = await sendWhatsAppReply(
        chatId,
        approval.plainTextFallback || "Approval required",
        approval,
      );
      messageIds = sent.messageIds;
    }

    if (attachments && attachments.length > 0) {
      const result = await sendWhatsAppAttachments(chatId, attachments);
      if (result.allFailed && !text) {
        throw new ChannelDeliveryError(
          502,
          `All ${result.failureCount} attachments failed to deliver`,
        );
      }
    }

    log.info({ chatId, hasText: !!text }, "WhatsApp reply delivered (direct)");
    // Every message the text became is acknowledged; attachment posts are not.
    return { ok: true, messageIds };
  },
};
