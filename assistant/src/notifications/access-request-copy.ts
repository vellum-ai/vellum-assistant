/**
 * Deterministic helpers for building guardian-facing access-request copy.
 *
 * Used by the fallback template in copy-composer and the decision-engine
 * post-generation enforcement to ensure required directives always appear.
 */

import { z } from "zod";

import { buildSlackPermalink } from "../messaging/providers/slack/deep-link.js";
import { isSlackDmConversation } from "../messaging/providers/slack/message-metadata.js";
import {
  buildIntroductionActions,
  coerceSignalBoolean,
  type IntroductionActionOption,
  introductionMode,
  isHandshakeOffered,
} from "../runtime/introduction-policy.js";
import {
  nonEmpty,
  sanitizeIdentityField,
  sanitizeMessagePreview,
  stripReplyMechanicsFromCopy,
  stripRequestCodeDirectives,
} from "./notification-utils.js";
import type { RenderedChannelCopy } from "./types.js";

// ── Zod schema for access-request payloads ──────────────────────────────────

/** Accepts string, null, or any other type — coerces non-strings to undefined. */
const optStr = z
  .unknown()
  .transform((v) => (typeof v === "string" ? v : undefined));

/**
 * Tri-state identity-signal boolean (see `coerceSignalBoolean`): explicit
 * `false` is preserved as a positive platform resolution, everything
 * non-boolean is unknown.
 */
const optBool = z.unknown().transform(coerceSignalBoolean);

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
  /**
   * `"admitted"` marks an introduction nudge for a sender who cleared the
   * admission floor (see access-request-helper `AccessRequestTrigger`);
   * absent/other means the deny-path access request.
   */
  trigger: optStr,
});

export type ParsedAccessRequestPayload = z.infer<
  typeof AccessRequestPayloadSchema
>;

export function parseAccessRequestPayload(
  payload: Record<string, unknown>,
): ParsedAccessRequestPayload {
  return AccessRequestPayloadSchema.parse(payload);
}

/**
 * Whether the payload is an admitted-mode introduction nudge. Accepts both
 * parsed payloads and the raw `contextPayload` record so every render surface
 * shares one predicate.
 */
export function isAdmittedIntroduction(p: { trigger?: unknown }): boolean {
  return p.trigger === "admitted";
}

/** Card/notification title, shared by every render surface. */
export function accessRequestCardTitle(admitted: boolean): string {
  return introductionMode(admitted ? "admitted" : "denied").cardTitle;
}

/**
 * Card subtitle (also the Slack card's no-preview body label), shared by
 * every render surface.
 */
export function accessRequestCardSubtitle(admitted: boolean): string {
  return introductionMode(admitted ? "admitted" : "denied").cardSubtitle;
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

/** Internal typed implementation — avoids re-parsing when called from
 *  buildAccessRequestContextText which has already parsed the payload. */
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

  return introductionMode(p.trigger).identityLine(parts.join(" "));
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
 * Guardian-facing context for an access request: who is asking, what they
 * said, any warnings, where it came from, and the invite-flow directive.
 * The invite directive is context rather than mechanics because no surface
 * offers a button for it: typing "open invite flow" is the only way to start
 * it anywhere, so every surface has to say so. The request-code directive
 * is {@link buildAccessRequestReplyMechanics}, and only the broadcaster's
 * `plainTextFallback` holds it, so a transport appends it exactly when it
 * sends text without buttons.
 *
 * Channel-agnostic by design: this reads the generic `contextPayload` and
 * renders the same on every channel. When `guardianResolutionSource` is
 * present and not `"source-channel-contact"`, the guardian was resolved via
 * fallback (e.g. vellum anchor) rather than a verified same-channel contact,
 * and the copy says so.
 */
export function buildAccessRequestContextText(
  payload: Record<string, unknown>,
): string {
  const p = parseAccessRequestPayload(payload);

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
      ? buildSlackPermalink({
          channelId: p.conversationExternalId,
          messageTs: p.messageTs,
        })
      : undefined;
    const isDm = isSlackDmConversation(p.conversationExternalId);
    const channelLabel = isDm ? "Direct message" : p.conversationExternalId;
    const source = permalink
      ? `Source: Slack — ${channelLabel} (${permalink})`
      : `Source: Slack — ${channelLabel}`;
    lines.push(source);
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

/**
 * The typed-reply mechanics for an access request: the request-code
 * directive (verify, trust, reject, block; or trust, reject, block when no
 * handshake is offered). This is the broadcaster's `plainTextFallback` for
 * the card, appended to a message only by a transport that sends text
 * without buttons. Empty when the request carries no code, since there is
 * then nothing to type.
 */
export function buildAccessRequestReplyMechanics(
  payload: Record<string, unknown>,
): string {
  const p = parseAccessRequestPayload(payload);
  const requestCode = nonEmpty(p.requestCode);
  if (!requestCode) {
    return "";
  }
  const code = requestCode.toUpperCase();
  return isHandshakeOfferedForPayload(p)
    ? `Reply "${code} verify" to send them a verification code, "${code} trust" to trust them without one, "${code} reject" to leave them unverified, or "${code} block" to block them.`
    : `Reply "${code} trust" to trust them, "${code} reject" to leave them unverified, or "${code} block" to block them.`;
}

/**
 * Remove request-code reply mechanics the model wrote into composed copy
 * ({@link stripRequestCodeDirectives}). The invite-flow directive is context
 * and stays.
 */
export function stripAccessRequestReplyMechanics(
  text: string,
  payload: Record<string, unknown>,
): string {
  const requestCode = nonEmpty(parseAccessRequestPayload(payload).requestCode);
  return requestCode ? stripRequestCodeDirectives(text, requestCode) : text;
}

/**
 * The text-only rendering of an access request: the context, then the
 * typed directive when the request carries a code. This is the card's text
 * sibling, what a client without buttons (the CLI, search, the model) sees
 * in place of the card.
 */
export function buildAccessRequestTextFallback(
  payload: Record<string, unknown>,
): string {
  const mechanics = buildAccessRequestReplyMechanics(payload);
  const context = buildAccessRequestContextText(payload);
  return mechanics ? `${context}\n${mechanics}` : context;
}

/**
 * Whether text carries a positive invite-flow directive: a "reply ..."
 * sentence naming the phrase, not preceded by a negation. A bare mention
 * ("the open invite flow is disabled") or a negated form ("do not reply
 * ...") does not count, so the canonical directive still gets appended.
 */
export function hasInviteFlowDirective(text: string): boolean {
  const normalized = text
    .replace(/[\u2018\u2019\u201B]/g, "'")
    .replace(/\s+/g, " ");
  return /(?<!not )(?<!n't )(?<!never )reply\b[^.!?\n]*?"open invite flow"/i.test(
    normalized,
  );
}

/**
 * Ensure the invite-flow directive is in every text field of a channel's
 * access-request copy. It is context rather than mechanics (no surface has
 * an invite button, so the sentence is the only way to start the flow), and
 * model-composed copy can omit, negate, or merely mention it, so the
 * canonical sentence is appended whenever no positive directive is present.
 * A title stays a title.
 */
export function ensureAccessRequestInviteDirectiveInCopy(
  copy: RenderedChannelCopy,
): RenderedChannelCopy {
  const ensure = (text: string): string =>
    hasInviteFlowDirective(text)
      ? text
      : `${text.trim()}\n${buildAccessRequestInviteDirective()}`;
  return {
    ...copy,
    body: ensure(copy.body),
    deliveryText: copy.deliveryText
      ? ensure(copy.deliveryText)
      : copy.deliveryText,
    conversationSeedMessage: copy.conversationSeedMessage
      ? ensure(copy.conversationSeedMessage)
      : copy.conversationSeedMessage,
  };
}

/**
 * {@link stripAccessRequestReplyMechanics} over every text field of a
 * channel's copy; a field left empty becomes the requester context.
 */
export function stripAccessRequestReplyMechanicsFromCopy(
  copy: RenderedChannelCopy,
  payload: Record<string, unknown>,
): RenderedChannelCopy {
  const requestCode = nonEmpty(parseAccessRequestPayload(payload).requestCode);
  return stripReplyMechanicsFromCopy(copy, {
    strip: (text) =>
      requestCode ? stripRequestCodeDirectives(text, requestCode) : text,
    ask: buildAccessRequestContextText(payload),
    headline: accessRequestCardTitle(isAdmittedIntroduction(payload)),
  });
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
  /** Admitted-mode introduction nudge (sender cleared the admission floor). */
  admitted: boolean;
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
      ? buildSlackPermalink({
          channelId: conversationExternalId,
          messageTs,
        })
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
    admitted: isAdmittedIntroduction(p),
  };
}
