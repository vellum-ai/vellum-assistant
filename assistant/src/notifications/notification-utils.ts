/**
 * Shared leaf utilities for the notification pipeline.
 *
 * This module has no intra-pipeline imports (only Node stdlib and leaf
 * utilities), so any notification module can import it without creating
 * circular dependencies.
 */

import type { Root, RootContent } from "mdast";

import { parseMarkdown } from "../messaging/content/parse.js";
import { stripAnsiAndControlChars } from "../util/ansi.js";
import { isPlainObject } from "../util/object.js";

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

/**
 * Node types whose children are blocks rather than an inline run, so their text
 * needs a paragraph break between children instead of being butted together.
 */
const BLOCK_CONTAINER_TYPES = new Set([
  "blockquote",
  "listItem",
  "footnoteDefinition",
]);

/** Plain text of one mdast node, markers and media dropped. */
function nodeText(node: RootContent): string {
  switch (node.type) {
    // Literal runs. Code keeps its value: a fenced block previews as its code,
    // and the parser has already decided what is code, so markdown-looking
    // lines inside it are safe.
    case "text":
    case "inlineCode":
    case "code":
    case "html":
      return node.value;
    // Media carries no prose. A caller names it separately when the flattened
    // text comes up empty; see {@link mediaEmbedAltTexts}.
    case "image":
    case "imageReference":
      return "";
    case "break":
      return "\n";
    case "thematicBreak":
      return "";
    case "table":
    case "list":
      return node.children.map(nodeText).join("\n");
    case "tableRow":
      return node.children.map(nodeText).join(" ");
    default:
      return "children" in node
        ? node.children
            .map(nodeText)
            .join(BLOCK_CONTAINER_TYPES.has(node.type) ? "\n\n" : "")
        : "";
  }
}

/**
 * Flatten markdown to the plain text a notification surface renders, where
 * markers would otherwise arrive as literal punctuation.
 *
 * Parses with the same remark/GFM processor the web client and the channel
 * renderers use, rather than matching markers by hand. That is what keeps a
 * balanced-paren URL, a tilde fence nested in a backtick one, a pipeless GFM
 * table, and image syntax quoted inside a code span from each needing their own
 * special case.
 *
 * Media embeds are dropped whole, alt text included. The alt describes the
 * attachment rather than adding prose, so keeping it previews a video as its
 * own caption. Copy that is nothing but embeds therefore flattens to empty,
 * which is a caller's signal to describe the media instead.
 *
 * Line structure survives, so callers needing multi-line copy keep it; collapse
 * whitespace separately for a single line.
 */
export function stripMarkdownForPreview(value: string): string {
  return parseMarkdown(value).children.map(nodeText).join("\n\n");
}

/** Collect the alt text of every image node, depth first. */
function collectImageAlts(node: Root | RootContent, into: string[]): void {
  if (node.type === "image" || node.type === "imageReference") {
    into.push(node.alt ?? "");
    return;
  }
  if ("children" in node) {
    for (const child of node.children) {
      collectImageAlts(child, into);
    }
  }
}

/**
 * Alt texts of the media embeds in `value`, in order, empty alts included.
 *
 * Lets a caller describe copy whose entire content was embeds. Remote
 * `https://` embeds are as valid as `vellum://` ones and register nothing in
 * the attachment store, so without this a reply of one remote image would go
 * out with no copy at all rather than merely an unhelpful one.
 *
 * The alts come from the parser, which resolves an image description to plain
 * text, so formatted alt text arrives already flattened.
 */
export function mediaEmbedAltTexts(value: string): string[] {
  const alts: string[] = [];
  collectImageAlts(parseMarkdown(value), alts);
  return alts;
}

/**
 * Copy naming media, from whatever labels a caller could recover: attachment
 * filenames, or the alt texts {@link mediaEmbedAltTexts} pulled back out of
 * copy that flattened away.
 *
 * Labels are model- and tool-authored, so a single one is sanitized before it
 * can reach the lock screen; one that sanitizes away leaves generic copy rather
 * than a dangling "Sent ".
 *
 * Returns an empty string for no labels, leaving the caller to decide whether
 * that means suppress the notification or fall back further.
 */
export function describeMedia(labels: string[]): string {
  if (labels.length === 0) {
    return "";
  }
  if (labels.length > 1) {
    return `Sent ${labels.length} attachments`;
  }
  const label = sanitizeMessagePreview(labels[0].replace(/\s+/g, " ").trim());
  return label ? `Sent ${label}` : "Sent an attachment";
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
