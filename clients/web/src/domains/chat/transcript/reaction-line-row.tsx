import { useEmojiLookup } from "@/domains/chat/components/chat-composer/emoji-catalog";
import type { DisplayMessage } from "@/domains/chat/types/types";
import { useTranslation } from "@/i18n";

/**
 * Display form of a reaction emoji: a unicode emoji renders as itself, a
 * shortcode resolves through the emoji catalog (":shortcode:" fallback the
 * way the Slack reaction line renders), and Discord's custom-emoji mention
 * form surfaces as its bare ":name:" rather than raw "<:name:id>" markup.
 */
function displayEmoji(
  raw: string,
  lookup: (shortcode: string) => string | undefined,
): string {
  const customMention = /^<a?:([^:>]+):\d+>$/.exec(raw);
  if (customMention) {
    return lookup(customMention[1]!) ?? `:${customMention[1]!}:`;
  }
  if (/^[\w+'-]+$/.test(raw)) {
    return lookup(raw) ?? `:${raw}:`;
  }
  return raw;
}

/**
 * Quiet line for a reaction row, either direction, rendered from the
 * projected reaction fact rather than the row's stored sentinel text.
 * Slack-shaped rows keep their richer Slack transcript line; this covers
 * every other channel and the assistant's own reactions, until the
 * reaction-pill UI replaces both.
 */
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
        emoji: displayEmoji(reaction.emoji, lookupEmoji),
        name: reaction.actorDisplayName ?? t("transcript.reactionSomeone"),
      })}
    </div>
  );
}
