/**
 * Approval prompt delivery: rich UI (buttons) with plain-text fallback.
 */
import type { ChannelId } from "../../channels/types.js";
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

    // Append a legend explaining what each button does
    const legend = buildActionLegend(uiMetadata.actions);
    const richTextWithLegend = legend ? `${richText}\n\n${legend}` : richText;

    try {
      await deliverApprovalPrompt(
        replyCallbackUrl,
        chatId,
        richTextWithLegend,
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
