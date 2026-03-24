/**
 * Approval prompt delivery: rich UI (buttons) with plain-text fallback.
 */
import type { ChannelId } from "../../channels/types.js";
import { redactSecrets } from "../../security/secret-scanner.js";
import { getLogger } from "../../util/logger.js";
import type { ApprovalMessageContext } from "../approval-message-composer.js";
import { composeApprovalMessageGenerative } from "../approval-message-composer.js";
import type {
  ApprovalUIMetadata,
  ChannelApprovalPrompt,
} from "../channel-approval-types.js";
import { channelSupportsRichApprovalUI } from "../channel-approvals.js";
import {
  deliverApprovalPrompt,
  deliverChannelReply,
} from "../gateway-client.js";
import { buildActionLegend } from "../guardian-decision-types.js";
import type { ApprovalCopyGenerator } from "../http-types.js";
import { requiredDecisionKeywords } from "./channel-route-shared.js";

const log = getLogger("runtime-http");

// ---------------------------------------------------------------------------
// Tool input summary for rich-UI approval prompts
// ---------------------------------------------------------------------------

/** Max characters for the tool input preview line. */
const INPUT_PREVIEW_MAX_LENGTH = 200;

/**
 * Extract a concise, human-readable preview of the tool input so that
 * sequential approval prompts for the same tool are distinguishable.
 *
 * Returns `null` when no meaningful preview can be produced.
 */
/** Escape backticks in user-controlled input so they don't break inline code spans. */
function escapeBackticks(value: string): string {
  return value.replace(/`/g, "'");
}

/** Redact potential secrets from tool input before previewing. */
function sanitizePreviewValue(value: string): string {
  return escapeBackticks(redactSecrets(value));
}

function formatToolInputPreview(
  toolName: string,
  toolInput: Record<string, unknown>,
): string | null {
  // Pick the most relevant field based on tool type
  const command = toolInput.command ?? toolInput.cmd;
  if (typeof command === "string" && command.length > 0) {
    return truncatePreview(`\`${sanitizePreviewValue(command)}\``);
  }

  const path = toolInput.path ?? toolInput.file_path ?? toolInput.filePath;
  if (typeof path === "string" && path.length > 0) {
    const verb =
      toolName.includes("write") || toolName.includes("edit")
        ? "writing to"
        : toolName.includes("read")
          ? "reading"
          : "on";
    return truncatePreview(`${verb} \`${sanitizePreviewValue(path)}\``);
  }

  const url = toolInput.url;
  if (typeof url === "string" && url.length > 0) {
    return truncatePreview(`fetching \`${sanitizePreviewValue(url)}\``);
  }

  return null;
}

function truncatePreview(text: string): string {
  if (text.length <= INPUT_PREVIEW_MAX_LENGTH) return text;
  const truncated = text.slice(0, INPUT_PREVIEW_MAX_LENGTH - 1) + "…";
  // Preserve backtick pairing so markdown renders correctly.
  const openBackticks = (truncated.match(/`/g) || []).length;
  return openBackticks % 2 !== 0 ? truncated + "`" : truncated;
}

export interface DeliverGeneratedApprovalPromptParams {
  replyCallbackUrl: string;
  chatId: string;
  sourceChannel: ChannelId;
  assistantId: string;
  bearerToken?: string;
  prompt: ChannelApprovalPrompt;
  uiMetadata: ApprovalUIMetadata;
  messageContext: ApprovalMessageContext;
  approvalCopyGenerator?: ApprovalCopyGenerator;
}

/**
 * Deliver approval prompts with best-available UX:
 * 1) Rich UI (buttons) when supported
 * 2) Plain-text fallback if rich delivery fails
 * 3) Plain-text path for channels without rich UI
 */
export async function deliverGeneratedApprovalPrompt(
  params: DeliverGeneratedApprovalPromptParams,
): Promise<boolean> {
  const {
    replyCallbackUrl,
    chatId,
    sourceChannel,
    assistantId,
    bearerToken,
    prompt,
    uiMetadata,
    messageContext,
    approvalCopyGenerator,
  } = params;
  const keywords = requiredDecisionKeywords(uiMetadata.actions);

  if (channelSupportsRichApprovalUI(sourceChannel)) {
    const richText = await composeApprovalMessageGenerative(
      { ...messageContext, channel: sourceChannel, richUi: true },
      { fallbackText: prompt.promptText },
      approvalCopyGenerator,
    );

    // Append a tool input preview so sequential approvals are distinguishable
    let enrichedText = richText;
    if (uiMetadata.permissionDetails) {
      const preview = formatToolInputPreview(
        uiMetadata.permissionDetails.toolName,
        uiMetadata.permissionDetails.toolInput,
      );
      if (preview) {
        enrichedText = `${enrichedText}\n\n${preview}`;
      }
    }

    // Append a legend explaining what each button does
    const legend = buildActionLegend(uiMetadata.actions);
    if (legend) {
      enrichedText = `${enrichedText}\n\n${legend}`;
    }

    try {
      await deliverApprovalPrompt(
        replyCallbackUrl,
        chatId,
        enrichedText,
        uiMetadata,
        assistantId,
        bearerToken,
      );
      return true;
    } catch (err) {
      log.error(
        { err, chatId, sourceChannel },
        "Failed to deliver rich approval prompt, attempting plain-text fallback",
      );
    }

    const plainTextFallback = await composeApprovalMessageGenerative(
      { ...messageContext, channel: sourceChannel, richUi: false },
      { fallbackText: prompt.plainTextFallback, requiredKeywords: keywords },
      approvalCopyGenerator,
    );

    // Embed the run reference so plain-text replies can disambiguate when
    // multiple approvals are pending for the same guardian chat.
    const taggedFallback = `${plainTextFallback}\n[ref:${uiMetadata.requestId}]`;

    try {
      await deliverChannelReply(
        replyCallbackUrl,
        {
          chatId,
          text: taggedFallback,
          assistantId,
        },
        bearerToken,
      );
      return true;
    } catch (err) {
      log.error(
        { err, chatId, sourceChannel },
        "Failed to deliver plain-text fallback approval prompt",
      );
      return false;
    }
  }

  const plainText = await composeApprovalMessageGenerative(
    { ...messageContext, channel: sourceChannel, richUi: false },
    { fallbackText: prompt.plainTextFallback, requiredKeywords: keywords },
    approvalCopyGenerator,
  );

  // Embed the run reference for disambiguation in multi-pending scenarios.
  const taggedPlainText = `${plainText}\n[ref:${uiMetadata.requestId}]`;

  try {
    await deliverChannelReply(
      replyCallbackUrl,
      {
        chatId,
        text: taggedPlainText,
        assistantId,
      },
      bearerToken,
    );
    return true;
  } catch (err) {
    log.error(
      { err, chatId, sourceChannel },
      "Failed to deliver plain-text approval prompt",
    );
    return false;
  }
}
