/**
 * Shared leaf utilities for the notification pipeline.
 *
 * This module has no intra-pipeline imports — it depends only on Node
 * stdlib — so any notification module can import it without creating
 * circular dependencies.
 */

// ── String helpers ──────────────────────────────────────────────────────────

/** Return `value` trimmed, or `undefined` when blank/nullish. */
export function nonEmpty(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
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
  if (!payload || typeof payload !== "object") return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

// ── Sanitization ────────────────────────────────────────────────────────────

const IDENTITY_FIELD_MAX_LENGTH = 120;

/**
 * Sanitize an untrusted identity field for inclusion in notification copy.
 *
 * - Strips control characters (U+0000–U+001F, U+007F–U+009F) and newlines.
 * - Clamps to 120 characters.
 */
export function sanitizeIdentityField(value: string): string {
  const stripped = value.replace(/[\x00-\x1f\x7f-\x9f\r\n]+/g, " ").trim();
  const clamped =
    stripped.length > IDENTITY_FIELD_MAX_LENGTH
      ? stripped.slice(0, IDENTITY_FIELD_MAX_LENGTH) + "…"
      : stripped;
  return clamped;
}

export const MESSAGE_PREVIEW_MAX_LENGTH = 200;

/**
 * Sanitize an untrusted message preview for inclusion in notification copy.
 *
 * Same as {@link sanitizeIdentityField} but uses a higher length limit
 * (200 chars) suited for message previews.
 */
export function sanitizeMessagePreview(value: string): string {
  const stripped = value.replace(/[\x00-\x1f\x7f-\x9f\r\n]+/g, " ").trim();
  const clamped =
    stripped.length > MESSAGE_PREVIEW_MAX_LENGTH
      ? stripped.slice(0, MESSAGE_PREVIEW_MAX_LENGTH) + "…"
      : stripped;
  return clamped;
}
