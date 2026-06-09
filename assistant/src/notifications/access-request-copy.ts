/**
 * Deterministic helpers for building guardian-facing access-request copy.
 *
 * Used by the fallback template in copy-composer and the decision-engine
 * post-generation enforcement to ensure required directives always appear.
 */

// ── Local string utilities ──────────────────────────────────────────────────
//
// Tiny helpers duplicated from copy-composer to keep this module
// dependency-free (avoiding a circular import with copy-composer, which
// imports access-request helpers for its templates).

function str(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  return fallback;
}

function nonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// ── Identity sanitization ───────────────────────────────────────────────────

const IDENTITY_FIELD_MAX_LENGTH = 120;

/**
 * Sanitize an untrusted identity field for inclusion in notification copy.
 *
 * - Strips control characters (U+0000–U+001F, U+007F–U+009F) and newlines.
 * - Clamps to IDENTITY_FIELD_MAX_LENGTH characters.
 * - Wraps in quotes to neutralize instruction-like payload text.
 */
export function sanitizeIdentityField(value: string): string {
  const stripped = value.replace(/[\x00-\x1f\x7f-\x9f\r\n]+/g, " ").trim();
  const clamped =
    stripped.length > IDENTITY_FIELD_MAX_LENGTH
      ? stripped.slice(0, IDENTITY_FIELD_MAX_LENGTH) + "…"
      : stripped;
  return clamped;
}

export function buildAccessRequestIdentityLine(
  payload: Record<string, unknown>,
): string {
  const requester = sanitizeIdentityField(
    str(payload.senderIdentifier, "Someone"),
  );
  const sourceChannel =
    typeof payload.sourceChannel === "string"
      ? payload.sourceChannel
      : undefined;
  const callerName = nonEmpty(
    typeof payload.actorDisplayName === "string"
      ? payload.actorDisplayName
      : undefined,
  );
  const actorUsername = nonEmpty(
    typeof payload.actorUsername === "string"
      ? payload.actorUsername
      : undefined,
  );
  const actorExternalId = nonEmpty(
    typeof payload.actorExternalId === "string"
      ? payload.actorExternalId
      : undefined,
  );

  if (sourceChannel === "phone" && callerName) {
    const safeName = sanitizeIdentityField(callerName);
    const safeId = sanitizeIdentityField(
      str(payload.actorExternalId, requester),
    );
    return `${safeName} (${safeId}) is calling and requesting access to the assistant.`;
  }

  // Sanitize before comparing to avoid deduplication failures when identity
  // fields contain control characters that are stripped from `requester`.
  const sanitizedUsername = actorUsername
    ? sanitizeIdentityField(actorUsername)
    : undefined;
  const sanitizedExternalId = actorExternalId
    ? sanitizeIdentityField(actorExternalId)
    : undefined;
  // When the requester is a raw Slack user ID (e.g. the fallback path in
  // access-request-helper sets senderIdentifier to the raw actorExternalId),
  // format it as a Slack mention so it renders as a clickable display name.
  const formattedRequester =
    sourceChannel === "slack" && /^U[A-Z0-9]+$/i.test(requester)
      ? `<@${requester}>`
      : requester;
  const parts = [formattedRequester];
  if (sanitizedUsername && sanitizedUsername !== requester) {
    parts.push(`@${sanitizedUsername}`);
  }
  if (
    sanitizedExternalId &&
    sanitizedExternalId !== requester &&
    sanitizedExternalId !== sanitizedUsername
  ) {
    // For Slack, use the <@U...> mention format so Slack auto-renders
    // the user ID as a clickable display name.
    const formattedId =
      sourceChannel === "slack" && /^U[A-Z0-9]+$/i.test(sanitizedExternalId)
        ? `<@${sanitizedExternalId}>`
        : `[${sanitizedExternalId}]`;
    parts.push(formattedId);
  }
  if (sourceChannel) {
    parts.push(`via ${sourceChannel}`);
  }

  return `${parts.join(" ")} is requesting access to the assistant.`;
}

// ── Message preview ─────────────────────────────────────────────────────────

export const MESSAGE_PREVIEW_MAX_LENGTH = 200;

/**
 * Sanitize an untrusted message preview for inclusion in notification copy.
 *
 * Like {@link sanitizeIdentityField} but uses the higher
 * MESSAGE_PREVIEW_MAX_LENGTH limit (200 chars) instead of the identity
 * field limit (120 chars).
 */
export function sanitizeMessagePreview(value: string): string {
  const stripped = value.replace(/[\x00-\x1f\x7f-\x9f\r\n]+/g, " ").trim();
  const clamped =
    stripped.length > MESSAGE_PREVIEW_MAX_LENGTH
      ? stripped.slice(0, MESSAGE_PREVIEW_MAX_LENGTH) + "…"
      : stripped;
  return clamped;
}

/**
 * Build a quoted preview of the requester's original message for inclusion
 * in guardian-facing access-request copy. Sanitizes and truncates to keep
 * the notification concise.
 *
 * Returns `undefined` when no usable preview is available.
 */
function buildAccessRequestMessagePreview(
  payload: Record<string, unknown>,
): string | undefined {
  const raw =
    typeof payload.messagePreview === "string"
      ? payload.messagePreview
      : undefined;
  if (!raw) return undefined;

  const sanitized = sanitizeMessagePreview(raw);
  if (sanitized.length === 0) return undefined;

  return `> Their message: "${sanitized}"`;
}

// ── Directives ──────────────────────────────────────────────────────────────

export function buildAccessRequestInviteDirective(): string {
  return 'Reply "open invite flow" to start Trusted Contacts invite flow.';
}

/**
 * Normalize text before running directive-matching regexes.
 *
 * - Replaces smart/curly apostrophes (\u2018, \u2019, \u201B) with ASCII `'`
 *   so contractions like "Don\u2019t" are matched by the `n't` lookbehind.
 * - Collapses runs of whitespace into a single space so "Do not   reply"
 *   is matched by the single-space negative lookbehind.
 * - Trims leading/trailing whitespace.
 */
export function normalizeForDirectiveMatching(text: string): string {
  return text
    .replace(/[\u2018\u2019\u201B]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Check whether a text contains the required access-request instruction elements:
 * 1. Approve directive: Reply "CODE approve"
 * 2. Reject directive: Reply "CODE reject"
 * 3. Invite directive: Reply "open invite flow"
 *
 * Each directive is matched independently using negative lookbehind to reject
 * matches preceded by negation words ("not", "n't", "never"). This prevents
 * contradictory copy like `Do not reply "CODE reject"` from satisfying the
 * check even when a positive approve directive exists nearby.
 *
 * The text is normalized before matching to handle smart apostrophes and
 * multiple whitespace characters that would otherwise bypass negation detection.
 */
export function hasAccessRequestInstructions(
  text: string | undefined,
  requestCode: string,
): boolean {
  if (typeof text !== "string") return false;
  const normalized = normalizeForDirectiveMatching(text);
  const escapedCode = requestCode.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Each directive must follow "reply" without a preceding negation word.
  // Negative lookbehinds reject "do not reply", "don't reply", "never reply".
  const approveRe = new RegExp(
    `(?<!not\\s)(?<!n't\\s)(?<!never\\s)reply\\b[^.!?\\n]*?"${escapedCode}\\s+approve"`,
    "i",
  );
  const rejectRe = new RegExp(
    `(?<!not\\s)(?<!n't\\s)(?<!never\\s)reply\\b[^.!?\\n]*?"${escapedCode}\\s+reject"`,
    "i",
  );
  const inviteRe =
    /(?<!not\s)(?<!n't\s)(?<!never\s)reply\b[^.!?\n]*?"open invite flow"/i;

  return (
    approveRe.test(normalized) &&
    rejectRe.test(normalized) &&
    inviteRe.test(normalized)
  );
}

/**
 * Check whether text contains the invite-flow directive ("open invite flow")
 * using the same normalized negative-lookbehind pattern as the full check.
 * This is used for enforcement when requestCode is absent but the invite
 * directive should still be present.
 */
export function hasInviteFlowDirective(text: string | undefined): boolean {
  if (typeof text !== "string") return false;
  const normalized = normalizeForDirectiveMatching(text);
  const inviteRe =
    /(?<!not\s)(?<!n't\s)(?<!never\s)reply\b[^.!?\n]*?"open invite flow"/i;
  return inviteRe.test(normalized);
}

// ── Contract text builder ───────────────────────────────────────────────────

/**
 * Build the deterministic access-request contract text from payload fields.
 * This is the canonical baseline that enforcement can append when generated
 * copy is missing required elements.
 *
 * Channel-agnostic by design: this function reads from the generic
 * `contextPayload` and works identically regardless of which channel
 * (Slack, Telegram, desktop, etc.) the notification is delivered to.
 * When `guardianResolutionSource` is present and not `"source-channel-contact"`,
 * the guardian was resolved via fallback (e.g. vellum anchor) rather than
 * a verified same-channel contact — downstream copy or routing can use
 * this to append verification CTAs like "Was this you?".
 */
export function buildAccessRequestContractText(
  payload: Record<string, unknown>,
): string {
  const requestCode = nonEmpty(
    typeof payload.requestCode === "string" ? payload.requestCode : undefined,
  );
  const previousMemberStatus =
    typeof payload.previousMemberStatus === "string"
      ? payload.previousMemberStatus
      : undefined;

  const guardianResolutionSource =
    typeof payload.guardianResolutionSource === "string"
      ? payload.guardianResolutionSource
      : undefined;
  const sourceChannel =
    typeof payload.sourceChannel === "string"
      ? payload.sourceChannel
      : undefined;

  const lines: string[] = [];
  lines.push(buildAccessRequestIdentityLine(payload));
  const preview = buildAccessRequestMessagePreview(payload);
  if (preview) {
    lines.push(preview);
  }
  if (previousMemberStatus === "revoked") {
    lines.push("Note: this user was previously revoked.");
  }
  if (requestCode) {
    const code = requestCode.toUpperCase();
    lines.push(
      `Reply "${code} approve" to grant access or "${code} reject" to deny.`,
    );
  }
  lines.push(buildAccessRequestInviteDirective());
  if (
    (guardianResolutionSource === "vellum-anchor" ||
      guardianResolutionSource === "none") &&
    sourceChannel
  ) {
    lines.push(
      `Note: You haven't verified your identity on ${sourceChannel} yet. If this was you trying to message your assistant, say "help me verify as guardian on ${sourceChannel}" to set up direct access.`,
    );
  }
  return lines.join("\n");
}
