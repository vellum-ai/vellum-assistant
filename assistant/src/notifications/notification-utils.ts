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

/** Media embeds: `![alt](url)`, in any of the schemes a reply can carry. */
const MEDIA_EMBED_RE = /!\[[^\]]*\]\([^)]*\)/g;

/** Fence openers and closers, keeping the fenced content itself. */
const CODE_FENCE_LINE_RE = /^[ \t]{0,3}(?:```|~~~).*$/gm;

/** Leading `#` through `######`. */
const HEADING_MARKER_RE = /^[ \t]{0,3}#{1,6}[ \t]+/gm;

/** Leading `>`, one level per pass of the marker itself. */
const BLOCKQUOTE_MARKER_RE = /^[ \t]{0,3}>[ \t]?/gm;

/** Leading `-`, `*`, `+`, `1.`, `1)`. */
const LIST_MARKER_RE = /^[ \t]{0,3}(?:[-*+]|\d+[.)])[ \t]+/gm;

/** Table delimiter rows and horizontal rules: punctuation, never words. */
const RULE_ROW_RE = /^[ \t]*\|?[ \t:|-]*-[ \t:|-]*$/gm;

/** A pipe-delimited table row, matched only when both edge pipes are present. */
const TABLE_ROW_RE = /^[ \t]*\|(.*)\|[ \t]*$/gm;

/**
 * Flatten markdown syntax out of untrusted copy bound for a plain-text
 * notification surface, where the markers render as literal punctuation rather
 * than formatting.
 *
 * Media embeds are dropped whole, alt text included. The alt describes the
 * attachment rather than adding prose, so keeping it previews a video as its
 * own caption. Dropping it is also what lets an embed-only reply flatten to
 * empty and reach its attachment fallback.
 *
 * Line structure survives, so callers needing multi-line copy keep it; collapse
 * whitespace separately for a single line. The block markers below are
 * line-anchored and so must be removed here, ahead of any such collapse, and
 * ahead of `stripMarkdown`, whose inline-code rule would otherwise chew a fence
 * into a stray backtick.
 */
export function stripMarkdownForPreview(value: string): string {
  const deblocked = value
    .replace(MEDIA_EMBED_RE, "")
    .replace(CODE_FENCE_LINE_RE, "")
    .replace(HEADING_MARKER_RE, "")
    .replace(BLOCKQUOTE_MARKER_RE, "")
    .replace(LIST_MARKER_RE, "")
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
