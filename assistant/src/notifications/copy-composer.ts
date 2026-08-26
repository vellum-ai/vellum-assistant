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

import { normalizeTitle } from "../util/short-title.js";
import { truncate } from "../util/truncate.js";
import {
  accessRequestCardTitle,
  buildAccessRequestContractText,
  isAdmittedIntroduction,
} from "./access-request-copy.js";
import {
  buildAccessRequestSeedContentBlocks,
  buildToolApprovalSeedContentBlocks,
} from "./approval-card-data.js";
import {
  buildGuardianRequestCodeInstruction,
  parseGuardianQuestionPayload,
  resolveGuardianInstructionModeFromPayload,
  resolveGuardianQuestionInstructionMode,
} from "./guardian-question-mode.js";
import {
  nonEmpty,
  NOTIFICATION_TITLE_MAX_LENGTH,
  readPayloadString,
  sanitizeIdentityField,
  sanitizeMessagePreview,
} from "./notification-utils.js";
import type {
  NotificationSignal,
  NotificationSourceEventName,
} from "./signal.js";
import { parseTrustedContactDecisionPayload } from "./trusted-contact-payloads.js";
import type { NotificationChannel, RenderedChannelCopy } from "./types.js";

type CopyTemplate = (payload: Record<string, unknown>) => RenderedChannelCopy;

/**
 * Failure prose for an `activity.failed` payload with no authored
 * classification message. The classified kind supplies the readable part,
 * and the raw error text is appended only when it reads as prose: a
 * stack-shaped or constant-shaped message (PROVIDER_BILLING and friends)
 * says nothing to the person reading the notification and never lands in
 * the body.
 */
function describeUnclassifiedFailure(payload: Record<string, unknown>): string {
  const kind = str(payload.errorKind, "exception");
  const opening =
    kind === "timeout"
      ? "It ran out of time before finishing."
      : kind === "model_provider"
        ? "The model provider did not respond."
        : "It stopped with an error.";
  const raw =
    typeof payload.errorMessage === "string"
      ? payload.errorMessage.replace(/\s+/g, " ").trim()
      : "";
  const readable =
    raw.length > 0 &&
    raw.length <= 200 &&
    !/[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+/.test(raw);
  return readable ? `${opening} ${raw}` : opening;
}

function str(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return fallback;
}

/**
 * Read an untrusted payload string for interpolation into copy: sanitized
 * like an identity field, undefined when the value is absent, not a string,
 * or sanitizes down to nothing.
 */
function optionalSanitizedPayloadField(value: unknown): string | undefined {
  return typeof value === "string"
    ? nonEmpty(sanitizeIdentityField(value))
    : undefined;
}

/** {@link optionalSanitizedPayloadField} with a fallback for the empty case. */
function sanitizedPayloadField(value: unknown, fallback: string): string {
  return optionalSanitizedPayloadField(value) ?? fallback;
}

/**
 * Plugin and schedule names from a `schedule.*` payload, with the fallbacks
 * every schedule template shares.
 */
function schedulePayloadNames(payload: Record<string, unknown>): {
  scheduleName: string;
  pluginName: string;
} {
  return {
    scheduleName: sanitizedPayloadField(payload.scheduleName, "a schedule"),
    pluginName: sanitizedPayloadField(payload.pluginName, "A plugin"),
  };
}

/**
 * Derive a short notification title from a message body. Trims to the
 * first sentence terminator when present, then caps the result at
 * `NOTIFICATION_TITLE_MAX_LENGTH` characters with an ellipsis.
 */
export function deriveTitle(body: string): string {
  const firstSentenceEnd = body.search(/[.!?](\s|$)/);
  const candidate =
    firstSentenceEnd > 0 ? body.slice(0, firstSentenceEnd + 1) : body;
  return candidate.length > NOTIFICATION_TITLE_MAX_LENGTH
    ? candidate.slice(0, NOTIFICATION_TITLE_MAX_LENGTH).trim() + "\u2026"
    : candidate.trim();
}

/**
 * Clean a producer-authored title, falling back to one derived from the body
 * when `normalizeTitle` returns its empty-string rejection signal.
 *
 * The decision engine's pass-through path applies the same clamp, so a signal
 * carrying `requestedTitle` renders the same headline whether or not the LLM
 * classifier was reachable.
 *
 * The two branches carry different budgets. An accepted authored title is
 * bounded by `normalizeTitle` at 40 characters. A rejected one falls through to
 * `deriveTitle`, which never sees the normalizer and applies
 * `NOTIFICATION_TITLE_MAX_LENGTH` (60) plus a trailing ellipsis, so a derived
 * title can reach 61 characters.
 */
export function resolveTitle(raw: string | undefined, body: string): string {
  return normalizeTitle(raw ?? "") || deriveTitle(body);
}

/**
 * Build a display label for a trusted-contact actor (requester or decider),
 * preferring the display name, then a Slack `<@id>` mention for raw Slack user
 * IDs, then the raw id, then a generic fallback. The result is sanitized for
 * safe inclusion in notification copy.
 */
function formatTrustedContactActor(
  displayName: string | null | undefined,
  externalUserId: string | null | undefined,
  sourceChannel: string | null | undefined,
  fallback: string,
): string {
  const name =
    typeof displayName === "string" && displayName.length > 0
      ? displayName
      : undefined;
  const slackMention =
    sourceChannel === "slack" &&
    typeof externalUserId === "string" &&
    /^U[A-Z0-9]+$/i.test(externalUserId)
      ? `<@${externalUserId}>`
      : undefined;
  const rawId =
    typeof externalUserId === "string" && externalUserId.length > 0
      ? externalUserId
      : undefined;
  return sanitizeIdentityField(name ?? slackMention ?? rawId ?? fallback);
}

// Templates keyed by dot-separated sourceEventName strings matching producers.
const TEMPLATES: Partial<Record<NotificationSourceEventName, CopyTemplate>> = {
  "schedule.notify": (payload) => ({
    title: str(payload.label, "Reminder"),
    body: str(payload.message, "A reminder has fired"),
  }),

  // The schedule.* fields below (names, cadence, error reason) originate in
  // plugin-authored declaration files, so they are sanitized like any other
  // untrusted actor-controlled string before interpolation.
  "schedule.declared": (payload) => {
    const { scheduleName, pluginName } = schedulePayloadNames(payload);
    const cadence = optionalSanitizedPayloadField(payload.cadence);
    const cadenceSuffix = cadence ? ` (${cadence})` : "";
    return {
      title: `New plugin schedule: ${scheduleName}`,
      body: `Plugin "${pluginName}" armed the schedule "${scheduleName}"${cadenceSuffix}. It will run automatically; you can disable it from your schedules.`,
    };
  },

  "schedule.definition_changed": (payload) => {
    const { scheduleName, pluginName } = schedulePayloadNames(payload);
    return {
      title: `Plugin schedule changed: ${scheduleName}`,
      body: `Plugin "${pluginName}" changed the definition of its schedule "${scheduleName}".`,
    };
  },

  "schedule.definition_error": (payload) => {
    const { scheduleName, pluginName } = schedulePayloadNames(payload);
    const reason = sanitizeMessagePreview(
      str(payload.reason, "the declaration is invalid"),
    );
    // `paused` says the schedule stopped running over this error rather than
    // carrying on with what it last loaded, which is the part the user acts on.
    const pausedSuffix =
      payload.paused === true
        ? " It is paused until the declaration loads again."
        : "";
    return {
      title: `Plugin schedule error: ${scheduleName}`,
      body: `Plugin "${pluginName}" has a schedule "${scheduleName}" that could not be loaded: ${reason}${pausedSuffix}`,
    };
  },

  "guardian.question": (payload) => {
    const question = str(
      payload.questionText,
      "A guardian question needs your attention",
    );

    // Parse once with Zod and reuse the typed payload downstream.
    const parsed = parseGuardianQuestionPayload(payload);

    // For tool_grant_request, the questionText already includes requester name + input summary.
    // Use it directly as the conversation seed to avoid LLM-generated filler.
    const isToolGrant = parsed?.requestKind === "tool_grant_request";
    const conversationSeedMessage = isToolGrant ? question : undefined;

    const seedContentBlocks =
      (parsed
        ? buildToolApprovalSeedContentBlocks(parsed)
        : buildToolApprovalSeedContentBlocks(payload)) ?? undefined;

    const requestCode = parsed
      ? nonEmpty(parsed.requestCode)
      : nonEmpty(
          typeof payload.requestCode === "string"
            ? payload.requestCode
            : undefined,
        );

    if (!requestCode) {
      return {
        title: "Guardian Question",
        body: question,
        conversationSeedMessage,
        seedContentBlocks,
      };
    }

    const normalizedCode = requestCode.toUpperCase();
    const modeResolution = parsed
      ? resolveGuardianInstructionModeFromPayload(parsed)
      : resolveGuardianQuestionInstructionMode(payload);
    const instruction = buildGuardianRequestCodeInstruction(
      normalizedCode,
      modeResolution.mode,
    );
    return {
      title: "Guardian Question",
      body: `${question}\n\n${instruction}`,
      conversationSeedMessage,
      seedContentBlocks,
    };
  },

  "guardian.channel_activation": (payload) => {
    const code = str(payload.verificationCode, "------");
    const channel = str(payload.sourceChannel, "a channel");
    return {
      title: "Guardian Verification Code",
      body: `Your ${channel} verification code is: ${code}\n\nEnter this code in your ${channel} chat to verify your identity as guardian.`,
    };
  },

  "ingress.access_request": (payload) => ({
    title: accessRequestCardTitle(isAdmittedIntroduction(payload)),
    body: buildAccessRequestContractText(payload),
    seedContentBlocks: buildAccessRequestSeedContentBlocks(payload),
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

  "ingress.trusted_contact.guardian_decision": (payload) => {
    const parsed = parseTrustedContactDecisionPayload(payload);
    const requesterLabel = formatTrustedContactActor(
      parsed?.requesterDisplayName,
      parsed?.requesterExternalUserId,
      parsed?.sourceChannel,
      "Someone",
    );
    const decidedByLabel = formatTrustedContactActor(
      parsed?.decidedByDisplayName,
      parsed?.decidedByExternalUserId,
      parsed?.sourceChannel,
      "a guardian",
    );
    const verb = parsed?.decision === "approved" ? "approved" : "denied";
    return {
      title: "Trusted Contact Decision",
      body: `${requesterLabel}'s access request has been ${verb} by ${decidedByLabel}.`,
    };
  },

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

  "activity.failed": (payload) => {
    const jobName = str(payload.jobName, "background job");
    // The classifier's authored user-facing message rides the payload as
    // `failureSummary` when the failing turn carried its classification;
    // it already says what happened and what to do about it.
    // Authored messages are short by construction, but the classifier's
    // fallback branches can embed provider error text, so bound the body
    // like any other untrusted payload string.
    const summary = truncate(
      typeof payload.failureSummary === "string"
        ? payload.failureSummary.trim()
        : "",
      300,
    );
    return {
      title: `Background job failed: ${jobName}`,
      body: summary !== "" ? summary : describeUnclassifiedFailure(payload),
    };
  },

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
  // Honor user-supplied content when present. The assistant_tool
  // pass-through handles the happy path (sourceChannel === "assistant_tool");
  // this catches the same payload fields when the LLM fallback fires for
  // any source channel.
  const msg = nonEmpty(
    readPayloadString(signal.contextPayload, "requestedMessage"),
  );
  if (msg) {
    const title = resolveTitle(
      readPayloadString(signal.contextPayload, "requestedTitle"),
      msg,
    );
    const baseCopy: RenderedChannelCopy = {
      title,
      body: msg,
      conversationSeedMessage: msg,
    };
    const result: Partial<Record<NotificationChannel, RenderedChannelCopy>> =
      {};
    for (const ch of channels) {
      result[ch] = applyChannelDefaults(ch, baseCopy);
    }
    return result;
  }

  const template =
    TEMPLATES[signal.sourceEventName as NotificationSourceEventName];

  const baseCopy: RenderedChannelCopy = template
    ? template(signal.contextPayload)
    : buildGenericCopy();

  const result: Partial<Record<NotificationChannel, RenderedChannelCopy>> = {};
  for (const ch of channels) {
    result[ch] = applyChannelDefaults(ch, baseCopy);
  }
  return result;
}

function applyChannelDefaults(
  channel: NotificationChannel,
  baseCopy: RenderedChannelCopy,
): RenderedChannelCopy {
  const copy: RenderedChannelCopy = { ...baseCopy };

  if (channel === "telegram") {
    copy.deliveryText = buildChatSurfaceFallbackDeliveryText(baseCopy);
  }

  return copy;
}

function buildChatSurfaceFallbackDeliveryText(
  baseCopy: RenderedChannelCopy,
): string {
  const explicit = nonEmpty(baseCopy.deliveryText);
  if (explicit) {
    return explicit;
  }

  const body = nonEmpty(baseCopy.body);
  if (body) {
    return body;
  }

  const title = nonEmpty(baseCopy.title);
  if (title) {
    return title;
  }

  // No usable text: return empty string. The broadcaster's empty-body skip in
  // `broadcaster.ts` suppresses fallback-derived empty bodies; the
  // deterministic `checkRenderedCopyQuality` (see deterministic-checks.ts)
  // covers the same case when the empty body originates in
  // `decision.renderedCopy`.
  return "";
}

/**
 * Build generic copy when no template matches. Returns an empty body so the
 * notification is suppressed rather than rendering an event-name placeholder.
 * The broadcaster's empty-body skip in `broadcaster.ts` catches fallback-derived
 * empty bodies; the deterministic `checkRenderedCopyQuality` (see
 * deterministic-checks.ts) covers the same case when the empty body originates
 * in `decision.renderedCopy`.
 */
function buildGenericCopy(): RenderedChannelCopy {
  return {
    title: "Notification",
    body: "",
  };
}
