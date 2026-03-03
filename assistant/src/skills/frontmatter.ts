/**
 * Shared frontmatter parsing for SKILL.md files.
 *
 * Frontmatter is a YAML-like block delimited by `---` at the top of a file.
 * This module provides a single implementation used by the skill catalog loader
 * and the CC command registry.
 */

/** Matches a `---` delimited frontmatter block at the start of a file. */
export const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

export interface FrontmatterParseResult {
  /** Key-value pairs extracted from the frontmatter block. */
  fields: Record<string, string>;
  /** The remaining file content after the frontmatter block. */
  body: string;
}

/**
 * Parse frontmatter fields from file content.
 *
 * Extracts key-value pairs from the `---` delimited block at the top of the
 * file. Handles single- and double-quoted values, and unescapes common escape
 * sequences (`\n`, `\r`, `\\`, `\"`) in double-quoted values.
 *
 * Returns `null` if no frontmatter block is found.
 */
export function parseFrontmatterFields(
  content: string,
): FrontmatterParseResult | null {
  const match = content.match(FRONTMATTER_REGEX);
  if (!match) return null;

  const frontmatter = match[1];
  const fields: Record<string, string> = {};

  const lines = frontmatter.split(/\r?\n/);
  let currentKey: string | undefined;
  let continuationLines: string[] = [];

  function flushContinuation() {
    if (currentKey !== undefined) {
      if (continuationLines.length > 0) {
        // Join continuation lines, then strip trailing commas before closing
        // braces/brackets so that prettier-formatted JSON remains valid for JSON.parse.
        fields[currentKey] = continuationLines
          .map((l) => l.trim())
          .join(" ")
          .replace(/,\s*([}\]])/g, "$1");
      } else {
        fields[currentKey] = "";
      }
    }
    currentKey = undefined;
    continuationLines = [];
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Continuation line: indented and no top-level key: pattern
    // (i.e. starts with whitespace and either has no colon or the colon
    // is inside braces/quotes — heuristic: line starts with space/tab)
    if (currentKey !== undefined && /^\s/.test(line)) {
      continuationLines.push(trimmed);
      continue;
    }

    // Flush any pending multiline value
    flushContinuation();

    const separatorIndex = trimmed.indexOf(":");
    if (separatorIndex === -1) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();

    if (!value) {
      // Value may continue on subsequent indented lines
      currentKey = key;
      continuationLines = [];
      continue;
    }

    const isDoubleQuoted = value.startsWith('"') && value.endsWith('"');
    const isSingleQuoted = value.startsWith("'") && value.endsWith("'");
    if (isDoubleQuoted || isSingleQuoted) {
      value = value.slice(1, -1);
      if (isDoubleQuoted) {
        // Unescape sequences produced by buildSkillMarkdown's esc().
        // Only for double-quoted values — single-quoted YAML treats backslashes literally.
        // Single-pass to avoid misinterpreting \\n (escaped backslash + n) as a newline.
        value = value.replace(/\\(["\\nr])/g, (_, ch) => {
          if (ch === "n") return "\n";
          if (ch === "r") return "\r";
          return ch; // handles \\ → \ and \" → "
        });
      }
    }
    fields[key] = value;
  }

  // Flush any trailing multiline value
  flushContinuation();

  return { fields, body: content.slice(match[0].length) };
}
