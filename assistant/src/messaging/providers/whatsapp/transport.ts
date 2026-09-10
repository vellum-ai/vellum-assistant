import { ChannelDeliveryError } from "@vellumai/gateway-client/http-delivery";

import { getLogger } from "../../../util/logger.js";
import { directDeliveryContext } from "../callback-routing.js";
import type { ChannelTransport } from "../channel-transport.js";
import { sendWhatsAppAttachments, sendWhatsAppReply } from "./send.js";

const log = getLogger("whatsapp-transport");

export const whatsappTransport: ChannelTransport = {
  channel: "whatsapp",

  /**
   * A chat and a person are the same address on WhatsApp: the phone number.
   * There are no threads, so a chat target's thread is not carried and the
   * post lands in the chat itself.
   */
  addressFor(target) {
    return {
      ctx: directDeliveryContext("whatsapp"),
      chatId: target.kind === "person" ? target.userId : target.chatId,
    };
  },

  // A WhatsApp number's inbound conversation is keyed per chat and can be
  // reset between sends; a proactive post re-binds it so the next inbound
  // from the number lands where the post lives.
  bindsChatOnProactiveSend: true,

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
