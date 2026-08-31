import { useEmojiLookup } from "@/domains/chat/components/chat-composer/emoji-catalog";
import { displayReactionEmoji } from "@/domains/chat/transcript/transcript-message-body-shared";
import type { DisplayMessage } from "@/domains/chat/types/types";
import { useTranslation } from "@/i18n";

export function ReactionLineRow({ message }: { message: DisplayMessage }) {
  const { t } = useTranslation("chat");
  const lookupEmoji = useEmojiLookup();
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
        emoji: displayReactionEmoji(reaction.emoji, lookupEmoji),
        name: reaction.actorDisplayName ?? t("transcript.reactionSomeone"),
      })}
    </div>
  );
}
