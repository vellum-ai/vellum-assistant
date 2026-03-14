/**
 * Deterministic, template-based copy generation for notification deliveries.
 *
 * This is the fallback path used when the decision engine's LLM-generated
 * copy is unavailable (fallbackUsed === true). It generates reasonable
 * copy from the signal's sourceEventName, contextPayload, and attentionHints.
 *
 * Each source event name has a set of fallback templates that interpolate
 * values from the context payload.
 */

import {
  buildGuardianRequestCodeInstruction,
  resolveGuardianQuestionInstructionMode,
} from "./guardian-question-mode.js";
import type {
  NotificationSignal,
  NotificationSourceEventName,
} from "./signal.js";
import type { NotificationChannel, RenderedChannelCopy } from "./types.js";

type CopyTemplate = (payload: Record<string, unknown>) => RenderedChannelCopy;

function str(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  return fallback;
}

export function nonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// ── Access-request copy contract ─────────────────────────────────────────────
//
// Deterministic helpers for building guardian-facing access-request copy.
// These are used both by the fallback template and the decision-engine
// post-generation enforcement to ensure required directives always appear.

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

  // For non-voice, include extra context when available.
  // Sanitize before comparing to avoid deduplication failures when identity
  // fields contain control characters that are stripped from `requester`.
  const sanitizedUsername = actorUsername
    ? sanitizeIdentityField(actorUsername)
    : undefined;
  const sanitizedExternalId = actorExternalId
    ? sanitizeIdentityField(actorExternalId)
    : undefined;
  const parts = [requester];
  if (sanitizedUsername && sanitizedUsername !== requester) {
    parts.push(`@${sanitizedUsername}`);
  }
  if (
    sanitizedExternalId &&
    sanitizedExternalId !== requester &&
    sanitizedExternalId !== sanitizedUsername
  ) {
    parts.push(`[${sanitizedExternalId}]`);
  }
  if (sourceChannel) {
    parts.push(`via ${sourceChannel}`);
  }

  return `${parts.join(" ")} is requesting access to the assistant.`;
}

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

/**
 * Build the deterministic access-request contract text from payload fields.
 * This is the canonical baseline that enforcement can append when generated
 * copy is missing required elements.
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

  const lines: string[] = [];
  lines.push(buildAccessRequestIdentityLine(payload));
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
  return lines.join("\n");
}

// Templates keyed by dot-separated sourceEventName strings matching producers.
const TEMPLATES: Partial<Record<NotificationSourceEventName, CopyTemplate>> = {
  "schedule.notify": (payload) => ({
    title: "Reminder",
    body: str(payload.message, str(payload.label, "A reminder has fired")),
  }),

  "schedule.complete": (payload) => ({
    title: "Schedule Complete",
    body: `${str(payload.name, "A schedule")} has finished running`,
  }),

  "guardian.question": (payload) => {
    const question = str(
      payload.questionText,
      "A guardian question needs your attention",
    );
    const requestCode = nonEmpty(
      typeof payload.requestCode === "string" ? payload.requestCode : undefined,
    );
    if (!requestCode) {
      return {
        title: "Guardian Question",
        body: question,
      };
    }

    const normalizedCode = requestCode.toUpperCase();
    const modeResolution = resolveGuardianQuestionInstructionMode(payload);
    const instruction = buildGuardianRequestCodeInstruction(
      normalizedCode,
      modeResolution.mode,
    );
    return {
      title: "Guardian Question",
      body: `${question}\n\n${instruction}`,
    };
  },

  "ingress.access_request": (payload) => ({
    title: "Access Request",
    body: buildAccessRequestContractText(payload),
  }),

  "ingress.access_request.callback_handoff": (payload) => {
    const callerName = nonEmpty(
      typeof payload.callerName === "string" ? payload.callerName : undefined,
    );
    const callerPhone = nonEmpty(
      typeof payload.callerPhoneNumber === "string"
        ? payload.callerPhoneNumber
        : undefined,
    );
    const requestCode = nonEmpty(
      typeof payload.requestCode === "string" ? payload.requestCode : undefined,
    );
    const memberId = nonEmpty(
      typeof payload.requesterMemberId === "string"
        ? payload.requesterMemberId
        : undefined,
    );

    const callerIdentity =
      callerName && callerPhone
        ? `${callerName} (${callerPhone})`
        : (callerName ?? callerPhone ?? "An unknown caller");

    const lines: string[] = [];
    lines.push(
      `${callerIdentity} called and requested a callback while you were unreachable.`,
    );

    if (requestCode) {
      lines.push(`Request code: ${requestCode.toUpperCase()}`);
    }
    if (memberId) {
      lines.push(`This caller is a trusted contact (member ID: ${memberId}).`);
    }

    return {
      title: "Callback Requested",
      body: lines.join("\n"),
    };
  },

  "ingress.escalation": (payload) => ({
    title: "Escalation",
    body:
      str(payload.senderIdentifier, "An incoming message") + " needs attention",
  }),

  "watcher.notification": (payload) => ({
    title: str(payload.title, "Watcher Notification"),
    body: str(payload.body, "A watcher event occurred"),
  }),

  "watcher.escalation": (payload) => ({
    title: str(payload.title, "Watcher Escalation"),
    body: str(payload.body, "A watcher event requires your attention"),
  }),

  "tool_confirmation.required_action": (payload) => ({
    title: "Tool Confirmation",
    body: str(payload.toolName, "A tool") + " requires your confirmation",
  }),

  "activity.complete": (payload) => ({
    title: "Activity Complete",
    body: str(payload.summary, "An activity has completed"),
  }),

  "quick_chat.response_ready": (payload) => ({
    title: "Response Ready",
    body: str(payload.preview, "Your quick chat response is ready"),
  }),

  "voice.response_ready": (payload) => ({
    title: "Voice Response",
    body: str(payload.preview, "A voice response is ready"),
  }),
};

/**
 * Compose fallback notification copy for a signal when the decision
 * engine's LLM path is unavailable.
 *
 * Returns a map of channel -> RenderedChannelCopy for the requested channels.
 * Base title/body content comes from templates, then channel-specific
 * defaults are applied (for example Telegram deliveryText).
 */
export function composeFallbackCopy(
  signal: NotificationSignal,
  channels: NotificationChannel[],
): Partial<Record<NotificationChannel, RenderedChannelCopy>> {
  const template =
    TEMPLATES[signal.sourceEventName as NotificationSourceEventName];

  const baseCopy: RenderedChannelCopy = template
    ? template(signal.contextPayload)
    : buildGenericCopy(signal);

  const result: Partial<Record<NotificationChannel, RenderedChannelCopy>> = {};
  for (const ch of channels) {
    result[ch] = applyChannelDefaults(ch, baseCopy, signal);
  }
  return result;
}

function applyChannelDefaults(
  channel: NotificationChannel,
  baseCopy: RenderedChannelCopy,
  signal: NotificationSignal,
): RenderedChannelCopy {
  const copy: RenderedChannelCopy = { ...baseCopy };

  if (channel === "telegram") {
    copy.deliveryText = buildChatSurfaceFallbackDeliveryText(baseCopy, signal);
  }

  return copy;
}

function buildChatSurfaceFallbackDeliveryText(
  baseCopy: RenderedChannelCopy,
  signal: NotificationSignal,
): string {
  const explicit = nonEmpty(baseCopy.deliveryText);
  if (explicit) return explicit;

  const body = nonEmpty(baseCopy.body);
  if (body) return body;

  const title = nonEmpty(baseCopy.title);
  if (title) return title;

  return signal.sourceEventName.replace(/[._]/g, " ");
}

/**
 * Build generic copy when no template matches. Uses the signal's
 * sourceEventName and attention hints to produce something reasonable.
 */
function buildGenericCopy(signal: NotificationSignal): RenderedChannelCopy {
  const humanName = signal.sourceEventName.replace(/[._]/g, " ");
  const urgencyPrefix =
    signal.attentionHints.urgency === "high" ? "Urgent: " : "";
  const actionSuffix = signal.attentionHints.requiresAction
    ? " — action required"
    : "";

  return {
    title: "Notification",
    body: `${urgencyPrefix}${humanName}${actionSuffix}`,
  };
}
