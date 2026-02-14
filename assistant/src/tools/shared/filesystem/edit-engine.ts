import { findAllMatches, adjustIndentation } from '../../filesystem/fuzzy-match.js';
import type { MatchMethod } from '../../filesystem/fuzzy-match.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EditEngineInput {
  content: string;
  oldString: string;
  newString: string;
  replaceAll: boolean;
}

export type EditEngineResult =
  | { ok: true; updatedContent: string; matchCount: number; matchMethod: MatchMethod }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'ambiguous'; matchCount: number };

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * Pure match-and-replace logic shared by sandbox and host filesystem edit
 * tools, and the executor's preview-diff computation.
 *
 * Cascading strategy:
 *   1. replace_all  -- exact indexOf across the whole content
 *   2. single match -- exact -> whitespace-normalised -> fuzzy (via findAllMatches)
 */
export function applyEdit(input: EditEngineInput): EditEngineResult {
  const { content, oldString, newString, replaceAll } = input;

  if (replaceAll) {
    const firstIndex = content.indexOf(oldString);
    if (firstIndex === -1) {
      return { ok: false, reason: 'not_found' };
    }
    const parts = content.split(oldString);
    const matchCount = parts.length - 1;
    const updatedContent = parts.join(newString);
    return { ok: true, updatedContent, matchCount, matchMethod: 'exact' };
  }

  // Single-match path: cascading exact -> whitespace -> fuzzy
  const matches = findAllMatches(content, oldString);
  if (matches.length === 0) {
    return { ok: false, reason: 'not_found' };
  }
  if (matches.length > 1) {
    return { ok: false, reason: 'ambiguous', matchCount: matches.length };
  }

  const match = matches[0];
  const adjustedNewString = match.method !== 'exact'
    ? adjustIndentation(oldString, match.matched, newString)
    : newString;

  const updatedContent = content.slice(0, match.start) + adjustedNewString + content.slice(match.end);
  return { ok: true, updatedContent, matchCount: 1, matchMethod: match.method };
}
