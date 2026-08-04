import {
  extractSlackChannelReferenceIds,
  extractSlackUserMentionIds,
  renderSlackTextForModel,
} from "@vellumai/slack-text";

export type SlackTextRenderContext = {
  userLabels?: Record<string, string>;
  channelLabels?: Record<string, string>;
};

export function renderSlackInboundText(
  text: string,
  context: SlackTextRenderContext = {},
): string {
  return renderSlackTextForModel(text, {
    userLabels: context.userLabels,
    channelLabels: context.channelLabels,
  });
}

/**
 * The verbatim event text to forward as `source.rawText`, or `undefined` when
 * it carries no user/channel mention tokens. Only mention-bearing texts are
 * worth forwarding: the raw form exists so the daemon can re-render mention
 * names at projection time, and a token-free text renders identically forever.
 */
export function slackRawTextForForwarding(
  text: string | undefined,
): string | undefined {
  if (!text) {
    return undefined;
  }
  const hasMentionTokens =
    extractSlackUserMentionIds(text).length > 0 ||
    extractSlackChannelReferenceIds(text).length > 0;
  return hasMentionTokens ? text : undefined;
}
