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
 * Extracts content-level markers (non-version feature markers) from the
 * template body. These are markers like `schedule-reminder-unification`
 * that identify the _content_ rather than the release version.
 */
export function extractContentMarkers(body: string): string[] {
  const ids: string[] = [];
  const regex = /<!-- vellum-update-release:(.+?) -->/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(body)) !== null) {
    ids.push(match[1]);
  }
  return ids;
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
