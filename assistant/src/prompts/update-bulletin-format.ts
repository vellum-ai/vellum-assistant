/**
 * Pure helpers for reading and writing release blocks in the update bulletin.
 *
 * Each release block is delimited by an HTML comment marker so that
 * concurrent appends (from different branches) are merge-safe -- they
 * simply add a new block at the end without conflicting with existing ones.
 */

const MARKER_PREFIX = "<!-- vellum-update-release:";
const MARKER_SUFFIX = " -->";
const MARKER_REGEX = /<!-- vellum-update-release:(.+?) -->/g;

/** Returns the HTML comment marker for a given release version. */
export function releaseMarker(version: string): string {
  return `${MARKER_PREFIX}${version}${MARKER_SUFFIX}`;
}

/** Returns true if `content` already contains the release marker for `version`. */
export function hasReleaseBlock(content: string, version: string): boolean {
  return content.includes(releaseMarker(version));
}

/**
 * Appends a new release block (marker + body) to `content`.
 *
 * Preserves all existing content and formatting. A blank line is inserted
 * between the previous content and the new block when the existing content
 * does not already end with a newline.
 */
export function appendReleaseBlock(
  content: string,
  version: string,
  body: string,
): string {
  const marker = releaseMarker(version);
  const block = `${marker}\n${body}`;

  if (content.length === 0) return `${block}\n`;

  const separator = content.endsWith("\n") ? "\n" : "\n\n";
  return `${content}${separator}${block}\n`;
}

/**
 * Filters template content to only include content blocks whose opening
 * markers are not already present in the existing workspace content.
 *
 * Each content block is delimited by opening/closing marker pairs:
 *   <!-- vellum-update-release:id --> ... <!-- /vellum-update-release:id -->
 *
 * If the template has no block structure (no matched open/close pairs),
 * returns the original body unchanged for backward compatibility.
 * Returns empty string when all blocks are already present.
 */
export function filterNewContentBlocks(
  body: string,
  existing: string,
): string {
  const blockRegex =
    /(<!-- vellum-update-release:(.+?) -->[\s\S]*?<!-- \/vellum-update-release:\2 -->)/g;
  const blocks: Array<{ full: string; id: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = blockRegex.exec(body)) !== null) {
    blocks.push({ full: match[1], id: match[2] });
  }

  if (blocks.length === 0) return body;

  const newBlocks = blocks.filter((b) => !hasReleaseBlock(existing, b.id));

  if (newBlocks.length === 0) return "";

  return newBlocks.map((b) => b.full).join("\n\n");
}

/** Extracts all version strings from release markers found in `content`. */
export function extractReleaseIds(content: string): string[] {
  const ids: string[] = [];
  MARKER_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MARKER_REGEX.exec(content)) !== null) {
    ids.push(match[1]);
  }
  return ids;
}
