import { useTranslation } from "@/i18n";
import type { DisplayMessage } from "@/domains/chat/types/types";

/**
 * Quiet line for a reaction row, either direction, rendered from the
 * projected reaction fact rather than the row's stored sentinel text.
 * Slack-shaped rows keep their richer Slack transcript line; this covers
 * every other channel and the assistant's own reactions, until the
 * reaction-pill UI replaces both.
 */
export function ReactionLineRow({ message }: { message: DisplayMessage }) {
  const { t } = useTranslation("chat");
  const reaction = message.reaction;
  if (!reaction) {
    return null;
  }
  const key = reaction.selfAuthored
    ? reaction.op === "removed"
      ? "transcript.reactionRemovedSelf"
      : "transcript.reactionAddedSelf"
    : reaction.op === "removed"
      ? "transcript.reactionRemoved"
      : "transcript.reactionAdded";
  return (
    <div
      data-testid="reaction-line-row"
      className="text-body-small-default text-[var(--content-tertiary)] italic"
    >
      {t(key, {
        emoji: reaction.emoji,
        name: reaction.actorDisplayName ?? t("transcript.reactionSomeone"),
      })}
    </div>
  );
}
