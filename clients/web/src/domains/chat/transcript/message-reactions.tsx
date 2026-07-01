import type { ConversationMessageReaction } from "@vellumai/assistant-api";

interface MessageReactionsProps {
  reactions: ConversationMessageReaction[];
  /** Display name used in the hover title when the actor is the assistant. */
  assistantDisplayName?: string | null;
  className?: string;
}

/**
 * Emoji reactions attached to a message (e.g. the assistant reacting to a
 * user message via `send_reaction`), rendered as a row of small pills
 * nestled under the bubble like chat-app reactions.
 */
export function MessageReactions({
  reactions,
  assistantDisplayName,
  className,
}: MessageReactionsProps) {
  if (reactions.length === 0) {
    return null;
  }
  return (
    <div className={`flex flex-wrap gap-1 ${className ?? ""}`}>
      {reactions.map((reaction) => {
        const actorLabel =
          reaction.actor === "assistant"
            ? (assistantDisplayName ?? "Assistant")
            : reaction.actor;
        return (
          <span
            key={`${reaction.actor}-${reaction.emoji}`}
            className="inline-flex h-6 items-center rounded-full border border-[var(--border-subtle)] bg-[var(--surface-lift)] px-2 text-[13px] leading-none shadow-sm"
            title={`${actorLabel} reacted with ${reaction.emoji}`}
          >
            {reaction.emoji}
          </span>
        );
      })}
    </div>
  );
}
