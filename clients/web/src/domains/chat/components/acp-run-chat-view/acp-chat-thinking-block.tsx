/**
 * A self-contained collapsible "thinking" block for the ACP chat transcript.
 *
 * Deliberately does NOT reuse `SingleActivity`, which couples to the global
 * viewer-store drawer. Collapse state is local: auto-expanded while streaming,
 * default collapsed once the block completes. The header carries a muted
 * `Brain` glyph and a streaming indicator while live.
 */

import { Brain, ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";

import { ChatMarkdownMessage } from "@/domains/chat/components/chat-markdown-message";
import { ThreeDotIndicator } from "@/domains/chat/components/tool-progress-card/three-dot-indicator";

export interface AcpChatThinkingBlockProps {
  /** Markdown body of the reasoning trace. */
  content: string;
  /** When false the block is still streaming; auto-expands and shows an indicator. */
  isComplete: boolean;
}

export function AcpChatThinkingBlock({
  content,
  isComplete,
}: AcpChatThinkingBlockProps) {
  // Auto-expanded while streaming; collapsed once complete. Local only — never
  // touches the global viewer store.
  const [expanded, setExpanded] = useState(!isComplete);

  return (
    <div data-testid="acp-chat-thinking-block" className="w-full">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((prev) => !prev)}
        data-testid="acp-chat-thinking-toggle"
        className="flex w-full items-center gap-1.5 text-body-small-default text-[var(--content-tertiary)] transition-colors hover:text-[var(--content-secondary)]"
      >
        {expanded ? (
          <ChevronDown aria-hidden className="h-3.5 w-3.5 shrink-0" />
        ) : (
          <ChevronRight aria-hidden className="h-3.5 w-3.5 shrink-0" />
        )}
        <Brain aria-hidden className="h-3.5 w-3.5 shrink-0" />
        <span>{isComplete ? "Thought process" : "Thinking…"}</span>
        {!isComplete && (
          <ThreeDotIndicator
            className="ml-1"
            dotSize={5}
            data-testid="acp-chat-thinking-streaming"
          />
        )}
      </button>

      {expanded && (
        <div
          data-testid="acp-chat-thinking-body"
          className="mt-1.5 border-l-2 border-[var(--border-base)] pl-3 text-body-small-default text-[var(--content-tertiary)]"
        >
          <ChatMarkdownMessage content={content} />
        </div>
      )}
    </div>
  );
}
