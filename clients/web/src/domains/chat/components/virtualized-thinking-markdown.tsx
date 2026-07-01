import { useCallback, useMemo } from "react";

import { VirtualList } from "@vellumai/design-library";

import { ChatMarkdownMessage } from "@/domains/chat/components/chat-markdown-message";
import { splitThinkingMarkdownChunks } from "@/domains/chat/utils/thinking-markdown-chunks";

const INITIAL_RENDERED_CHUNKS = 8;

export interface VirtualizedThinkingMarkdownProps {
  content: string;
}

export function VirtualizedThinkingMarkdown({
  content,
}: VirtualizedThinkingMarkdownProps) {
  const chunks = useMemo(() => splitThinkingMarkdownChunks(content), [content]);
  const itemContent = useCallback(
    (_index: number, chunk: string) => (
      <div className="pb-3 last:pb-0">
        <ChatMarkdownMessage content={chunk} hardLineBreaks />
      </div>
    ),
    [],
  );
  const computeItemKey = useCallback((index: number) => index, []);

  if (chunks.length === 0) return null;

  return (
    <VirtualList
      items={chunks}
      itemContent={itemContent}
      computeItemKey={computeItemKey}
      className="h-full bg-transparent"
      initialItemCount={Math.min(chunks.length, INITIAL_RENDERED_CHUNKS)}
      increaseViewportBy={{ top: 400, bottom: 800 }}
    />
  );
}
