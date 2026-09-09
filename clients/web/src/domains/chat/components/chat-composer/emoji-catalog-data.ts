/**
 * The emoji catalog, built at load time from emojibase with Slack's names.
 *
 * Slack reports a reaction by its short name (`tada`, `+1`,
 * `thumbsup::skin-tone-3`) rather than by character, and its names are its
 * own list, not Unicode's. emojibase ships that list as the `iamcal`
 * shortcode preset, so a name Slack sends resolves to the character Slack
 * shows, flags and skin tones included. The composer's `:shortcode`
 * autocomplete searches the same names, so what a person types here is what
 * Slack accepts back.
 *
 * Loaded lazily by `emoji-catalog.ts`, which keeps the dataset out of the
 * initial bundle.
 */
import type { CompactEmoji } from "emojibase";
import compact from "emojibase-data/en/compact.json" with { type: "json" };
import slackNames from "emojibase-data/en/shortcodes/iamcal.json" with { type: "json" };

export interface EmojiEntry {
  shortcode: string;
  emoji: string;
  aliases: string[];
}

/** Slack spells a skin tone as `name::skin-tone-N`, N from 2 to 6. */
const SKIN_TONE_SUFFIX = /^(.+)::skin-tone-([2-6])$/;
const SKIN_TONE_MODIFIERS = ["1F3FB", "1F3FC", "1F3FD", "1F3FE", "1F3FF"];

const STOPWORDS = new Set(["and", "the", "with", "face", "flag"]);

function namesOf(hexcode: string): string[] {
  const names = (slackNames as Record<string, string | string[]>)[hexcode];
  return names === undefined ? [] : Array.isArray(names) ? names : [names];
}

/** Search terms: the dataset's tags plus the words of its label. */
function aliasesOf(entry: CompactEmoji, own: string): string[] {
  const words = entry.label
    .toLowerCase()
    .split(/[\s:,()-]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  return Array.from(new Set([...(entry.tags ?? []), ...words])).filter(
    (alias) => alias !== own,
  );
}

const entryByName = new Map<string, CompactEmoji>();

export const EMOJI_CATALOG: EmojiEntry[] = (compact as CompactEmoji[])
  .flatMap((entry) =>
    namesOf(entry.hexcode).map((shortcode) => {
      entryByName.set(shortcode, entry);
      return {
        shortcode,
        emoji: entry.unicode,
        aliases: aliasesOf(entry, shortcode),
      };
    }),
  )
  .sort((a, b) =>
    a.shortcode < b.shortcode ? -1 : a.shortcode > b.shortcode ? 1 : 0,
  );

/**
 * The character for a Slack emoji name, or undefined when Slack has no such
 * standard name (a workspace's custom emoji). A skin tone suffix resolves to
 * the variant carrying exactly that tone, which for a multi-person emoji
 * places the modifier inside the sequence; an emoji without variants keeps
 * its base character.
 */
export function lookupEmoji(name: string): string | undefined {
  const toned = SKIN_TONE_SUFFIX.exec(name);
  const entry = entryByName.get(toned ? toned[1]! : name);
  if (!entry) {
    return undefined;
  }
  if (!toned) {
    return entry.unicode;
  }
  const modifier = SKIN_TONE_MODIFIERS[Number(toned[2]) - 2]!;
  const skin = entry.skins?.find((s) => {
    const modifiers = s.hexcode
      .split("-")
      .filter((h) => SKIN_TONE_MODIFIERS.includes(h));
    return modifiers.length === 1 && modifiers[0] === modifier;
  });
  return skin?.unicode ?? entry.unicode;
}

/**
 * Returns emoji entries matching `query` (case-insensitive), capped at `limit`.
 * Ranking: shortcode prefix, then shortcode substring, then alias prefix,
 * then alias substring. Each shortcode appears at most once in the result.
 */
export function searchEmoji(query: string, limit = 8): EmojiEntry[] {
  if (!query) {
    return EMOJI_CATALOG.slice(0, limit);
  }
  const lower = query.toLowerCase();
  const shortcodePrefix: EmojiEntry[] = [];
  const shortcodeSubstring: EmojiEntry[] = [];
  const aliasPrefix: EmojiEntry[] = [];
  const aliasSubstring: EmojiEntry[] = [];
  const seen = new Set<string>();
  for (const entry of EMOJI_CATALOG) {
    if (entry.shortcode.startsWith(lower)) {
      shortcodePrefix.push(entry);
      seen.add(entry.shortcode);
    } else if (entry.shortcode.includes(lower)) {
      shortcodeSubstring.push(entry);
      seen.add(entry.shortcode);
    }
  }
  for (const entry of EMOJI_CATALOG) {
    if (seen.has(entry.shortcode)) {
      continue;
    }
    let sawPrefix = false;
    let sawSubstring = false;
    for (const alias of entry.aliases) {
      if (alias.startsWith(lower)) {
        sawPrefix = true;
        break;
      }
      if (alias.includes(lower)) {
        sawSubstring = true;
      }
    }
    if (sawPrefix) {
      aliasPrefix.push(entry);
    } else if (sawSubstring) {
      aliasSubstring.push(entry);
    }
  }
  return [
    ...shortcodePrefix,
    ...shortcodeSubstring,
    ...aliasPrefix,
    ...aliasSubstring,
  ].slice(0, limit);
}
