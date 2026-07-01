import type { ConversationMessageReaction } from "@vellumai/assistant-api";

import { Tooltip } from "@vellumai/design-library";
import { USER_REACTION_ACTOR } from "@/domains/chat/hooks/use-message-reactions";

interface MessageReactionsProps {
  reactions: ConversationMessageReaction[];
  /** Display name used in the hover tooltip when the actor is the assistant. */
  assistantDisplayName?: string | null;
  /** When provided, the user's own reaction chips become buttons that
   *  invoke this handler (used to remove a reaction on click). */
  onUserReactionClick?: (reaction: ConversationMessageReaction) => void;
  className?: string;
}

const CHIP_CLASS =
  "inline-flex h-6 items-center rounded-full border border-[var(--border-subtle)] bg-[var(--surface-lift)] px-2 text-[13px] leading-none shadow-sm";

const TOOLTIP_DELAY_MS = 150;

// A reaction placed within this window animates in with the tapback pop.
// Older reactions render statically so virtualized remounts and history
// loads don't replay the entrance.
const POP_ANIMATION_FRESHNESS_MS = 5_000;

function chipClass(reaction: ConversationMessageReaction): string {
  const isFresh =
    Date.now() - reaction.createdAt < POP_ANIMATION_FRESHNESS_MS;
  return isFresh
    ? `${CHIP_CLASS} motion-safe:animate-[reaction-pop_320ms_ease-out_both]`
    : CHIP_CLASS;
}

/**
 * Emoji reactions attached to a message (the assistant reacting to a user
 * message via `send_reaction`, or the user reacting to an assistant
 * message), rendered as a row of small pills. On user messages the row is
 * absolutely anchored to the bubble's top-left corner (tapback-style, via
 * `className`); on assistant messages it flows under the content.
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
    <div className={`flex gap-1 ${className ?? ""}`}>
      {reactions.map((reaction) => {
        const isOwn = reaction.actor === USER_REACTION_ACTOR;
        const key = `${reaction.actor}-${reaction.emoji}`;
        if (isOwn && onUserReactionClick) {
          return (
            <Tooltip
              key={key}
              content={`You reacted with ${reaction.emoji} — click to remove`}
              delayDuration={TOOLTIP_DELAY_MS}
            >
              <button
                type="button"
                onClick={() => onUserReactionClick(reaction)}
                aria-label={`Remove your ${reaction.emoji} reaction`}
                className={`${chipClass(reaction)} cursor-pointer transition-colors hover:border-[var(--border-element)] hover:bg-[var(--surface-active)]`}
              >
                {reaction.emoji}
              </button>
            </Tooltip>
          );
        }
        const actorLabel = isOwn
          ? "You"
          : reaction.actor === "assistant"
            ? (assistantDisplayName ?? "Assistant")
            : reaction.actor;
        return (
          <Tooltip
            key={key}
            content={`${actorLabel} reacted with ${reaction.emoji}`}
            delayDuration={TOOLTIP_DELAY_MS}
          >
            <span className={chipClass(reaction)}>{reaction.emoji}</span>
          </Tooltip>
        );
      })}
    </div>
  );
}
