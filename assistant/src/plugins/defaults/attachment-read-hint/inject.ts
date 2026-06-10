/**
 * Attachment-read hint: model gating and tail-message injection.
 *
 * Some models under-prioritize attached images/files: when the user pastes a
 * screenshot or document and asks a question about it, they run discovery
 * tools first and only consult the attachment as a fallback — burning LLM
 * calls on tool loops when the attachment already contains the answer. The
 * hint nudges those models to read attached content before deciding next
 * actions. Models that already read attachments first don't get the hint, so
 * they pay no token cost for it.
 */

import type { Message } from "../../../providers/types.js";

/**
 * Models that need the attachment-read hint. Currently Kimi K2.6 only,
 * matched across provider id schemes: Fireworks spells it
 * `accounts/fireworks/models/kimi-k2p6`, Moonshot `moonshotai/kimi-k2.6`.
 * The `[p.]` keeps K2.5 (`kimi-k2p5` / `kimi-k2.5`) excluded.
 */
const MODELS_NEEDING_HINT = /kimi-k2[p.]6/i;

/**
 * Whether the resolved turn model needs the attachment-read hint. An absent
 * model (synthesized contexts that cannot resolve one) means no hint.
 */
export function modelNeedsAttachmentReadHint(
  model: string | undefined,
): boolean {
  return model !== undefined && MODELS_NEEDING_HINT.test(model);
}

/** Hint text appended after the user's content blocks. */
export const ATTACHMENT_READ_HINT =
  "<attached_content_hint>\nThe user attached one or more images/files in this turn. Read them carefully before running discovery tools — the attachment often already contains the answer or the specific context the user is referring to.\n</attached_content_hint>";

/**
 * Append the attachment-read hint when the message carries image or file
 * attachments. Returns the input message unchanged (same reference) when no
 * attachment is present.
 */
export function injectAttachmentReadHint(message: Message): Message {
  const hasAttachment = message.content.some(
    (block) => block.type === "image" || block.type === "file",
  );
  if (!hasAttachment) return message;
  return {
    ...message,
    content: [...message.content, { type: "text", text: ATTACHMENT_READ_HINT }],
  };
}
