/**
 * The one place a reaction's typed emoji becomes what a person reads: the
 * character itself, or `:name:` for a name nothing here resolves (a
 * workspace or server custom emoji, whose image is the channel's to serve).
 *
 * The table is Slack's own emoji data (`reaction-emoji-table.generated.ts`),
 * so a `shortcode` name resolves to the character the Slack client shows,
 * skin tones included. A row that carries only its spelling has its kind
 * recovered by the same classifier the ingress contract uses, so the
 * reading never branches on channel.
 */
import { classifyReactionEmojiSpelling } from "@vellumai/gateway-client";
import {
  pickReactionEmojiFields,
  type ReactionEmojiFields,
} from "@vellumai/service-contracts/reactions";

import { REACTION_EMOJI_TABLE } from "./reaction-emoji-table.generated.js";

export interface ResolvedReactionEmoji {
  /** What a person reads. */
  display: string;
}

/** Slack spells a skin tone as `name::skin-tone-N`, N from 2 to 6. */
const SKIN_TONE_SUFFIX = /^(.+)::skin-tone-([2-6])$/;

type TableRow = (typeof REACTION_EMOJI_TABLE)[number];

let rowByName: Map<string, TableRow> | undefined;
function rowsByName(): Map<string, TableRow> {
  if (!rowByName) {
    rowByName = new Map(
      REACTION_EMOJI_TABLE.flatMap((row) =>
        row.names.map((name) => [name, row] as const),
      ),
    );
  }
  return rowByName;
}

/**
 * The character for a shortcode name, or undefined when the table has no
 * such name. A skin tone suffix resolves to the toned variant when the
 * emoji has one and to the base character when it does not.
 */
export function emojiCharacterForShortcode(name: string): string | undefined {
  const toned = SKIN_TONE_SUFFIX.exec(name);
  const row = rowsByName().get(toned ? toned[1]! : name);
  if (!row) {
    return undefined;
  }
  return toned ? (row.skins?.[Number(toned[2]) - 2] ?? row.emoji) : row.emoji;
}

export function resolveReactionEmoji(
  reaction: { emoji: string } & ReactionEmojiFields,
): ResolvedReactionEmoji {
  const typed: ReturnType<typeof classifyReactionEmojiSpelling> =
    reaction.emojiKind !== undefined && reaction.emojiName !== undefined
      ? {
          ...pickReactionEmojiFields(reaction),
          emojiKind: reaction.emojiKind,
          emojiName: reaction.emojiName,
        }
      : classifyReactionEmojiSpelling(reaction.emoji);
  const name = typed.emojiName;
  switch (typed.emojiKind) {
    case "unicode":
      return { display: name };
    case "custom":
      return { display: `:${name}:` };
    case "shortcode":
      return { display: emojiCharacterForShortcode(name) ?? `:${name}:` };
  }
}
