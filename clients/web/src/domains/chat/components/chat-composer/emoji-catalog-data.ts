/**
 * The emoji catalog behind the composer's `:shortcode` autocomplete, built at
 * load time from emojibase with Slack's names.
 *
 * Colon-codes like `:tada:` are a chat convention rather than a standard, and
 * every platform keeps its own spelling list. This catalog uses Slack's
 * (emojibase's `iamcal` preset), since that is the list the Slack channel
 * accepts back and the only one already in play here. Search terms come from
 * the dataset's tags and labels, which derive from Unicode's own names.
 *
 * Reaction rendering does not depend on this: a channel's adapter says what
 * a reaction's emoji is, and the web renders that.
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

export const EMOJI_CATALOG: EmojiEntry[] = (compact as CompactEmoji[])
  .flatMap((entry) =>
    namesOf(entry.hexcode).map((shortcode) => ({
      shortcode,
      emoji: entry.unicode,
      aliases: aliasesOf(entry, shortcode),
    })),
  )
  .sort((a, b) =>
    a.shortcode < b.shortcode ? -1 : a.shortcode > b.shortcode ? 1 : 0,
  );

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
