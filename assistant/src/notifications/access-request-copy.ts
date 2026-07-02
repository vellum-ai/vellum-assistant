/**
 * Deterministic helpers for building guardian-facing access-request copy.
 *
 * Used by the fallback template in copy-composer and the decision-engine
 * post-generation enforcement to ensure required directives always appear.
 */

import { z } from "zod";

import {
  buildIntroductionActions,
  type IntroductionActionOption,
  isHandshakeOffered,
} from "../runtime/introduction-policy.js";
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
  isBot: optBool,
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
  if (p.isBot) {
    warnings.push(
      "Bot / integration account — code verification isn't possible.",
    );
  }
  if (p.isStranger) {
    warnings.push("External Slack user (not in this workspace).");
  }
  if (p.isRestricted) {
    warnings.push("Guest / restricted account.");
  }
  return warnings;
}

// ── Introduction actions ─────────────────────────────────────────────────────

/**
 * Signal-driven introduction-card action list for a parsed access-request
 * payload. Shared by every card renderer (Slack Card block, Telegram inline
 * keyboard, Vellum Surface card) so the offered actions never drift between
 * surfaces.
 */
export function buildIntroductionActionsForPayload(
  p: ParsedAccessRequestPayload,
): IntroductionActionOption[] {
  return buildIntroductionActions(p.sourceChannel, {
    isBot: p.isBot,
    isStranger: p.isStranger,
    isRestricted: p.isRestricted,
  });
}

/** Whether the verification handshake is offered for this requester. */
export function isHandshakeOfferedForPayload(
  p: ParsedAccessRequestPayload,
): boolean {
  return isHandshakeOffered(p.sourceChannel, {
    isBot: p.isBot,
    isStranger: p.isStranger,
    isRestricted: p.isRestricted,
  });
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
  if (!raw) {
    return undefined;
  }

  const sanitized = sanitizeMessagePreview(raw);
  if (sanitized.length === 0) {
    return undefined;
  }

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

/** Build a negated-lookbehind directive regex for `reply ... "CODE <verb>"`. */
function buildCodeDirectiveRegex(escapedCode: string, verb: string): RegExp {
  return new RegExp(
    `(?<!not\\s)(?<!n't\\s)(?<!never\\s)reply\\b[^.!?\\n]*?"${escapedCode}\\s+${verb}"`,
    "i",
  );
}

/**
 * Check whether a text contains the required access-request instruction
 * elements for the introduction card:
 * 1. Trust directive: Reply "CODE trust"
 * 2. Verify directive: Reply "CODE verify" — only when the handshake is
 *    offered for this requester (never for bots / workspace-vouched members)
 * 3. Leave-unverified directive: Reply "CODE reject"
 * 4. Block directive: Reply "CODE block"
 * 5. Invite directive: Reply "open invite flow"
 *
 * Each directive is matched independently using negative lookbehind to reject
 * matches preceded by negation words ("not", "n't", "never"). This prevents
 * contradictory copy like `Do not reply "CODE reject"` from satisfying the
 * check even when a positive directive exists nearby.
 *
 * The text is normalized before matching to handle smart apostrophes and
 * multiple whitespace characters that would otherwise bypass negation detection.
 */
export function hasAccessRequestInstructions(
  text: string | undefined,
  requestCode: string,
  options?: { handshakeOffered?: boolean },
): boolean {
  if (typeof text !== "string") {
    return false;
  }
  const handshakeOffered = options?.handshakeOffered ?? true;
  const normalized = normalizeForDirectiveMatching(text);
  const escapedCode = requestCode.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Each directive must follow "reply" without a preceding negation word.
  // Negative lookbehinds reject "do not reply", "don't reply", "never reply".
  const trustRe = buildCodeDirectiveRegex(escapedCode, "trust");
  const verifyRe = buildCodeDirectiveRegex(escapedCode, "verify");
  const rejectRe = buildCodeDirectiveRegex(escapedCode, "reject");
  const blockRe = buildCodeDirectiveRegex(escapedCode, "block");
  const inviteRe =
    /(?<!not\s)(?<!n't\s)(?<!never\s)reply\b[^.!?\n]*?"open invite flow"/i;

  return (
    trustRe.test(normalized) &&
    (!handshakeOffered || verifyRe.test(normalized)) &&
    rejectRe.test(normalized) &&
    blockRe.test(normalized) &&
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
  if (typeof text !== "string") {
    return false;
  }
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
    if (isHandshakeOfferedForPayload(p)) {
      lines.push(
        `Reply "${code} verify" to send them a verification code, "${code} trust" to trust them without one, "${code} reject" to leave them unverified, or "${code} block" to block them.`,
      );
    } else {
      lines.push(
        `Reply "${code} trust" to trust them, "${code} reject" to leave them unverified, or "${code} block" to block them.`,
      );
    }
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

// ── Card view model ─────────────────────────────────────────────────────────

/**
 * Display-ready projection of an access request, shared by every renderer
 * (the Vellum Surface card and the Slack Card block). It carries the
 * sanitized, pre-computed facts each renderer needs — identity sanitizing,
 * warnings, permalink, DM detection, preview sanitizing — so that projection
 * lives in exactly one place. Renderers lay these facts out in their
 * channel-native shape without re-deriving them.
 */
export interface AccessRequestCardView {
  /** Sanitized display name (actorDisplayName ?? senderIdentifier, else "Someone"). */
  displayName: string;
  /** Sanitized username, without the leading `@`. */
  username: string | undefined;
  /** Sanitized external ID. */
  externalId: string | undefined;
  sourceChannel: string | undefined;
  conversationExternalId: string | undefined;
  /** Whether the source Slack conversation is a DM. */
  isSlackDm: boolean;
  /** Slack permalink — present only for a slack source with conversation + ts. */
  messagePermalink: string | undefined;
  /** Sanitized message preview, or undefined when blank after sanitizing. */
  messagePreview: string | undefined;
  /** Human-readable trust/security warnings. */
  warnings: string[];
  guardianResolutionSource: string | undefined;
  requestId: string | undefined;
}

/**
 * Project a parsed access-request payload into display-ready card facts.
 *
 * The payload is parsed once upstream — the broadcaster resolves
 * `accessRequestContext`, and the Surface seed path parses the raw payload —
 * so this takes the parsed payload rather than re-parsing it.
 */
export function buildAccessRequestCardView(
  p: ParsedAccessRequestPayload,
): AccessRequestCardView {
  const rawName = nonEmpty(p.actorDisplayName) ?? nonEmpty(p.senderIdentifier);
  const displayName = rawName ? sanitizeIdentityField(rawName) : "Someone";

  const rawUsername = nonEmpty(p.actorUsername);
  const username = rawUsername ? sanitizeIdentityField(rawUsername) : undefined;

  const rawExternalId = nonEmpty(p.actorExternalId);
  const externalId = rawExternalId
    ? sanitizeIdentityField(rawExternalId)
    : undefined;

  const sourceChannel = nonEmpty(p.sourceChannel);
  const conversationExternalId = nonEmpty(p.conversationExternalId);
  const messageTs = nonEmpty(p.messageTs);

  const isSlackDm =
    sourceChannel === "slack" && conversationExternalId != null
      ? isSlackDmConversation(conversationExternalId)
      : false;

  const messagePermalink =
    sourceChannel === "slack" && conversationExternalId && messageTs
      ? buildSlackMessagePermalink(conversationExternalId, messageTs)
      : undefined;

  const rawPreview = nonEmpty(p.messagePreview);
  const messagePreview = rawPreview
    ? sanitizeMessagePreview(rawPreview) || undefined
    : undefined;

  return {
    displayName,
    username,
    externalId,
    sourceChannel,
    conversationExternalId,
    isSlackDm,
    messagePermalink,
    messagePreview,
    warnings: buildAccessRequestWarnings(p),
    guardianResolutionSource: nonEmpty(p.guardianResolutionSource),
    requestId: nonEmpty(p.requestId),
  };
}
