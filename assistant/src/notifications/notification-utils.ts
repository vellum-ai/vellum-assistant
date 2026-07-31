/**
 * Shared leaf utilities for the notification pipeline.
 *
 * This module has no intra-pipeline imports (only Node stdlib and leaf
 * utilities), so any notification module can import it without creating
 * circular dependencies.
 */

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

// ── Sanitization ────────────────────────────────────────────────────────────

/** Strip control characters and newlines, then truncate to `maxLength`. */
function sanitize(value: string, maxLength: number): string {
  return truncate(
    value.replace(/[\x00-\x1f\x7f-\x9f\r\n]+/g, " ").trim(),
    maxLength,
  );
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
 * Sanitize an untrusted notification title for inclusion in notification copy.
 * Strips control characters and clamps to `NOTIFICATION_TITLE_MAX_LENGTH`.
 */
export function sanitizeNotificationTitle(value: string): string {
  return sanitize(value, NOTIFICATION_TITLE_MAX_LENGTH);
}
