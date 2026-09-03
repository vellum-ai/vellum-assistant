/**
 * The one place a reaction's typed emoji becomes something a reader sees.
 *
 * Two readers, one resolution. A person reads `display`: the character
 * itself, or `:name:` for a name nothing here resolves (a workspace or
 * server custom emoji, whose image is the channel's to serve). The model
 * reads `channelForm`, which is the same string except for a custom emoji
 * with an id, where it is the channel's own mention form, because that is
 * what `react_to_message` hands back to the channel.
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
  /**
   * What the model reads, and can hand back to `react_to_message` as is:
   * the character, `:name:` for an unresolved name, or the channel's
   * mention form for a custom emoji with an id.
   */
  channelForm: string;
}

/** Slack spells a skin tone as `name::skin-tone-N`, N from 2 to 6. */
const SKIN_TONE_SUFFIX = /^(.+)::skin-tone-([2-6])$/;

/** U+FE0F, which a reader may omit from a fully qualified character. */
const VARIATION_SELECTOR = /\uFE0F/g;

type TableRow = (typeof REACTION_EMOJI_TABLE)[number];

let rowByName: Map<string, TableRow> | undefined;
let nameByCharacter: Map<string, string> | undefined;

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
 * Character to primary name, toned variants included. Each character is
 * indexed both as spelled and without its variation selector, first row
 * wins, so a reader that drops U+FE0F still resolves.
 */
function namesByCharacter(): Map<string, string> {
  if (!nameByCharacter) {
    const index = new Map<string, string>();
    const learn = (character: string, name: string) => {
      for (const key of [
        character,
        character.replace(VARIATION_SELECTOR, ""),
      ]) {
        if (!index.has(key)) {
          index.set(key, name);
        }
      }
    };
    for (const row of REACTION_EMOJI_TABLE) {
      const primary = row.names[0]!;
      learn(row.emoji, primary);
      row.skins?.forEach((skin, i) =>
        learn(skin, `${primary}::skin-tone-${i + 2}`),
      );
    }
    nameByCharacter = index;
  }
  return nameByCharacter;
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

/**
 * The shortcode name for a character, skin tone suffix included, or
 * undefined when the character is not in the table.
 */
export function shortcodeForEmojiCharacter(
  character: string,
): string | undefined {
  return namesByCharacter().get(character);
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
      return { display: name, channelForm: name };
    case "custom": {
      const display = `:${name}:`;
      return {
        display,
        channelForm: typed.emojiId
          ? `<${typed.emojiAnimated ? "a" : ""}:${name}:${typed.emojiId}>`
          : display,
      };
    }
    case "shortcode": {
      const resolved = emojiCharacterForShortcode(name) ?? `:${name}:`;
      return { display: resolved, channelForm: resolved };
    }
  }
}
