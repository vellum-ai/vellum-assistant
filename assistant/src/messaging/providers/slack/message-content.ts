/**
 * Fallback text extraction for Slack messages whose content lives outside
 * the top-level `text` field.
 *
 * Bot and incoming-webhook posts (CI alerts, app notifications) routinely
 * ship an empty `text` with the visible content in legacy `attachments` or
 * Block Kit `blocks`; Slack's own clients render those. A mapping that reads
 * only `text` turns such a message into an empty row, which downstream
 * surfaces (transcripts, channel references) present as missing content.
 *
 * Output is raw Slack mrkdwn: mention/link tokens inside attachments and
 * blocks are preserved so callers can route the result through the same
 * `renderSlackTextForModel` pass as ordinary message text.
 */
import type {
  AnyBlock,
  ContextBlock,
  HeaderBlock,
  MarkdownBlock,
  MessageAttachment,
  SectionBlock,
} from "@slack/types";

import type { SlackMessage } from "./types.js";

/**
 * The model-facing raw mrkdwn for a Slack message: `text` when present,
 * otherwise content derived from `blocks` and `attachments` (in that order,
 * matching how Slack renders a message body above its attachments).
 */
export function slackMessageRawText(
  msg: Pick<SlackMessage, "text" | "attachments" | "blocks">,
): string {
  if (msg.text?.trim()) {
    return msg.text;
  }
  const parts = [
    ...slackBlocksText(msg.blocks),
    ...(msg.attachments ?? []).map(slackAttachmentText),
  ].filter((part) => part.length > 0);
  return parts.join("\n");
}

function slackAttachmentText(attachment: MessageAttachment): string {
  // An attachment carrying Block Kit blocks renders them as its body, so
  // they lead; the legacy fields still contribute when both are present.
  const blockParts = slackBlocksText(attachment.blocks);
  const title = trimmed(attachment.title);
  const titleLink = trimmed(attachment.title_link);
  const fieldLines = (attachment.fields ?? []).map((field) => {
    const fieldTitle = trimmed(field.title);
    const fieldValue = trimmed(field.value);
    if (fieldTitle && fieldValue) {
      return `${fieldTitle}: ${fieldValue}`;
    }
    return fieldTitle ?? fieldValue ?? "";
  });
  const structured = [
    ...blockParts,
    trimmed(attachment.pretext),
    trimmed(attachment.author_name),
    title && titleLink ? `${title} (${titleLink})` : title,
    trimmed(attachment.text),
    ...fieldLines,
    trimmed(attachment.footer),
  ].filter((part): part is string => !!part);
  if (structured.length > 0) {
    return structured.join("\n");
  }
  return trimmed(attachment.fallback) ?? "";
}

function isSectionBlock(block: AnyBlock): block is SectionBlock {
  return block.type === "section";
}

function isHeaderBlock(block: AnyBlock): block is HeaderBlock {
  return block.type === "header";
}

function isContextBlock(block: AnyBlock): block is ContextBlock {
  return block.type === "context";
}

function isMarkdownBlock(block: AnyBlock): block is MarkdownBlock {
  return block.type === "markdown";
}

/**
 * Text carried by the block types that hold a message body's copy. Other
 * block types contribute nothing: images/dividers/actions are non-textual,
 * and `rich_text` (deeply nested; produced for user-typed messages, which
 * carry the equivalent top-level `text`) is intentionally not walked.
 */
function slackBlocksText(blocks: readonly AnyBlock[] | undefined): string[] {
  const parts: string[] = [];
  for (const block of blocks ?? []) {
    if (isSectionBlock(block)) {
      const text = trimmed(block.text?.text);
      if (text) {
        parts.push(text);
      }
      for (const field of block.fields ?? []) {
        const fieldText = trimmed(field.text);
        if (fieldText) {
          parts.push(fieldText);
        }
      }
    } else if (isHeaderBlock(block)) {
      const text = trimmed(block.text.text);
      if (text) {
        parts.push(text);
      }
    } else if (isContextBlock(block)) {
      const contextText = block.elements
        .map((element) =>
          "text" in element ? trimmed(element.text) : undefined,
        )
        .filter((text): text is string => !!text)
        .join(" ");
      if (contextText) {
        parts.push(contextText);
      }
    } else if (isMarkdownBlock(block)) {
      const text = trimmed(block.text);
      if (text) {
        parts.push(text);
      }
    }
  }
  return parts;
}

function trimmed(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result ? result : undefined;
}
