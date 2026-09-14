/**
 * Slack's emoji dictionary: the short names Slack reports a reaction by,
 * resolved to the standard characters they stand for.
 *
 * Slack sends a reaction as a name (`tada`, `+1`, `thumbsup::skin-tone-3`)
 * rather than as the character, and its names are its own list, not
 * Unicode's. emojibase ships that list as the `iamcal` shortcode preset. A
 * name outside it is a workspace's own upload, which only that workspace can
 * render. This is the one place Slack's naming is known: the gateway's
 * normalizer resolves inbound reactions through it, and everything past an
 * adapter speaks characters.
 */
import type { CompactEmoji } from "emojibase";
import compact from "emojibase-data/en/compact.json" with { type: "json" };
import slackNames from "emojibase-data/en/shortcodes/iamcal.json" with { type: "json" };

/** Slack spells a skin tone as `name::skin-tone-N`, N from 2 to 6. */
const SKIN_TONE_SUFFIX = /^(.+)::skin-tone-([2-6])$/;
const SKIN_TONE_MODIFIERS = ["1F3FB", "1F3FC", "1F3FD", "1F3FE", "1F3FF"];

let entryByName: Map<string, CompactEmoji> | undefined;

function entries(): Map<string, CompactEmoji> {
  if (!entryByName) {
    const names = slackNames as Record<string, string | string[]>;
    entryByName = new Map();
    for (const entry of compact as CompactEmoji[]) {
      const own = names[entry.hexcode];
      for (const name of own === undefined
        ? []
        : Array.isArray(own)
          ? own
          : [own]) {
        entryByName.set(name, entry);
      }
    }
  }
  return entryByName;
}

/**
 * The character for a Slack emoji name, or undefined when Slack has no such
 * standard name. A skin tone suffix resolves to the variant carrying exactly
 * that tone, which for a multi-person emoji places the modifier inside the
 * sequence; an emoji without variants keeps its base character.
 */
export function slackEmojiCharacter(name: string): string | undefined {
  const toned = SKIN_TONE_SUFFIX.exec(name);
  const entry = entries().get(toned ? toned[1]! : name);
  if (!entry) {
    return undefined;
  }
  if (!toned) {
    return entry.unicode;
  }
  const modifier = SKIN_TONE_MODIFIERS[Number(toned[2]) - 2]!;
  // A multi-person emoji repeats the tone for each person; the variant
  // Slack's single suffix names is the one carrying that tone and no other.
  const skin = entry.skins?.find((s) => {
    const modifiers = s.hexcode
      .split("-")
      .filter((h) => SKIN_TONE_MODIFIERS.includes(h));
    return modifiers.length > 0 && modifiers.every((h) => h === modifier);
  });
  return skin?.unicode ?? entry.unicode;
}
