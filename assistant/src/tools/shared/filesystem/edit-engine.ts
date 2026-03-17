import type { MatchMethod } from "../../filesystem/fuzzy-match.js";
import {
  adjustIndentation,
  findAllMatches,
} from "../../filesystem/fuzzy-match.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EditEngineResult =
  | {
      ok: true;
      updatedContent: string;
      matchCount: number;
      matchMethod: MatchMethod;
      similarity: number;
      actualOld: string;
      actualNew: string;
    }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "ambiguous"; matchCount: number };

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * Core match/replace logic shared by both sandbox and host edit tools,
 * and by the executor's preview-diff computation.
 *
 * This function is pure - it takes file content and edit parameters and
 * returns the result without performing any I/O.
 */
export function applyEdit(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): EditEngineResult {
  if (replaceAll) {
    const firstIndex = content.indexOf(oldString);
    if (firstIndex === -1) {
      return { ok: false, reason: "not_found" };
    }
    const count = content.split(oldString).length - 1;
    const updatedContent = content.split(oldString).join(newString);
    return {
      ok: true,
      updatedContent,
      matchCount: count,
      matchMethod: "exact",
      similarity: 1,
      actualOld: oldString,
      actualNew: newString,
    };
  }

  // Single-match path: cascading exact -> whitespace -> fuzzy
  const matches = findAllMatches(content, oldString);
  if (matches.length === 0) {
    return { ok: false, reason: "not_found" };
  }
  if (matches.length > 1) {
    return { ok: false, reason: "ambiguous", matchCount: matches.length };
  }

  const match = matches[0];
  const adjustedNewString =
    match.method !== "exact"
      ? adjustIndentation(oldString, match.matched, newString)
      : newString;

  const updatedContent =
    content.slice(0, match.start) +
    adjustedNewString +
    content.slice(match.end);
  return {
    ok: true,
    updatedContent,
    matchCount: 1,
    matchMethod: match.method,
    similarity: match.similarity,
    actualOld: match.matched,
    actualNew: adjustedNewString,
  };
}
