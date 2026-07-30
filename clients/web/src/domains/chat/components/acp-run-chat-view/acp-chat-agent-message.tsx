/**
 * A streamed agent response in the ACP chat transcript. Left-aligned and
 * full-width with no bubble. A trailing `ThreeDotIndicator` marks the block as
 * still streaming.
 */

import { ChatMarkdownMessage } from "@/domains/chat/components/chat-markdown-message";
import { ThreeDotIndicator } from "@/domains/chat/components/tool-progress-card/three-dot-indicator";

export interface AcpChatAgentMessageProps {
  /** Markdown body of the agent message. */
  content: string;
  /** When false the block is still streaming; shows a trailing indicator. */
  isComplete: boolean;
  /**
   * Assistant that owns the run's parent conversation. Lets workspace file
   * references in the agent's message resolve against its workspace (inline
   * media, file cards, download) instead of degrading to an inert card.
   */
  assistantId?: string | null;
}

export function AcpChatAgentMessage({
  content,
  isComplete,
  assistantId,
}: AcpChatAgentMessageProps) {
  return (
    <div
      data-testid="acp-chat-agent-message"
      className="flex w-full flex-col items-start text-chat text-[var(--content-default)]"
    >
      <ChatMarkdownMessage content={content} assistantId={assistantId} />
      {!isComplete && (
        <ThreeDotIndicator
          className="mt-1"
          data-testid="acp-chat-agent-streaming"
        />
      )}
    </div>
  );
}
