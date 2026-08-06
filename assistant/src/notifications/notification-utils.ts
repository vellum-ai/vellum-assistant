/**
 * Shared leaf utilities for the notification pipeline.
 *
 * This module has no intra-pipeline imports (only Node stdlib and leaf
 * utilities), so any notification module can import it without creating
 * circular dependencies.
 */

import { stripAnsiAndControlChars } from "../util/ansi.js";
import { isPlainObject } from "../util/object.js";
import { stripMarkdown } from "../util/short-title.js";

// ── String helpers ──────────────────────────────────────────────────────────

/** Return `value` trimmed, or `undefined` when blank/nullish. */
export function nonEmpty(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Safely read a string property from an unknown-typed payload object.
 * Returns `undefined` when the payload is falsy, not an object, or the
 * key does not hold a string value.
 */
export function readPayloadString(
  payload: unknown,
  key: string,
): string | undefined {
  if (!isPlainObject(payload)) {
    return undefined;
  }
  const value = payload[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Safely read a plain-object property from an unknown-typed payload object.
 * Returns `undefined` when the payload is not an object or the key does not
 * hold a plain object (arrays and `null` are rejected).
 */
export function readPayloadObject(
  payload: unknown,
  key: string,
): Record<string, unknown> | undefined {
  if (!isPlainObject(payload)) {
    return undefined;
  }
  const value = payload[key];
  return isPlainObject(value) ? value : undefined;
}

/** Truncate `text` to `maxLength`, appending "…" when exceeded. */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength - 1) + "…";
}

// ── Markdown flattening ─────────────────────────────────────────────────────

/** Media embeds: `![alt](url)`, remote or `vellum://`, capturing the alt. */
const MEDIA_EMBED_RE = /!\[([^\]]*)\]\([^)]*\)/g;

/** Fence openers and closers. Splitting on these isolates the fenced content. */
const CODE_FENCE_LINE_RE = /^[ \t]{0,3}(?:```|~~~).*$/gm;

/** Table delimiter rows and horizontal rules: punctuation, never words. */
const RULE_ROW_RE = /^[ \t]*\|?[ \t:|-]*-[ \t:|-]*$/gm;

/** A pipe-delimited table row, matched only when both edge pipes are present. */
const TABLE_ROW_RE = /^[ \t]*\|(.*)\|[ \t]*$/gm;

/**
 * Remove the line-anchored block markers markdown puts at the start of a line:
 * fences, `#` headings, `>` quotes, and `-`/`1.` list bullets.
 *
 * Shared with `deriveFallbackTitle` in `home-feed-side-effect.ts`, which needs
 * the identical rule set: its output has to keep matching `flattenToPlainText`
 * in workspace migration 138, so that a backfilled feed title and a freshly
 * written one agree. Change these rules and that migration has to move with
 * them.
 *
 * Line-anchored, so this must run before any whitespace collapse, and before
 * `stripMarkdown`, whose inline-code rule would chew a fence into a stray
 * backtick.
 */
export function stripBlockMarkers(value: string): string {
  return value
    .replace(/^\s{0,3}(?:```|~~~).*$/gm, "")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm, "");
}

/** Flatten one run of prose, i.e. everything outside a code fence. */
function flattenProse(segment: string): string {
  const deblocked = stripBlockMarkers(segment.replace(MEDIA_EMBED_RE, ""))
    .replace(RULE_ROW_RE, "")
    .replace(TABLE_ROW_RE, (_match, cells: string) =>
      cells
        .split("|")
        .map((cell) => cell.trim())
        .filter((cell) => cell.length > 0)
        .join(" "),
    );
  return stripMarkdown(deblocked);
}

/**
 * Flatten markdown syntax out of untrusted copy bound for a plain-text
 * notification surface, where the markers render as literal punctuation rather
 * than formatting.
 *
 * Media embeds are dropped whole, alt text included. The alt describes the
 * attachment rather than adding prose, so keeping it previews a video as its
 * own caption. A reply that is nothing but embeds therefore flattens to empty,
 * which is the signal for a caller to describe the media instead; see
 * {@link mediaEmbedAltTexts}.
 *
 * Fenced content is passed through verbatim. Flattening it would rewrite the
 * code being previewed: a `# comment` would lose its `#`, a `---` would vanish,
 * and a piped shell expression would be mistaken for a table row.
 *
 * Line structure survives, so callers needing multi-line copy keep it; collapse
 * whitespace separately for a single line.
 */
export function stripMarkdownForPreview(value: string): string {
  // Splitting on the fence lines drops them and leaves alternating segments,
  // the odd ones being the fenced bodies.
  return value
    .split(CODE_FENCE_LINE_RE)
    .map((segment, index) =>
      index % 2 === 0 ? flattenProse(segment) : segment,
    )
    .join("\n");
}

/**
 * Alt texts of the media embeds in `value`, in order, empty alts included.
 *
 * Lets a caller describe a reply whose entire content was embeds. Remote
 * `https://` embeds are as valid as `vellum://` ones and register nothing in
 * the attachment store, so without this a reply of one remote image would go
 * out with no copy at all rather than merely an unhelpful one.
 */
export function mediaEmbedAltTexts(value: string): string[] {
  return [...value.matchAll(MEDIA_EMBED_RE)].map((match) => match[1] ?? "");
}

// ── Sanitization ────────────────────────────────────────────────────────────

/**
 * Strip escape sequences, flatten control characters and newlines to spaces,
 * then truncate to `maxLength`.
 */
function sanitize(value: string, maxLength: number): string {
  return truncate(stripAnsiAndControlChars(value, " ").trim(), maxLength);
}

/**
 * Sanitize an untrusted identity field for inclusion in notification copy.
 * Strips control characters and clamps to 120 characters.
 */
export function sanitizeIdentityField(value: string): string {
  return sanitize(value, 120);
}

export const MESSAGE_PREVIEW_MAX_LENGTH = 200;

/**
 * Sanitize an untrusted message preview for inclusion in notification copy.
 * Strips control characters and clamps to 200 characters.
 */
export function sanitizeMessagePreview(value: string): string {
  return sanitize(value, MESSAGE_PREVIEW_MAX_LENGTH);
}

/** Character budget every notification title shares. */
export const NOTIFICATION_TITLE_MAX_LENGTH = 60;

/**
 * Flatten an untrusted notification title onto a single line, stripping control
 * characters and newlines and bounding it at `NOTIFICATION_TITLE_MAX_LENGTH`.
 *
 * The newline flattening is the load-bearing part: downstream consumers re-run
 * the value through `normalizeTitle`, whose prose guard discards any string
 * containing a newline outright, so a multi-line conversation title would be
 * thrown away wholesale instead of salvaged. The length bound is a backstop;
 * `normalizeTitle`'s tighter 40-character budget is what callers observe.
 */
export function sanitizeNotificationTitle(value: string): string {
  return sanitize(value, NOTIFICATION_TITLE_MAX_LENGTH);
}
