/**
 * Pure helpers for normalizing and ranking detected-language tags emitted
 * by streaming STT providers (e.g. Deepgram nova-3 `multi` per-word tags).
 *
 * Dependency-free leaf so provider adapters and event consumers can share
 * one notion of a normalized language tag without coupling to each other.
 */

/**
 * Normalize a BCP-47 language tag to its lowercase base subtag:
 * "en-US" -> "en", "PT-br" -> "pt". Returns "" for blank input.
 */
export function normalizeLanguageTag(tag: string): string {
  return tag.trim().toLowerCase().split("-")[0] ?? "";
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
    const normalized = normalizeLanguageTag(tag);
    if (!normalized) {
      continue;
    }
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([tag]) => tag);
}
