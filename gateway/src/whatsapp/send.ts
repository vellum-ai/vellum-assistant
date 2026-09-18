import type { ApprovalUIMetadata } from "@vellumai/gateway-client";
import type { GatewayConfig } from "../config.js";
import { getLogger } from "../logger.js";
import { splitText } from "../util/split-text.js";
import {
  sendWhatsAppInteractiveMessage,
  sendWhatsAppTextMessage,
  type WhatsAppApiCaches,
} from "./api.js";

const log = getLogger("whatsapp-send");

// WhatsApp supports up to 4096 characters per text message
const WHATSAPP_MAX_MESSAGE_LEN = 4096;

// WhatsApp interactive message body text limit is 1024 characters
const WHATSAPP_INTERACTIVE_BODY_MAX_LEN = 1024;

// WhatsApp reply button title limit is 20 characters
const WHATSAPP_BUTTON_TITLE_MAX_LEN = 20;

// WhatsApp supports a maximum of 3 reply buttons
const WHATSAPP_MAX_BUTTONS = 3;

// Actions always preserved when the button cap forces a cut: the deny-intent
// pair (reject/block) and the persistent approve variant.
const WHATSAPP_PINNED_ACTION_IDS = new Set([
  "reject",
  "block",
  "approve_always",
]);

/**
 * Select up to WHATSAPP_MAX_BUTTONS actions for WhatsApp interactive buttons.
 * When there are more actions than the cap allows, the pinned decisions are
 * preserved (the guardian must always have a refuse/block path), with the
 * remaining slots filled in order.
 */
function selectWhatsAppButtons(
  actions: Array<{ id: string; label: string }>,
): Array<{ id: string; label: string }> {
  if (actions.length <= WHATSAPP_MAX_BUTTONS) return actions;

  const pinned = actions.filter((a) => WHATSAPP_PINNED_ACTION_IDS.has(a.id));
  const rest = actions.filter((a) => !WHATSAPP_PINNED_ACTION_IDS.has(a.id));
  const slotsForRest = WHATSAPP_MAX_BUTTONS - pinned.length;
  return [...rest.slice(0, slotsForRest), ...pinned];
}

export async function sendWhatsAppReply(
  config: GatewayConfig,
  to: string,
  text: string,
  approval?: ApprovalUIMetadata,
  caches?: WhatsAppApiCaches,
): Promise<void> {
  if (approval) {
    // WhatsApp interactive buttons: up to 3 buttons, 20-char titles, 1024-char body.
    // When there are more actions than the button cap allows, prioritize keeping
    // the reject action visible alongside the most important approve variants.
    const selectedActions = selectWhatsAppButtons(approval.actions);
    const buttons = selectedActions.map((action) => ({
      id: `apr:${approval.requestId}:${action.id}`,
      title: action.label.slice(0, WHATSAPP_BUTTON_TITLE_MAX_LEN),
    }));

    // If text fits in the interactive body limit, send as single interactive message
    if (text.length <= WHATSAPP_INTERACTIVE_BODY_MAX_LEN) {
      await sendWhatsAppInteractiveMessage(to, text, buttons, caches);
      log.debug({ to }, "WhatsApp interactive approval reply sent");
      return;
    }

    // Text too long for interactive body: send text chunks first, then
    // interactive message with truncated body and buttons at the end
    const chunks = splitText(text, WHATSAPP_MAX_MESSAGE_LEN);
    for (let i = 0; i < chunks.length - 1; i++) {
      await sendWhatsAppTextMessage(to, chunks[i], caches);
    }

    const lastChunk = chunks[chunks.length - 1];
    if (lastChunk.length <= WHATSAPP_INTERACTIVE_BODY_MAX_LEN) {
      await sendWhatsAppInteractiveMessage(to, lastChunk, buttons, caches);
    } else {
      // Last chunk still too long — send it as text, then a short interactive prompt
      await sendWhatsAppTextMessage(to, lastChunk, caches);
      await sendWhatsAppInteractiveMessage(
        to,
        "Choose an action:",
        buttons,
        caches,
      );
    }

    log.debug({ to, chunks: chunks.length }, "WhatsApp approval reply sent");
    return;
  }

  const chunks = splitText(text, WHATSAPP_MAX_MESSAGE_LEN);

  for (const chunk of chunks) {
    await sendWhatsAppTextMessage(to, chunk, caches);
  }

  log.debug({ to, chunks: chunks.length }, "WhatsApp reply sent");
}
