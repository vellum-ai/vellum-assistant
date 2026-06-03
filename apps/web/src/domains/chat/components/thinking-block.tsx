/**
 * Collapsible card that renders an LLM reasoning ("thinking") block in the
 * chat transcript. Mirrors the macOS `ThinkingBlockView`: starts collapsed,
 * shows "Thinking…" while the model is still streaming reasoning and
 * "Thought process" once complete.
 *
 * Expansion state is owned by the caller via a persistent
 * `expandedThinkingKeys` map (keyed by a stable `expansionKey`) so a user's
 * expand/collapse choice survives the transcript virtualization unmounts
 * that would otherwise reset local component state — the web analogue of
 * macOS's injected `ThinkingBlockExpansionStore`. Markdown is rendered only
 * while expanded (Radix unmounts collapsed content), so the parse cost is
 * paid lazily on demand rather than for every collapsed block.
 */

import { useState } from "react";
import { Brain, ChevronDown, ChevronUp } from "lucide-react";

import { Collapsible } from "@vellum/design-library";
import { ChatMarkdownMessage } from "@/domains/chat/components/chat-markdown-message";

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
  /**
   * Caller-owned persistence for expand/collapse state, surviving transcript
   * remounts. Mutated in place; the component mirrors writes into local state
   * so a toggle re-renders.
   */
  expandedThinkingKeys: Map<string, boolean>;
}

export function ThinkingBlock({
  content,
  isStreaming,
  expansionKey,
  expandedThinkingKeys,
}: ThinkingBlockProps) {
  // `localToggle` mirrors the map mutation so React re-renders on click —
  // mutating the persistent map alone wouldn't trigger one. Thinking blocks
  // default collapsed (matching macOS), so an absent value reads as closed.
  const [localToggle, setLocalToggle] = useState<boolean | undefined>(
    undefined,
  );
  const persisted = expandedThinkingKeys.get(expansionKey);
  const isExpanded = (localToggle ?? persisted) ?? false;

  const handleValueChange = (value: string) => {
    const next = value === expansionKey;
    setLocalToggle(next);
    expandedThinkingKeys.set(expansionKey, next);
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
