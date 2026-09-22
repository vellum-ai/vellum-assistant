/**
 * The reasoning markdown of a thinking detail, rendered live. The one body
 * every panel that shows a reasoning step in full uses (`ToolDetailPanel`'s
 * thinking variant, the drill-in level of `ActivityStepsPanel`, the subagent
 * panel's nested step) so each resolves the text and renders it the same way.
 *
 * The text is re-derived from the chat-session store through the payload's
 * stable identity (`useLiveThinkingText`) so an open drawer streams as
 * `assistant_thinking_delta` events land, falling back to the open-time
 * `thinkingText` snapshot when the source can't be resolved (a message paged
 * out, or a payload that names no chat message, such as a subagent's step).
 *
 * Live text renders incrementally: a long reasoning phase can run to hundreds
 * of kilobytes and arrives as many small deltas, and re-parsing the whole text
 * on each one is quadratic in its length. Per-block rendering keeps each
 * delta's cost to the block it lands in. Recorded text (a subagent's step, or
 * a snapshot whose message is gone) arrives once, so it takes the full parse,
 * which is the only one that resolves a reference link or footnote defined in
 * another paragraph.
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
      incremental={live !== null}
      assistantId={assistantId}
    />
  );
}
