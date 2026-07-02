/**
 * Frontmatter parsing for memory's concept-page and card `.md` files.
 *
 * Frontmatter is a YAML block delimited by `---` at the top of a file. Memory
 * owns this parser rather than importing the host `skills/` copy so the plugin
 * depends only on its own files, `@vellumai/plugin-api`, and external packages.
 */

import { parse as parseYaml } from "yaml";

import { getLogger } from "../../../util/logger.js";

const log = getLogger("memory-frontmatter");

/** Matches a `---` delimited frontmatter block at the start of a file. */
export const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

interface FrontmatterParseResult {
  /** Key-value pairs extracted from the frontmatter block. */
  fields: Record<string, unknown>;
  /** The remaining file content after the frontmatter block. */
  body: string;
}

/**
 * Parse frontmatter fields from file content. Extracts key-value pairs from the
 * `---` delimited block at the top of the file via a YAML parser, handling
 * nested objects, arrays, quoted strings, and escape sequences natively.
 * Returns `null` if no frontmatter block is found.
 */
export function parseFrontmatterFields(
  content: string,
): FrontmatterParseResult | null {
  const match = content.match(FRONTMATTER_REGEX);
  if (!match) return null;

  const frontmatter = match[1];
  const body = content.slice(match[0].length);

  try {
    const parsed = parseYaml(frontmatter);
    if (parsed == null || typeof parsed !== "object") {
      return { fields: {}, body };
    }
    return { fields: parsed as Record<string, unknown>, body };
  } catch (err) {
    log.warn({ err }, "Failed to parse YAML frontmatter");
    return null;
  }
}
