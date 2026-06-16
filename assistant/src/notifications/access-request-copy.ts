/**
 * Deterministic helpers for building guardian-facing access-request copy.
 *
 * Used by the fallback template in copy-composer and the decision-engine
 * post-generation enforcement to ensure required directives always appear.
 */

import { z } from "zod";

import { buildApprovalCardBlocks } from "./approval-card-builder.js";
import {
  nonEmpty,
  sanitizeIdentityField,
  sanitizeMessagePreview,
} from "./notification-utils.js";

// ── Zod schema for access-request payloads ──────────────────────────────────

/** Accepts string, null, or any other type — coerces non-strings to undefined. */
const optStr = z
  .unknown()
  .transform((v) => (typeof v === "string" ? v : undefined));

/** Accepts boolean or any other type — coerces non-true to undefined. */
const optBool = z.unknown().transform((v) => (v === true ? true : undefined));

export const AccessRequestPayloadSchema = z.object({
  requestId: optStr,
  requestCode: optStr,
  sourceChannel: optStr,
  conversationExternalId: optStr,
  actorExternalId: optStr,
  actorDisplayName: optStr,
  actorUsername: optStr,
  senderIdentifier: optStr,
  guardianBindingChannel: optStr,
  guardianResolutionSource: optStr,
  previousMemberStatus: optStr,
  messagePreview: optStr,
  isStranger: optBool,
  isRestricted: optBool,
  messageTs: optStr,
});

export type ParsedAccessRequestPayload = z.infer<
  typeof AccessRequestPayloadSchema
>;

export function parseAccessRequestPayload(
  payload: Record<string, unknown>,
): ParsedAccessRequestPayload {
  return AccessRequestPayloadSchema.parse(payload);
}

// ── Warnings ────────────────────────────────────────────────────────────────

/**
 * Build a list of human-readable warning strings for an access request.
 * Used by both the Slack Block Kit card and the plain-text contract.
 */
export function buildAccessRequestWarnings(
  p: ParsedAccessRequestPayload,
): string[] {
  const warnings: string[] = [];
  if (p.previousMemberStatus === "revoked") {
    warnings.push("This user was previously revoked.");
  }
  if (p.isStranger) {
    warnings.push("External Slack user (not in this workspace).");
  }
  if (p.isRestricted) {
    warnings.push("Guest / restricted account.");
  }
  return warnings;
}

// ── Slack conversation helpers ───────────────────────────────────────────────

/** Slack DM conversation IDs start with `D` followed by alphanumeric chars. */
export function isSlackDmConversation(conversationExternalId: string): boolean {
  return /^D[A-Z0-9]+$/i.test(conversationExternalId);
}

/**
 * Build a Slack message permalink from a channel ID and message timestamp.
 * Format: https://slack.com/archives/{channelId}/p{ts_without_dot}
 * Workspace-agnostic — resolves for any authenticated Slack viewer.
 */
export function buildSlackMessagePermalink(
  conversationExternalId: string,
  messageTs: string,
): string {
  return `https://slack.com/archives/${conversationExternalId}/p${messageTs.replace(".", "")}`;
}

/** Internal typed implementation — avoids re-parsing when called from
 *  buildAccessRequestContractText which has already parsed the payload. */
function buildIdentityLineFromParsed(p: ParsedAccessRequestPayload): string {
  const requester = sanitizeIdentityField(p.senderIdentifier || "Someone");
  const callerName = nonEmpty(p.actorDisplayName);
  const actorUsername = nonEmpty(p.actorUsername);
  const actorExternalId = nonEmpty(p.actorExternalId);

  if (p.sourceChannel === "phone" && callerName) {
    const safeName = sanitizeIdentityField(callerName);
    const safeId = sanitizeIdentityField(p.actorExternalId || requester);
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
  // When the requester is a raw Slack user ID, format it as a Slack mention
  // so Slack auto-renders it as a clickable display name.
  const formattedRequester =
    p.sourceChannel === "slack" && /^U[A-Z0-9]+$/i.test(requester)
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
    const formattedId =
      p.sourceChannel === "slack" && /^U[A-Z0-9]+$/i.test(sanitizedExternalId)
        ? `<@${sanitizedExternalId}>`
        : `[${sanitizedExternalId}]`;
    parts.push(formattedId);
  }
  if (p.sourceChannel) {
    parts.push(`via ${p.sourceChannel}`);
  }

  return `${parts.join(" ")} is requesting access to the assistant.`;
}

export function buildAccessRequestIdentityLine(
  payload: Record<string, unknown>,
): string {
  return buildIdentityLineFromParsed(parseAccessRequestPayload(payload));
}

/**
 * Build a quoted preview of the requester's original message for inclusion
 * in guardian-facing access-request copy. Sanitizes and truncates to keep
 * the notification concise.
 *
 * Returns `undefined` when no usable preview is available.
 */
function buildMessagePreviewFromParsed(
  p: ParsedAccessRequestPayload,
): string | undefined {
  const raw = p.messagePreview;
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
  const p = parseAccessRequestPayload(payload);
  const requestCode = nonEmpty(p.requestCode);

  const lines: string[] = [];
  lines.push(buildIdentityLineFromParsed(p));

  const preview = buildMessagePreviewFromParsed(p);
  if (preview) {
    lines.push(preview);
  }

  // Unified warnings: revoked status + trust signals.
  for (const warning of buildAccessRequestWarnings(p)) {
    lines.push(`Note: ${warning.charAt(0).toLowerCase()}${warning.slice(1)}`);
  }

  // Conversation context: source channel + permalink when available.
  if (p.sourceChannel === "slack" && p.conversationExternalId) {
    const permalink = p.messageTs
      ? buildSlackMessagePermalink(p.conversationExternalId, p.messageTs)
      : undefined;
    const isDm = isSlackDmConversation(p.conversationExternalId);
    const channelLabel = isDm ? "Direct message" : p.conversationExternalId;
    const source = permalink
      ? `Source: Slack — ${channelLabel} (${permalink})`
      : `Source: Slack — ${channelLabel}`;
    lines.push(source);
  }

  if (requestCode) {
    const code = requestCode.toUpperCase();
    lines.push(
      `Reply "${code} approve" to grant access or "${code} reject" to deny.`,
    );
  }
  lines.push(buildAccessRequestInviteDirective());

  if (
    (p.guardianResolutionSource === "vellum-anchor" ||
      p.guardianResolutionSource === "none") &&
    p.sourceChannel
  ) {
    lines.push(
      `Note: You haven't verified your identity on ${p.sourceChannel} yet. If this was you trying to message your assistant, say "help me verify as guardian on ${p.sourceChannel}" to set up direct access.`,
    );
  }
  return lines.join("\n");
}

// ── Seed content blocks (Surface-based rendering) ───────────────────────────

/**
 * Build structured content blocks for an access request notification seed
 * message. Produces a `ui_surface` card block that the web/macOS/iOS apps
 * render as an interactive card via `SurfaceRouter → CardSurface`, plus a
 * plain-text fallback block for search, CLI display, and backward-compatible
 * clients that don't support surfaces.
 */
export function buildAccessRequestSeedContentBlocks(
  payload: Record<string, unknown>,
): unknown[] {
  const p = parseAccessRequestPayload(payload);

  const rawName = nonEmpty(p.actorDisplayName) ?? nonEmpty(p.senderIdentifier);
  const displayName = rawName ? sanitizeIdentityField(rawName) : "Someone";

  const metadata: Array<{ label: string; value: string }> = [];

  if (p.actorUsername) {
    metadata.push({
      label: "Username",
      value: `@${sanitizeIdentityField(p.actorUsername)}`,
    });
  }

  if (p.sourceChannel === "slack" && p.conversationExternalId) {
    const isDm = isSlackDmConversation(p.conversationExternalId);
    metadata.push({
      label: "Source",
      value: isDm
        ? "Slack — Direct message"
        : `Slack — #${p.conversationExternalId}`,
    });
  } else if (p.sourceChannel) {
    metadata.push({ label: "Source", value: p.sourceChannel });
  }

  const warnings = buildAccessRequestWarnings(p);
  const bodyParts: string[] = [];

  if (p.messagePreview) {
    bodyParts.push(`> "${sanitizeMessagePreview(p.messagePreview)}"`);
  }
  for (const w of warnings) {
    bodyParts.push(`⚠️ ${w}`);
  }
  if (p.sourceChannel === "slack" && p.conversationExternalId && p.messageTs) {
    const permalink = buildSlackMessagePermalink(
      p.conversationExternalId,
      p.messageTs,
    );
    bodyParts.push(`[View message](${permalink})`);
  }

  const body =
    bodyParts.length > 0
      ? bodyParts.join("\n\n")
      : "No additional context available.";

  return buildApprovalCardBlocks({
    surfaceIdPrefix: "access-request",
    cardTitle: "Access Request",
    requesterName: displayName,
    subtitle: "Requesting access to the assistant",
    body,
    metadata,
    requestId: p.requestId,
    fallbackText: buildAccessRequestContractText(payload),
  });
}
