/**
 * The reasoning markdown of a thinking detail, rendered live. Shared by the
 * drawers that show a reasoning step in full (`ToolDetailPanel`'s thinking
 * variant and the drill-in level of `ActivityStepsPanel`) so both resolve the
 * text and render it the same way.
 *
 * The text is re-derived from the chat-session store through the payload's
 * stable identity (`useLiveThinkingText`) so an open drawer streams as
 * `assistant_thinking_delta` events land, falling back to the open-time
 * `thinkingText` snapshot when the source can't be resolved (a message paged
 * out, or an identity-less payload).
 *
 * Rendered incrementally: a long reasoning phase can run to hundreds of
 * kilobytes and arrives as many small deltas, and re-parsing the whole text
 * on each one is quadratic in its length. Per-block rendering keeps each
 * delta's cost to the block it lands in.
 */

import { ChatMarkdownMessage } from "@/domains/chat/components/chat-markdown-message";
import { useLiveThinkingText } from "@/domains/chat/hooks/use-live-thinking-text";
import type { ToolDetailPayload } from "@/stores/viewer-store";

export interface ThinkingDetailMarkdownProps {
  detail: ToolDetailPayload;
  /**
   * Assistant that owns the conversation the step belongs to. Threaded to the
   * markdown so a workspace file the model named resolves against the right
   * workspace.
   */
  assistantId?: string | null;
}

export function ThinkingDetailMarkdown({
  detail,
  assistantId,
}: ThinkingDetailMarkdownProps) {
  const live = useLiveThinkingText(
    detail.messageId,
    detail.thinkingGroupIndex,
    detail.thinkingItemIndex,
  );
  return (
    <ChatMarkdownMessage
      content={live ?? detail.thinkingText ?? ""}
      hardLineBreaks
      incremental
      assistantId={assistantId}
    />
  );
}
