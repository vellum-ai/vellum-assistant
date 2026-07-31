import { renderSlackTextForModel } from "@vellumai/slack-text";

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
