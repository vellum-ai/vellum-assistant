/**
 * Collapsible card that renders an LLM reasoning ("thinking") block in the
 * chat transcript. Mirrors the macOS `ThinkingBlockView`: starts collapsed,
 * shows "Thinking…" while the model is still streaming reasoning and
 * "Thought process" once complete.
 *
 * Expansion state lives in `useChatSessionStore.expandedThinkingKeys` — a
 * Zustand-managed Map keyed by a stable `expansionKey`. The store action
 * produces a new Map instance on toggle, so this component re-renders
 * reactively via its selector without needing a local useState mirror.
 * Markdown is rendered only while expanded (Radix unmounts collapsed
 * content), so the parse cost is paid lazily on demand.
 */

import { Brain, ChevronDown, ChevronUp } from "lucide-react";

import { ChatMarkdownMessage } from "@/domains/chat/components/chat-markdown-message";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { Collapsible } from "@vellumai/design-library";

export interface ThinkingBlockProps {
  /** The accumulated reasoning text (markdown). */
  content: string;
  /** Whether the reasoning is still streaming in (drives the header label). */
  isStreaming: boolean;
  /**
   * Stable identity for this block's expansion state — typically the owning
   * message id combined with the block's position in `contentOrder`.
   */
  expansionKey: string;
}

export function ThinkingBlock({
  content,
  isStreaming,
  expansionKey,
}: ThinkingBlockProps) {
  const isExpanded = useChatSessionStore(
    (s) => s.expandedThinkingKeys.get(expansionKey) ?? false,
  );

  const handleValueChange = (value: string) => {
    const next = value === expansionKey;
    useChatSessionStore.getState().toggleExpandedThinkingKey(expansionKey, next);
  };

  return (
    <Collapsible.Root
      type="single"
      collapsible
      value={isExpanded ? expansionKey : ""}
      onValueChange={handleValueChange}
      className="w-full overflow-hidden rounded-md bg-[var(--surface-overlay)]"
    >
      <Collapsible.Item value={expansionKey}>
        <Collapsible.Trigger className="gap-2 px-3 py-1.5 text-[var(--content-secondary)]">
          <Brain className="size-3 shrink-0" aria-hidden />
          <span className="text-[13px] font-medium">
            {isStreaming ? "Thinking…" : "Thought process"}
          </span>
          {isExpanded ? (
            <ChevronUp
              className="ml-auto size-3 shrink-0 text-[var(--content-tertiary)]"
              aria-hidden
            />
          ) : (
            <ChevronDown
              className="ml-auto size-3 shrink-0 text-[var(--content-tertiary)]"
              aria-hidden
            />
          )}
        </Collapsible.Trigger>
        <Collapsible.Content>
          <div className="border-t border-[var(--surface-lift)] px-3 py-2 text-[13px] text-[var(--content-secondary)]">
            <ChatMarkdownMessage content={content} hardLineBreaks />
          </div>
        </Collapsible.Content>
      </Collapsible.Item>
    </Collapsible.Root>
  );
}
