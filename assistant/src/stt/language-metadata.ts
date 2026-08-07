/**
 * Pure helpers for tallying and ranking detected-language tags emitted
 * by streaming STT providers (e.g. Deepgram nova-3 `multi` per-word tags).
 *
 * Tag normalization is `baseLanguageSubtag` (util/language-subtag.ts);
 * these helpers layer vote-counting on top of it so provider adapters and
 * event consumers share one notion of a dominant language.
 */

import { baseLanguageSubtag } from "../util/language-subtag.js";

/**
 * Cast one vote into a language tally for a transcript chunk's dominant
 * detected language. `languages` is dominance-ranked, so only the first
 * entry votes: secondary tags at full weight would let a minority
 * language outvote the dominant one. Blank and absent tags cast no vote;
 * regional variants count toward their base subtag.
 */
export function voteDominantLanguage(
  tally: Map<string, number>,
  languages: readonly string[] | undefined,
): void {
  const dominant = baseLanguageSubtag(languages?.[0]);
  if (dominant !== undefined) {
    tally.set(dominant, (tally.get(dominant) ?? 0) + 1);
  }
}

/**
 * The dominant tag in a language tally: most votes wins, ties break by
 * first insertion (Map iteration is insertion order). Undefined for an
 * empty tally.
 */
export function dominantLanguageTag(
  tally: ReadonlyMap<string, number>,
): string | undefined {
  let dominant: string | undefined;
  let dominantCount = 0;
  for (const [tag, count] of tally) {
    if (count > dominantCount) {
      dominant = tag;
      dominantCount = count;
    }
  }
  return dominant;
}

/**
 * Tally normalized language tags and return them most-frequent-first.
 * Ties are broken by first appearance in the input. Blank tags are
 * skipped; regional variants count toward their base subtag.
 */
export function rankLanguages(tags: Iterable<string>): string[] {
  // Map iteration order is insertion order, so a stable sort by count
  // leaves tied tags in first-appearance order.
  const counts = new Map<string, number>();
  for (const tag of tags) {
    const normalized = baseLanguageSubtag(tag);
    if (normalized === undefined) {
      continue;
    }
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([tag]) => tag);
}
