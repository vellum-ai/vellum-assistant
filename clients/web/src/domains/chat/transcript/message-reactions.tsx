import type { ConversationMessageReaction } from "@vellumai/assistant-api";

import { USER_REACTION_ACTOR } from "@/domains/chat/hooks/use-message-reactions";

interface MessageReactionsProps {
  reactions: ConversationMessageReaction[];
  /** Display name used in the hover title when the actor is the assistant. */
  assistantDisplayName?: string | null;
  /** When provided, the user's own reaction chips become buttons that
   *  invoke this handler (used to remove a reaction on click). */
  onUserReactionClick?: (reaction: ConversationMessageReaction) => void;
  className?: string;
}

const CHIP_CLASS =
  "inline-flex h-6 items-center rounded-full border border-[var(--border-subtle)] bg-[var(--surface-lift)] px-2 text-[13px] leading-none shadow-sm";

/**
 * Emoji reactions attached to a message (the assistant reacting to a user
 * message via `send_reaction`, or the user reacting to an assistant
 * message), rendered as a row of small pills nestled under the bubble like
 * chat-app reactions.
 */
export function MessageReactions({
  reactions,
  assistantDisplayName,
  onUserReactionClick,
  className,
}: MessageReactionsProps) {
  if (reactions.length === 0) {
    return null;
  }
  return (
    <div className={`flex flex-wrap gap-1 ${className ?? ""}`}>
      {reactions.map((reaction) => {
        const isOwn = reaction.actor === USER_REACTION_ACTOR;
        const key = `${reaction.actor}-${reaction.emoji}`;
        if (isOwn && onUserReactionClick) {
          return (
            <button
              key={key}
              type="button"
              onClick={() => onUserReactionClick(reaction)}
              title={`You reacted with ${reaction.emoji} — click to remove`}
              className={`${CHIP_CLASS} cursor-pointer transition-colors hover:border-[var(--border-element)] hover:bg-[var(--surface-active)]`}
            >
              {reaction.emoji}
            </button>
          );
        }
        const actorLabel = isOwn
          ? "You"
          : reaction.actor === "assistant"
            ? (assistantDisplayName ?? "Assistant")
            : reaction.actor;
        return (
          <span
            key={key}
            className={CHIP_CLASS}
            title={`${actorLabel} reacted with ${reaction.emoji}`}
          >
            {reaction.emoji}
          </span>
        );
      })}
    </div>
  );
}
