/**
 * Pure text-processing functions for dictation profiles.
 *
 * - expandSnippets: pre-LLM, dictation mode only
 * - applyDictionary: post-LLM, dictation + command modes (including fallback paths)
 */

import type {
  DictationDictionaryEntry,
  DictationSnippet,
} from "./dictation-profile-store.js";

/** Escape a string for safe use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Wrap an escaped pattern with word boundaries.
 *
 * Standard \b only works when the boundary is between a word char (\w) and a non-word char.
 * For triggers like "C++" that start/end with non-word chars, we use lookahead/lookbehind
 * for whitespace, punctuation, or string boundaries so matches work in contexts like
 * "C++," or "(C++)".
 */
function wrapWordBoundary(
  escapedPattern: string,
  originalTrigger: string,
): string {
  const startsWithWord = /^\w/.test(originalTrigger);
  const endsWithWord = /\w$/.test(originalTrigger);

  // For non-word boundaries, allow whitespace, common punctuation, or string edges
  const prefix = startsWithWord ? "\\b" : "(?<=[\\s,;:!?.()\\[\\]{}\"']|^)";
  const suffix = endsWithWord ? "\\b" : "(?=[\\s,;:!?.()\\[\\]{}\"']|$)";

  return `${prefix}${escapedPattern}${suffix}`;
}

/**
 * Expand snippet triggers in text before sending to the LLM.
 *
 * - Only enabled snippets are considered
 * - Sorted by trigger length descending (longest match wins)
 * - Case-insensitive whole-word matching
 * - Single-pass: expansions are never re-scanned for further triggers
 */
export function expandSnippets(
  text: string,
  snippets: DictationSnippet[] | undefined,
): string {
  if (!snippets || snippets.length === 0 || !text) return text;

  const enabled = snippets.filter((s) => s.enabled !== false);
  if (enabled.length === 0) return text;

  // Sort by trigger length descending so longest match wins
  const sorted = [...enabled].sort(
    (a, b) => b.trigger.length - a.trigger.length,
  );

  // Build a single alternation pattern for single-pass replacement
  const alternatives = sorted.map((s) =>
    wrapWordBoundary(escapeRegExp(s.trigger), s.trigger),
  );
  const pattern = new RegExp(`(?:${alternatives.join("|")})`, "gi");

  // Build a lookup map (lowercase trigger → expansion)
  const expansionMap = new Map<string, string>();
  for (const s of sorted) {
    const key = s.trigger.toLowerCase();
    // First declared wins (sorted by length, so longest is already first)
    if (!expansionMap.has(key)) {
      expansionMap.set(key, s.expansion);
    }
  }

  return text.replace(pattern, (match) => {
    return expansionMap.get(match.toLowerCase()) ?? match;
  });
}

/**
 * Apply dictionary normalization to text after LLM processing (or on raw fallback).
 *
 * - Sorted by spoken length descending
 * - Respects wholeWord (default true) and caseSensitive (default false) per entry
 * - Single-pass: replacements are never re-scanned
 */
export function applyDictionary(
  text: string,
  dictionary: DictationDictionaryEntry[] | undefined,
): string {
  if (!dictionary || dictionary.length === 0 || !text) return text;

  // Sort by spoken length descending
  const sorted = [...dictionary].sort(
    (a, b) => b.spoken.length - a.spoken.length,
  );

  // Build a single pattern with named-group-free alternation for single-pass replacement
  // Each entry may have different flags, so we group entries by their flag combination
  // For true single-pass, we process all entries in one regex pass using alternation,
  // but since entries can have different case sensitivity, we do case-insensitive matching
  // and check case sensitivity per-match.

  interface EntryWithPattern {
    pattern: string;
    entry: DictationDictionaryEntry;
  }

  const entries: EntryWithPattern[] = sorted.map((entry) => {
    const escaped = escapeRegExp(entry.spoken);
    const wholeWord = entry.wholeWord !== false; // default true
    const pat = wholeWord ? wrapWordBoundary(escaped, entry.spoken) : escaped;
    return { pattern: pat, entry };
  });

  // Build single alternation (case-insensitive to catch all potential matches)
  const combined = new RegExp(
    entries.map((e) => `(${e.pattern})`).join("|"),
    "gi",
  );

  return text.replace(combined, (match, ...groups) => {
    // Find which group matched
    for (let i = 0; i < entries.length; i++) {
      if (groups[i] !== undefined) {
        const { entry } = entries[i];
        const caseSensitive = entry.caseSensitive === true; // default false

        // If case-sensitive, verify exact match
        if (caseSensitive && match !== entry.spoken) {
          return match; // case mismatch, don't replace
        }

        return entry.written;
      }
    }
    return match;
  });
}
