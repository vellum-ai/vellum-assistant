/**
 * A self-contained "thinking" block for the ACP chat transcript.
 *
 * With reasoning text it renders as a collapsible accordion (deliberately NOT
 * reusing `SingleActivity`, which couples to the global viewer-store drawer):
 * collapse state is local — auto-expanded while streaming, default collapsed
 * once complete. An empty thought "signal" (no reasoning text) renders as a
 * static, non-expandable indicator — no chevron, no toggle, no body — so the
 * transcript still surfaces that the agent was thinking without an accordion
 * that expands to nothing. Both carry a muted `Brain` glyph and a streaming
 * indicator while live.
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
  // Auto-expanded while streaming; collapsed once complete. A user toggle sets
  // an override that sticks regardless of later `isComplete` changes. Local
  // only — never touches the global viewer store.
  const [override, setOverride] = useState<boolean | null>(null);
  const expanded = override ?? !isComplete;
  const hasContent = content.trim().length > 0;

  const label = isComplete ? "Thought process" : "Thinking…";
  const streamingIndicator = !isComplete && (
    <ThreeDotIndicator
      className="ml-1"
      dotSize={5}
      data-testid="acp-chat-thinking-streaming"
    />
  );

  // No reasoning text: a static indicator, not an expandable accordion.
  if (!hasContent) {
    return (
      <div data-testid="acp-chat-thinking-block" className="w-full">
        <div className="flex w-full items-center gap-1.5 text-body-small-default text-[var(--content-tertiary)]">
          <Brain aria-hidden className="h-3.5 w-3.5 shrink-0" />
          <span>{label}</span>
          {streamingIndicator}
        </div>
      </div>
    );
  }

  return (
    <div data-testid="acp-chat-thinking-block" className="w-full">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setOverride(!expanded)}
        data-testid="acp-chat-thinking-toggle"
        className="flex w-full items-center gap-1.5 text-body-small-default text-[var(--content-tertiary)] transition-colors hover:text-[var(--content-secondary)]"
      >
        {expanded ? (
          <ChevronDown aria-hidden className="h-3.5 w-3.5 shrink-0" />
        ) : (
          <ChevronRight aria-hidden className="h-3.5 w-3.5 shrink-0" />
        )}
        <Brain aria-hidden className="h-3.5 w-3.5 shrink-0" />
        <span>{label}</span>
        {streamingIndicator}
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
