/**
 * Notification decision engine.
 *
 * Evaluates a NotificationSignal against available channels and user
 * preferences, producing a NotificationDecision that tells the broadcaster
 * whether and how to notify the user. Uses the provider abstraction to
 * call the LLM with forced tool_choice output, falling back to a
 * deterministic heuristic when the model is unavailable or returns
 * invalid output.
 */

import { v4 as uuid } from "uuid";

import { getDeliverableChannels } from "../channels/config.js";
import { findContactInfoById } from "../contacts/contact-store.js";
import {
  anyGuardian,
  getGuardianDelivery,
} from "../contacts/guardian-delivery-reader.js";
import { buildCoreIdentityContext } from "../prompts/system-prompt.js";
import {
  createTimeout,
  extractToolUse,
  getConfiguredProvider,
  userMessage,
} from "../providers/provider-send-message.js";
import type { Provider } from "../providers/types.js";
import { getLogger } from "../util/logger.js";
import { truncate } from "../util/truncate.js";
import {
  buildAccessRequestContractText,
  buildAccessRequestInviteDirective,
  hasAccessRequestInstructions,
  hasInviteFlowDirective,
  isHandshakeOfferedForPayload,
  parseAccessRequestPayload,
} from "./access-request-copy.js";
import {
  buildAccessRequestSeedContentBlocks,
  buildToolApprovalSeedContentBlocks,
} from "./approval-card-data.js";
import {
  buildConversationCandidates,
  type ConversationCandidateSet,
  serializeCandidatesForPrompt,
} from "./conversation-candidates.js";
import { composeFallbackCopy, deriveTitle } from "./copy-composer.js";
import { createDecision } from "./decisions-store.js";
import {
  buildGuardianRequestCodeInstruction,
  hasGuardianRequestCodeInstruction,
  parseInteractiveApprovalPayload,
  resolveGuardianQuestionInstructionMode,
  stripConflictingGuardianRequestInstructions,
  stripGuardianRequestCodeInstructions,
} from "./guardian-question-mode.js";
import { nonEmpty, readPayloadString } from "./notification-utils.js";
import { getPreferenceSummary } from "./preference-summary.js";
import type { NotificationSignal, RoutingIntent } from "./signal.js";
import type {
  ConversationAction,
  NotificationChannel,
  NotificationDecision,
  RenderedChannelCopy,
} from "./types.js";

const log = getLogger("notification-decision-engine");

const DECISION_TIMEOUT_MS = 15_000;
const PROMPT_VERSION = "v4";

/**
 * Maximum character budget for identity context injected into the notification
 * decision prompt. We truncate to prevent oversized prompts when SOUL.md /
 * IDENTITY.md / users/<slug>.md are large — exceeding the provider context
 * window would cause the LLM call to fail and silently degrade to
 * deterministic fallback for all notifications.
 */
const MAX_IDENTITY_CONTEXT_CHARS = 2000;

// ── System prompt ──────────────────────────────────────────────────────

function buildSystemPrompt(
  availableChannels: NotificationChannel[],
  preferenceContext?: string,
  candidateContext?: string,
  identityContext?: string,
  recipientNotes?: string,
): string {
  const sections: string[] = [
    `You are a notification routing engine. Given a signal describing an event, decide whether the user should be notified, on which channel(s), and compose the notification copy.`,
    ``,
    `Available notification channels: ${availableChannels.join(", ")}`,
  ];

  if (preferenceContext) {
    sections.push(
      ``,
      `<user-preferences>`,
      preferenceContext,
      `</user-preferences>`,
    );
  }

  if (recipientNotes) {
    sections.push(
      ``,
      `<recipient-context>`,
      `The following are notes about the notification recipient. Use this context to tailor notification tone, formality, and content to the recipient's preferences.`,
      recipientNotes,
      `</recipient-context>`,
    );
  }

  if (identityContext) {
    sections.push(
      ``,
      `<assistant-identity>`,
      `The following describes the assistant's identity, personality, and the user's profile. Use this context to match the assistant's tone and style when composing notification copy. Do not include information from this context that is not relevant to the notification.`,
      identityContext,
      `</assistant-identity>`,
    );
  }

  sections.push(
    ``,
    `Guidelines:`,
    `- Only notify when the signal genuinely warrants user attention.`,
    `- Prefer fewer channels unless the signal is urgent.`,
    `- For high-urgency signals that require action, notify on all available channels.`,
    `- For low-urgency background events, suppress unless they match user preferences.`,
    `- Generate a stable dedupeKey derived from the signal context so duplicate signals can be suppressed.`,
    ``,
    `Routing intent (when present in the signal):`,
    `- \`all_channels\`: The source explicitly requests notification on ALL connected channels.`,
    `- \`multi_channel\`: The source prefers 2+ channels when 2+ are connected.`,
    `- \`single_channel\`: Default routing behavior — use your best judgment (no override).`,
    `When a routing intent is present, respect it in your channel selection. A post-decision guard will enforce the intent.`,
    ``,
    `Copy guidelines (three distinct outputs):`,
    `- \`title\` and \`body\` are for native notification popups (e.g. vellum desktop/mobile) — keep them short and glanceable (title ≤ 8 words, body ≤ 2 sentences).`,
    `  - Write popup copy as final copy for the guardian or recipient. Do not write instructions for the assistant or another intermediary.`,
    `- \`deliveryText\` is the channel-native message for chat channels (e.g. telegram). It must read naturally as a standalone message.`,
    `  - Do not prepend mechanical labels like "Conversation:".`,
    `  - Do not mention channel or transport names (e.g. Telegram, Slack, email) unless the event context explicitly requires it.`,
    `  - Do not repeat title/body verbatim unless that repetition is truly necessary.`,
    `  - Avoid meta-send phrasing (e.g. "I'd like to send a notification", "May I go ahead with that?"). Write the recipient-facing message directly.`,
    `  - Avoid intermediary-instruction phrasing like "consider telling the guardian", "ask the recipient to", or "the assistant should remind them". Rewrite it as final copy the recipient can act on directly.`,
    `  - For telegram: 1-2 concise sentences.`,
    `  - For slack approval requests: the message renders inside an interactive card with Approve/Reject buttons. Describe only what needs approval — never include approval/reference codes, code-reply instructions, or directions to respond in another app.`,
    `- \`conversationSeedMessage\` is the opening message in the internal notification conversation and also the expanded detail shown in the home feed. It should be richer and more contextual than the popup body.`,
    `  - For vellum (desktop): use structured markdown for readability. Break content into bullet points, numbered lists, or short sections with **bold** labels. Avoid long unbroken paragraphs — scan-friendly formatting is preferred.`,
    `  - Never dump raw JSON. Include only human-readable context.`,
    ``,
    `Conversation reuse guidelines:`,
    `- For each selected channel, decide whether to start a new conversation or reuse an existing one.`,
    `- Set \`conversationActions\` keyed by channel name with \`action\` = "start_new" or "reuse_existing" (with \`conversationId\` from the candidates).`,
    `- Prefer \`reuse_existing\` when the signal is clearly a continuation or update of an existing notification conversation (same event type, related context).`,
    `- Prefer \`start_new\` when the signal is a distinct event that deserves its own conversation.`,
    `- You may ONLY reuse a conversationId that appears in the provided candidate list. Any other ID will be rejected and downgraded to start_new.`,
    `- When no candidates are available for a channel, always use start_new.`,
  );

  if (candidateContext) {
    sections.push(
      ``,
      `<conversation-candidates>`,
      candidateContext,
      `</conversation-candidates>`,
    );
  }

  sections.push(
    ``,
    `You MUST respond using the \`record_notification_decision\` tool. Do not respond with text.`,
  );

  return sections.join("\n");
}

// ── User prompt ────────────────────────────────────────────────────────

function buildUserPrompt(signal: NotificationSignal): string {
  const parts: string[] = [
    `Signal ID: ${signal.signalId}`,
    `Source event: ${signal.sourceEventName}`,
    `Source channel: ${signal.sourceChannel}`,
    `Urgency: ${signal.attentionHints.urgency}`,
    `Requires action: ${signal.attentionHints.requiresAction}`,
    `Is async background: ${signal.attentionHints.isAsyncBackground}`,
    `User is viewing source now: ${signal.attentionHints.visibleInSourceNow}`,
  ];

  if (signal.attentionHints.deadlineAt) {
    parts.push(
      `Deadline: ${new Date(signal.attentionHints.deadlineAt).toISOString()}`,
    );
  }

  if (signal.routingIntent && signal.routingIntent !== "single_channel") {
    parts.push(`Routing intent: ${signal.routingIntent}`);
  }

  if (signal.routingHints && Object.keys(signal.routingHints).length > 0) {
    parts.push(`Routing hints: ${JSON.stringify(signal.routingHints)}`);
  }

  const payloadStr = JSON.stringify(signal.contextPayload);
  if (payloadStr.length > 2) {
    parts.push(``, `Context payload:`, payloadStr);
  }

  return `Evaluate this notification signal:\n\n${parts.join("\n")}`;
}

// ── Tool definition ────────────────────────────────────────────────────

function buildDecisionTool(availableChannels: NotificationChannel[]) {
  return {
    name: "record_notification_decision",
    description: "Record the notification routing decision for this signal",
    input_schema: {
      type: "object" as const,
      properties: {
        shouldNotify: {
          type: "boolean",
          description: "Whether the user should be notified about this signal",
        },
        selectedChannels: {
          type: "array",
          items: {
            type: "string",
            enum: availableChannels,
          },
          description: "Which channels to deliver the notification on",
        },
        reasoningSummary: {
          type: "string",
          description:
            "Brief explanation of why this routing decision was made",
        },
        renderedCopy: {
          type: "object",
          description: "Notification copy keyed by channel name",
          properties: Object.fromEntries(
            availableChannels.map((ch) => [
              ch,
              {
                type: "object",
                properties: {
                  title: {
                    type: "string",
                    description: "Short notification popup title (≤ 8 words)",
                  },
                  body: {
                    type: "string",
                    description:
                      "Concise notification popup body (≤ 2 sentences)",
                  },
                  deliveryText: {
                    type: "string",
                    description:
                      "Channel-native chat message text (for example Telegram). Must stand alone naturally.",
                  },
                  conversationTitle: {
                    type: "string",
                    description:
                      "Optional conversation title for grouped notifications",
                  },
                  conversationSeedMessage: {
                    type: "string",
                    description:
                      "Richer opening message for the notification conversation. More contextual than title/body. For vellum: 2-4 sentences. For telegram: 1-2 sentences. Never raw JSON.",
                  },
                },
                required: ["title", "body"],
              },
            ]),
          ),
        },
        conversationActions: {
          type: "object",
          description:
            "Per-channel conversation action: start a new conversation or reuse an existing candidate. Keyed by channel name.",
          properties: Object.fromEntries(
            availableChannels.map((ch) => [
              ch,
              {
                type: "object",
                properties: {
                  action: {
                    type: "string",
                    enum: ["start_new", "reuse_existing"],
                    description:
                      "Whether to start a new conversation or reuse an existing one.",
                  },
                  conversationId: {
                    type: "string",
                    description:
                      "Required when action is reuse_existing. Must be a conversationId from the provided conversation candidates.",
                  },
                },
                required: ["action"],
              },
            ]),
          ),
        },
        deepLinkTarget: {
          type: "object",
          description:
            "Optional deep link metadata for navigating to the source context",
        },
        dedupeKey: {
          type: "string",
          description:
            "A stable key derived from the signal to deduplicate repeated notifications for the same event",
        },
        confidence: {
          type: "number",
          description: "Confidence in the decision (0.0-1.0)",
        },
      },
      required: [
        "shouldNotify",
        "selectedChannels",
        "reasoningSummary",
        "renderedCopy",
        "dedupeKey",
        "confidence",
      ],
    },
  };
}

// ── Deterministic fallback ─────────────────────────────────────────────

function buildFallbackDecision(
  signal: NotificationSignal,
  availableChannels: NotificationChannel[],
): NotificationDecision {
  const urgency = signal.attentionHints.urgency;
  const isHighUrgencyAction =
    (urgency === "high" || urgency === "critical") &&
    signal.attentionHints.requiresAction;

  // Always include the vellum channel in the fallback — it's a local
  // broadcast with no cost, so desktop notifications should never be lost
  // when the LLM is unavailable. External channels (e.g. Telegram) are
  // only included for high-urgency actionable signals.
  const selectedChannels: NotificationChannel[] = isHighUrgencyAction
    ? [...availableChannels]
    : availableChannels.filter((ch) => ch === "vellum");

  if (selectedChannels.length === 0) {
    return {
      shouldNotify: false,
      selectedChannels: [],
      reasoningSummary: "Fallback: suppressed (vellum channel not available)",
      renderedCopy: {},
      dedupeKey: `fallback:${signal.sourceEventName}:${signal.sourceContextId}:${signal.createdAt}`,
      confidence: 0.3,
      fallbackUsed: true,
    };
  }

  const copy = composeFallbackCopy(signal, selectedChannels);

  return {
    shouldNotify: true,
    selectedChannels,
    reasoningSummary: isHighUrgencyAction
      ? "Fallback: high urgency + requires action — all channels"
      : "Fallback: vellum-only (local, always delivered)",
    renderedCopy: copy,
    dedupeKey: `fallback:${signal.sourceEventName}:${signal.sourceContextId}:${signal.createdAt}`,
    confidence: 0.3,
    fallbackUsed: true,
  };
}

// ── Validation ─────────────────────────────────────────────────────────

const VALID_CHANNELS = new Set<string>(getDeliverableChannels());

function validateDecisionOutput(
  input: Record<string, unknown>,
  availableChannels: NotificationChannel[],
  candidateSet?: ConversationCandidateSet,
): NotificationDecision | null {
  if (typeof input.shouldNotify !== "boolean") {
    return null;
  }
  if (typeof input.reasoningSummary !== "string") {
    return null;
  }
  if (typeof input.dedupeKey !== "string") {
    return null;
  }

  if (!Array.isArray(input.selectedChannels)) {
    return null;
  }
  const validatedChannels = (input.selectedChannels as unknown[]).filter(
    (ch): ch is NotificationChannel =>
      typeof ch === "string" &&
      VALID_CHANNELS.has(ch) &&
      availableChannels.includes(ch as NotificationChannel),
  );
  const validChannels = [...new Set(validatedChannels)];

  const confidence =
    typeof input.confidence === "number"
      ? Math.max(0, Math.min(1, input.confidence))
      : 0.5;

  // Validate renderedCopy
  const renderedCopy: Partial<
    Record<NotificationChannel, RenderedChannelCopy>
  > = {};
  if (input.renderedCopy && typeof input.renderedCopy === "object") {
    const copyObj = input.renderedCopy as Record<string, unknown>;
    for (const ch of validChannels) {
      const chCopy = copyObj[ch];
      if (chCopy && typeof chCopy === "object") {
        const c = chCopy as Record<string, unknown>;
        if (typeof c.title === "string" && typeof c.body === "string") {
          if (!c.title.trim() && !c.body.trim()) {
            log.warn(
              { channel: ch },
              "LLM returned empty title and body for channel copy — broadcaster will use fallback",
            );
          }
          renderedCopy[ch] = {
            title: c.title,
            body: c.body,
            deliveryText:
              typeof c.deliveryText === "string" ? c.deliveryText : undefined,
            conversationTitle:
              typeof c.conversationTitle === "string"
                ? c.conversationTitle
                : undefined,
            conversationSeedMessage:
              typeof c.conversationSeedMessage === "string"
                ? c.conversationSeedMessage
                : undefined,
          };
        }
      }
    }
  }

  // Validate conversationActions — strictly against the provided candidate set
  const conversationActions = validateConversationActions(
    input.conversationActions,
    validChannels,
    candidateSet,
  );

  const deepLinkTarget =
    input.deepLinkTarget && typeof input.deepLinkTarget === "object"
      ? (input.deepLinkTarget as Record<string, unknown>)
      : undefined;

  return {
    shouldNotify: input.shouldNotify,
    selectedChannels: validChannels,
    reasoningSummary: input.reasoningSummary,
    renderedCopy,
    conversationActions:
      Object.keys(conversationActions).length > 0
        ? conversationActions
        : undefined,
    deepLinkTarget,
    dedupeKey: input.dedupeKey,
    confidence,
    fallbackUsed: false,
  };
}

// ── Conversation action validation ────────────────────────────────────

/**
 * Validate and sanitize conversation actions from LLM output.
 *
 * - reuse_existing targets are checked against the candidate set; invalid
 *   targets are downgraded to start_new with a warning.
 * - Channels not in the selected set are ignored.
 * - Missing actions for selected channels default to start_new (handled
 *   downstream, not materialized here to keep the output compact).
 */
export function validateConversationActions(
  raw: unknown,
  validChannels: NotificationChannel[],
  candidateSet?: ConversationCandidateSet,
): Partial<Record<NotificationChannel, ConversationAction>> {
  const result: Partial<Record<NotificationChannel, ConversationAction>> = {};

  if (!raw || typeof raw !== "object") {
    return result;
  }

  const actionsObj = raw as Record<string, unknown>;
  const channelSet = new Set(validChannels);

  // Build a lookup of valid candidate conversationIds per channel
  const validCandidateIds = new Map<NotificationChannel, Set<string>>();
  if (candidateSet) {
    for (const [ch, candidates] of Object.entries(candidateSet) as [
      NotificationChannel,
      { conversationId: string }[],
    ][]) {
      validCandidateIds.set(
        ch,
        new Set(candidates.map((c) => c.conversationId)),
      );
    }
  }

  for (const [ch, actionRaw] of Object.entries(actionsObj)) {
    if (!channelSet.has(ch as NotificationChannel)) {
      continue;
    }
    if (!actionRaw || typeof actionRaw !== "object") {
      continue;
    }

    const channel = ch as NotificationChannel;
    const action = actionRaw as Record<string, unknown>;

    if (action.action === "start_new") {
      result[channel] = { action: "start_new" };
    } else if (action.action === "reuse_existing") {
      const rawConversationId = action.conversationId;
      if (typeof rawConversationId !== "string" || !rawConversationId.trim()) {
        log.warn(
          { channel },
          "LLM returned reuse_existing without conversationId — downgrading to start_new",
        );
        result[channel] = { action: "start_new" };
        continue;
      }

      // Normalize: the LLM may return a valid ID with leading/trailing whitespace
      const conversationId = rawConversationId.trim();

      // Strict validation: the conversationId must exist in the candidate set
      const candidateIds = validCandidateIds.get(channel);
      if (!candidateIds || !candidateIds.has(conversationId)) {
        log.warn(
          { channel, conversationId },
          "LLM returned reuse_existing with conversationId not in candidate set — downgrading to start_new",
        );
        result[channel] = { action: "start_new" };
        continue;
      }

      result[channel] = { action: "reuse_existing", conversationId };
    }
    // Unknown action values are silently ignored — the channel will default
    // to start_new downstream.
  }

  return result;
}

function ensureGuardianRequestCodeInCopy(
  copy: RenderedChannelCopy,
  requestCode: string,
  mode: "approval" | "answer",
): RenderedChannelCopy {
  const instruction = buildGuardianRequestCodeInstruction(requestCode, mode);

  const ensureText = (text: string | undefined): string => {
    const base = typeof text === "string" ? text.trim() : "";
    const sanitized = stripConflictingGuardianRequestInstructions(
      base,
      requestCode,
      mode,
    );
    if (hasGuardianRequestCodeInstruction(sanitized, requestCode, mode)) {
      return sanitized;
    }
    return sanitized.length > 0
      ? `${sanitized}\n\n${instruction}`
      : instruction;
  };

  return {
    ...copy,
    body: ensureText(copy.body),
    deliveryText: copy.deliveryText
      ? ensureText(copy.deliveryText)
      : copy.deliveryText,
    conversationSeedMessage: copy.conversationSeedMessage
      ? ensureText(copy.conversationSeedMessage)
      : copy.conversationSeedMessage,
  };
}

/**
 * Remove request-code reply instructions from copy for a channel whose
 * approval UI makes them redundant. Instruction-only fields keep their
 * original text rather than becoming empty — downstream treats an empty
 * body as missing copy.
 */
function stripGuardianRequestCodeInCopy(
  copy: RenderedChannelCopy,
  requestCode: string,
): RenderedChannelCopy {
  const strip = (text: string): string => {
    const stripped = stripGuardianRequestCodeInstructions(text, requestCode);
    return stripped.length > 0 ? stripped : text;
  };

  return {
    ...copy,
    body: strip(copy.body),
    deliveryText: copy.deliveryText
      ? strip(copy.deliveryText)
      : copy.deliveryText,
    conversationSeedMessage: copy.conversationSeedMessage
      ? strip(copy.conversationSeedMessage)
      : copy.conversationSeedMessage,
  };
}

/**
 * Guardian questions that share a conversation require explicit request-code
 * targeting. Enforce request-code instructions in rendered copy so guardians
 * can always disambiguate replies even when model copy omits them.
 *
 * Slack is the exception for approval-mode questions: the Slack adapter
 * renders those as an interactive card with Approve/Reject buttons (see
 * `resolveApprovalContext` in broadcaster.ts, gated on the same
 * `parseInteractiveApprovalPayload`), so code-reply instructions are
 * redundant noise there and are stripped instead of enforced in.
 */
function enforceGuardianRequestCode(
  decision: NotificationDecision,
  signal: NotificationSignal,
): NotificationDecision {
  if (signal.sourceEventName !== "guardian.question") {
    return decision;
  }
  const rawCode = signal.contextPayload.requestCode;
  if (typeof rawCode !== "string" || rawCode.trim().length === 0) {
    return decision;
  }

  const requestCode = rawCode.trim().toUpperCase();
  const modeResolution = resolveGuardianQuestionInstructionMode(
    signal.contextPayload,
  );
  const slackRendersApprovalButtons =
    parseInteractiveApprovalPayload(signal.contextPayload) != null;
  const nextCopy: Partial<Record<NotificationChannel, RenderedChannelCopy>> = {
    ...decision.renderedCopy,
  };

  for (const channel of Object.keys(nextCopy) as NotificationChannel[]) {
    const copy = nextCopy[channel];
    if (!copy) {
      continue;
    }
    nextCopy[channel] =
      channel === "slack" && slackRendersApprovalButtons
        ? stripGuardianRequestCodeInCopy(copy, requestCode)
        : ensureGuardianRequestCodeInCopy(
            copy,
            requestCode,
            modeResolution.mode,
          );
  }

  return {
    ...decision,
    renderedCopy: nextCopy,
  };
}

/**
 * Inject seedContentBlocks into every channel's copy when not already present.
 * Used by both tool-approval and access-request guards to ensure Surface cards
 * render on all decision paths (LLM, assistant_tool, fallback).
 */
function ensureSeedContentBlocks(
  decision: NotificationDecision,
  blocks: unknown[] | null | undefined,
): NotificationDecision {
  if (!blocks) {
    return decision;
  }

  const nextCopy: Partial<Record<NotificationChannel, RenderedChannelCopy>> = {
    ...decision.renderedCopy,
  };
  for (const channel of Object.keys(nextCopy) as NotificationChannel[]) {
    const copy = nextCopy[channel];
    if (!copy) {
      continue;
    }
    if (!copy.seedContentBlocks) {
      nextCopy[channel] = { ...copy, seedContentBlocks: blocks };
    }
  }

  return {
    ...decision,
    renderedCopy: nextCopy,
  };
}

/**
 * Tool-approval and tool-grant notifications need a Surface card with
 * Approve/Reject buttons on all decision paths.
 */
function enforceToolApprovalSeedBlocks(
  decision: NotificationDecision,
  signal: NotificationSignal,
): NotificationDecision {
  if (signal.sourceEventName !== "guardian.question") {
    return decision;
  }
  return ensureSeedContentBlocks(
    decision,
    buildToolApprovalSeedContentBlocks(signal.contextPayload),
  );
}

/**
 * Access-request notifications require deterministic instruction elements:
 * - Request-code approve/reject directive (when requestCode is present)
 * - Exact "open invite flow" phrase (always required)
 *
 * When requestCode IS present: use the full hasAccessRequestInstructions
 * check (approve+reject+invite) and append the complete contract text if
 * any element is missing.
 *
 * When requestCode is NOT present: still check for the invite-flow
 * directive and append it if missing. Per the documented contract, the
 * invite directive should always be present in access-request copy.
 */
function enforceAccessRequestInstructions(
  decision: NotificationDecision,
  signal: NotificationSignal,
): NotificationDecision {
  if (signal.sourceEventName !== "ingress.access_request") {
    return decision;
  }

  const rawCode = signal.contextPayload.requestCode;
  const hasRequestCode =
    typeof rawCode === "string" && rawCode.trim().length > 0;

  const nextCopy: Partial<Record<NotificationChannel, RenderedChannelCopy>> = {
    ...decision.renderedCopy,
  };

  if (hasRequestCode) {
    const requestCode = rawCode.trim().toUpperCase();
    const contractText = buildAccessRequestContractText(signal.contextPayload);
    const handshakeOffered = isHandshakeOfferedForPayload(
      parseAccessRequestPayload(signal.contextPayload),
    );

    for (const channel of Object.keys(nextCopy) as NotificationChannel[]) {
      const copy = nextCopy[channel];
      if (!copy) {
        continue;
      }
      nextCopy[channel] = ensureAccessRequestInstructionsInCopy(
        copy,
        requestCode,
        contractText,
        handshakeOffered,
      );
    }
  } else {
    // No requestCode — still enforce the invite-flow directive.
    const inviteDirective = buildAccessRequestInviteDirective();

    for (const channel of Object.keys(nextCopy) as NotificationChannel[]) {
      const copy = nextCopy[channel];
      if (!copy) {
        continue;
      }
      nextCopy[channel] = ensureInviteFlowDirectiveInCopy(
        copy,
        inviteDirective,
      );
    }
  }

  let result: NotificationDecision = {
    ...decision,
    renderedCopy: nextCopy,
  };

  // Ensure seedContentBlocks on all paths (LLM, assistant_tool, fallback).
  result = ensureSeedContentBlocks(
    result,
    buildAccessRequestSeedContentBlocks(signal.contextPayload),
  );

  return result;
}

function ensureAccessRequestInstructionsInCopy(
  copy: RenderedChannelCopy,
  requestCode: string,
  contractText: string,
  handshakeOffered: boolean,
): RenderedChannelCopy {
  const ensureText = (text: string | undefined): string => {
    const base = typeof text === "string" ? text.trim() : "";
    if (hasAccessRequestInstructions(base, requestCode, { handshakeOffered })) {
      return base;
    }
    return base.length > 0 ? `${base}\n\n${contractText}` : contractText;
  };

  return {
    ...copy,
    body: ensureText(copy.body),
    deliveryText: copy.deliveryText
      ? ensureText(copy.deliveryText)
      : copy.deliveryText,
    conversationSeedMessage: copy.conversationSeedMessage
      ? ensureText(copy.conversationSeedMessage)
      : copy.conversationSeedMessage,
  };
}

function ensureInviteFlowDirectiveInCopy(
  copy: RenderedChannelCopy,
  inviteDirective: string,
): RenderedChannelCopy {
  const ensureText = (text: string | undefined): string => {
    const base = typeof text === "string" ? text.trim() : "";
    if (hasInviteFlowDirective(base)) {
      return base;
    }
    return base.length > 0 ? `${base}\n\n${inviteDirective}` : inviteDirective;
  };

  return {
    ...copy,
    body: ensureText(copy.body),
    deliveryText: copy.deliveryText
      ? ensureText(copy.deliveryText)
      : copy.deliveryText,
    conversationSeedMessage: copy.conversationSeedMessage
      ? ensureText(copy.conversationSeedMessage)
      : copy.conversationSeedMessage,
  };
}

// ── Core evaluation function ───────────────────────────────────────────

export async function evaluateSignal(
  signal: NotificationSignal,
  availableChannels: NotificationChannel[],
  preferenceContext?: string,
): Promise<NotificationDecision> {
  // When no explicit preference context is provided, load the user's
  // stored notification preferences from the memory-backed store.
  // Wrapped in try/catch so a DB failure doesn't break the decision path.
  let resolvedPreferenceContext = preferenceContext;
  if (resolvedPreferenceContext === undefined) {
    try {
      resolvedPreferenceContext = getPreferenceSummary() ?? undefined;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.warn(
        { err: errMsg },
        "Failed to load preference summary, proceeding without preferences",
      );
      resolvedPreferenceContext = undefined;
    }
  }

  // Build conversation candidate set for reuse decisions. Wrapped in try/catch
  // so candidate lookup failures do not block the decision path.
  let candidateSet: ConversationCandidateSet | undefined;
  try {
    candidateSet = await buildConversationCandidates(availableChannels);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.warn(
      { err: errMsg },
      "Failed to build conversation candidates, proceeding without candidates",
    );
  }

  // Assistant-tool pass-through: when a producer hands us a verbatim
  // message body via contextPayload.requestedMessage, skip the LLM
  // classifier entirely. The producer has already done the routing and
  // copy decisions — we just enforce the standard post-decision guards
  // and persist the result.
  const requestedBody = nonEmpty(
    readPayloadString(signal.contextPayload, "requestedMessage"),
  );
  if (signal.sourceChannel === "assistant_tool" && requestedBody) {
    const payload = signal.contextPayload as Record<string, unknown>;
    const body = requestedBody;
    const title =
      nonEmpty(readPayloadString(signal.contextPayload, "requestedTitle")) ??
      deriveTitle(body);
    const isUrgent =
      signal.attentionHints.urgency === "critical" ||
      signal.attentionHints.urgency === "high";
    const defaultChannels: NotificationChannel[] = isUrgent
      ? [...availableChannels]
      : availableChannels.includes("vellum")
        ? ["vellum" as NotificationChannel]
        : [];
    // Honor `--preferred-channels` as ADDITIVE push targets on top of
    // the default channel set. The notification center (vellum) is the
    // always-on canonical inbox; preferred channels add push surfaces
    // on top, they never replace vellum. Disconnected channels are
    // filtered out so we never try to deliver on something unavailable.
    const preferredChannelsRaw = Array.isArray(payload.preferredChannels)
      ? (payload.preferredChannels as unknown[]).filter(
          (c): c is string => typeof c === "string",
        )
      : undefined;
    let selectedChannels = defaultChannels;
    if (preferredChannelsRaw && preferredChannelsRaw.length > 0) {
      const availableSet = new Set<string>(availableChannels);
      const preferredAvailable = preferredChannelsRaw.filter((c) =>
        availableSet.has(c),
      ) as NotificationChannel[];
      if (preferredAvailable.length > 0) {
        selectedChannels = Array.from(
          new Set<NotificationChannel>([
            ...selectedChannels,
            ...preferredAvailable,
          ]),
        );
      }
    }
    // Thread `--deep-link-metadata` through when supplied as a plain object.
    const deepLinkTarget =
      payload.deepLinkMetadata != null &&
      typeof payload.deepLinkMetadata === "object" &&
      !Array.isArray(payload.deepLinkMetadata)
        ? (payload.deepLinkMetadata as Record<string, unknown>)
        : undefined;
    // Populate renderedCopy and conversationActions for every available
    // channel — not just `selectedChannels`. Downstream guards
    // (routing-intent expansion in `enforceRoutingIntent`, urgency-forced
    // vellum prepending in `emit-signal`) may widen `selectedChannels`
    // beyond what we picked here. Pre-seeding copy for all channels ensures
    // the verbatim message survives those expansions rather than falling
    // back to an empty `composeFallbackCopy` body.
    let decision: NotificationDecision = {
      shouldNotify: selectedChannels.length > 0,
      selectedChannels,
      reasoningSummary: "assistant_tool pass-through",
      renderedCopy: Object.fromEntries(
        availableChannels.map((ch) => [
          ch,
          { title, body, conversationSeedMessage: body },
        ]),
      ) as NotificationDecision["renderedCopy"],
      conversationActions: Object.fromEntries(
        availableChannels.map((ch) => [ch, { action: "start_new" as const }]),
      ) as NotificationDecision["conversationActions"],
      dedupeKey: signal.signalId,
      confidence: 1.0,
      fallbackUsed: false,
      ...(deepLinkTarget ? { deepLinkTarget } : {}),
    };
    decision = enforceGuardianRequestCode(decision, signal);
    decision = enforceToolApprovalSeedBlocks(decision, signal);
    decision = enforceAccessRequestInstructions(decision, signal);
    decision = enforceGuardianCallConversationAffinity(decision, signal);
    decision = enforceConversationAffinity(
      decision,
      signal.conversationAffinityHint,
    );
    decision.persistedDecisionId = persistDecision(signal, decision);
    return decision;
  }

  const provider = await getConfiguredProvider("notificationDecision");
  if (!provider) {
    log.warn(
      "Configured provider unavailable for notification decision, using fallback",
    );
    let decision = buildFallbackDecision(signal, availableChannels);
    decision = enforceGuardianRequestCode(decision, signal);
    decision = enforceToolApprovalSeedBlocks(decision, signal);
    decision = enforceAccessRequestInstructions(decision, signal);
    decision = enforceGuardianCallConversationAffinity(decision, signal);
    decision = enforceConversationAffinity(
      decision,
      signal.conversationAffinityHint,
    );
    decision.persistedDecisionId = persistDecision(signal, decision);
    return decision;
  }

  let decision: NotificationDecision;
  try {
    decision = await classifyWithLLM(
      provider,
      signal,
      availableChannels,
      resolvedPreferenceContext,
      candidateSet,
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.warn(
      { err: errMsg },
      "Notification decision LLM call failed, using fallback",
    );
    decision = buildFallbackDecision(signal, availableChannels);
  }

  decision = enforceGuardianRequestCode(decision, signal);
  decision = enforceToolApprovalSeedBlocks(decision, signal);
  decision = enforceAccessRequestInstructions(decision, signal);
  decision = enforceGuardianCallConversationAffinity(decision, signal);
  decision = enforceConversationAffinity(
    decision,
    signal.conversationAffinityHint,
  );
  decision.persistedDecisionId = persistDecision(signal, decision);

  return decision;
}

// ── LLM classification ────────────────────────────────────────────────

async function classifyWithLLM(
  provider: Provider,
  signal: NotificationSignal,
  availableChannels: NotificationChannel[],
  preferenceContext: string | undefined,
  candidateSet?: ConversationCandidateSet,
): Promise<NotificationDecision> {
  const { signal: abortSignal, cleanup } = createTimeout(DECISION_TIMEOUT_MS);

  const candidateContext = candidateSet
    ? (serializeCandidatesForPrompt(candidateSet) ?? undefined)
    : undefined;
  const rawIdentityContext = buildCoreIdentityContext();
  const identityContext = rawIdentityContext
    ? truncate(rawIdentityContext, MAX_IDENTITY_CONTEXT_CHARS, "\n…[truncated]")
    : undefined;

  // Resolve guardian contact notes for recipient context. The guardian's
  // identity (ACL) comes from the gateway pull, channel-agnostic so notes are
  // available even when the only deliverable channel is "vellum". Notes (INFO)
  // stay local and are joined by contactId.
  let recipientNotes: string | undefined;
  try {
    const guardian = anyGuardian((await getGuardianDelivery()) ?? []);
    const notes = guardian
      ? findContactInfoById(guardian.contactId)?.notes
      : undefined;
    if (notes) {
      recipientNotes = truncate(
        notes,
        MAX_IDENTITY_CONTEXT_CHARS,
        "\n…[truncated]",
      );
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.warn(
      { err: errMsg },
      "Failed to resolve guardian contact notes, proceeding without recipient context",
    );
  }

  const systemPrompt = buildSystemPrompt(
    availableChannels,
    preferenceContext,
    candidateContext,
    identityContext,
    recipientNotes,
  );
  const prompt = buildUserPrompt(signal);
  const tool = buildDecisionTool(availableChannels);

  try {
    const response = await provider.sendMessage([userMessage(prompt)], {
      tools: [tool],
      systemPrompt,
      config: {
        callSite: "notificationDecision",
        max_tokens: 2048,
        tool_choice: {
          type: "tool" as const,
          name: "record_notification_decision",
        },
      },
      signal: abortSignal,
    });
    cleanup();

    const toolBlock = extractToolUse(response);
    if (!toolBlock) {
      log.warn(
        "No tool_use block in notification decision response, using fallback",
      );
      return buildFallbackDecision(signal, availableChannels);
    }

    const validated = validateDecisionOutput(
      toolBlock.input as Record<string, unknown>,
      availableChannels,
      candidateSet,
    );
    if (!validated) {
      log.warn("Invalid notification decision output from LLM, using fallback");
      return buildFallbackDecision(signal, availableChannels);
    }

    return validated;
  } finally {
    cleanup();
  }
}

// ── Post-decision routing intent enforcement ───────────────────────────

/**
 * Enforce routing intent policy on a decision after the LLM has produced it.
 * This is a fire-time guard: it overrides channel selection to match the
 * routing intent specified by the signal source (e.g. a reminder).
 *
 * - `all_channels`: force selected channels to all connected channels.
 * - `multi_channel`: ensure at least 2 channels when 2+ are connected.
 * - `single_channel`: cap to a single channel. When explicitly set, reduces
 *   selected channels to one — preferring the source channel if present.
 */
export function enforceRoutingIntent(
  decision: NotificationDecision,
  routingIntent: RoutingIntent | undefined,
  connectedChannels: NotificationChannel[],
  sourceChannel?: string,
): NotificationDecision {
  if (!routingIntent) {
    return decision;
  }

  if (routingIntent === "single_channel") {
    if (!decision.shouldNotify) {
      return decision;
    }

    // Force delivery to the source channel only. If the source channel
    // is among the connected channels, use it regardless of what the LLM
    // picked (even if the LLM picked exactly one wrong channel).
    // Otherwise fall back to capping at the first selected channel.
    const sourceIsConnected =
      sourceChannel &&
      connectedChannels.includes(sourceChannel as NotificationChannel);
    const preferred = sourceIsConnected
      ? (sourceChannel as NotificationChannel)
      : decision.selectedChannels[0];

    // No change needed if the decision already matches.
    if (
      decision.selectedChannels.length === 1 &&
      decision.selectedChannels[0] === preferred
    ) {
      return decision;
    }

    const enforced = { ...decision };
    enforced.selectedChannels = [preferred];
    enforced.reasoningSummary = `${decision.reasoningSummary} [routing_intent=single_channel enforced: capped to ${preferred}]`;
    log.info(
      {
        routingIntent,
        sourceChannel,
        originalChannels: decision.selectedChannels,
        enforcedChannel: preferred,
      },
      "Routing intent enforcement: single_channel → capped to one channel",
    );
    return enforced;
  }

  if (!decision.shouldNotify) {
    return decision;
  }

  if (routingIntent === "all_channels") {
    // Force all connected channels
    if (connectedChannels.length > 0) {
      const enforced = { ...decision };
      enforced.selectedChannels = [...connectedChannels];
      enforced.reasoningSummary = `${decision.reasoningSummary} [routing_intent=all_channels enforced: ${connectedChannels.join(", ")}]`;
      log.info(
        {
          routingIntent,
          connectedChannels,
          originalChannels: decision.selectedChannels,
        },
        "Routing intent enforcement: all_channels → forced all connected channels",
      );
      return enforced;
    }
  }

  if (routingIntent === "multi_channel") {
    // Ensure at least 2 channels when 2+ are connected
    if (connectedChannels.length >= 2 && decision.selectedChannels.length < 2) {
      const connectedSet = new Set<NotificationChannel>(connectedChannels);
      const selectedConnected = decision.selectedChannels.filter((ch) =>
        connectedSet.has(ch),
      );
      const expanded: NotificationChannel[] = [];
      const seen = new Set<NotificationChannel>();

      // Preserve the decision's selected channels first, then add connected
      // channels until we reach two channels total.
      for (const ch of selectedConnected) {
        if (seen.has(ch)) {
          continue;
        }
        expanded.push(ch);
        seen.add(ch);
      }
      for (const ch of connectedChannels) {
        if (seen.has(ch)) {
          continue;
        }
        expanded.push(ch);
        seen.add(ch);
        if (expanded.length >= 2) {
          break;
        }
      }

      const enforced = { ...decision };
      enforced.selectedChannels = expanded;
      enforced.reasoningSummary = `${decision.reasoningSummary} [routing_intent=multi_channel enforced: expanded to ${expanded.join(", ")}]`;
      log.info(
        {
          routingIntent,
          connectedChannels,
          originalChannels: decision.selectedChannels,
          enforcedChannels: expanded,
        },
        "Routing intent enforcement: multi_channel → expanded to at least two channels",
      );
      return enforced;
    }
  }

  return decision;
}

// ── Guardian call conversation affinity ──────────────────────────────────

/**
 * Force a new vellum conversation for the first guardian question in a phone call.
 *
 * When a guardian.question signal carries a callSessionId but has no
 * conversationAffinityHint, this is the first dispatch in a new call and
 * should get its own conversation. Without this guard the LLM might reuse a
 * conversation from a previous call. For subsequent dispatches within the same
 * call, the affinity hint already exists and enforceConversationAffinity
 * handles routing — so this guard is a no-op.
 */
export function enforceGuardianCallConversationAffinity(
  decision: NotificationDecision,
  signal: NotificationSignal,
): NotificationDecision {
  if (signal.sourceEventName !== "guardian.question") {
    return decision;
  }

  const callSessionId = signal.contextPayload?.callSessionId;
  if (typeof callSessionId !== "string" || callSessionId.trim().length === 0) {
    return decision;
  }

  // If an affinity hint already exists for vellum, the second+ dispatch
  // will be handled by enforceConversationAffinity — nothing to do here.
  if (signal.conversationAffinityHint?.vellum) {
    return decision;
  }

  const enforced = { ...decision };
  const conversationActions: Partial<
    Record<NotificationChannel, ConversationAction>
  > = {
    ...(decision.conversationActions ?? {}),
  };
  conversationActions.vellum = { action: "start_new" };
  enforced.conversationActions = conversationActions;

  log.info(
    { callSessionId },
    "Guardian call conversation affinity: first question in call — forcing start_new for vellum",
  );

  return enforced;
}

// ── Conversation affinity enforcement ───────────────────────────────────

/**
 * Enforce conversation affinity on a decision.
 *
 * When the signal carries a conversationAffinityHint (per-channel map of
 * conversationId), override the decision's conversationActions for those channels
 * to `reuse_existing` with the hinted conversationId. This is a
 * deterministic post-decision guard that prevents the LLM from routing
 * guardian questions for the same call session to different conversations.
 */
function enforceConversationAffinity(
  decision: NotificationDecision,
  affinityHint: Partial<Record<string, string>> | undefined,
): NotificationDecision {
  if (!affinityHint) {
    return decision;
  }

  const entries = Object.entries(affinityHint).filter(
    ([, conversationId]) =>
      typeof conversationId === "string" && conversationId.length > 0,
  );
  if (entries.length === 0) {
    return decision;
  }

  const enforced = { ...decision };
  const conversationActions: Partial<
    Record<NotificationChannel, ConversationAction>
  > = {
    ...(decision.conversationActions ?? {}),
  };

  for (const [channel, conversationId] of entries) {
    conversationActions[channel as NotificationChannel] = {
      action: "reuse_existing",
      conversationId: conversationId!,
    };
  }

  enforced.conversationActions = conversationActions;

  log.info(
    { affinityHint },
    "Conversation affinity enforcement: overrode conversationActions for hinted channels",
  );

  return enforced;
}

// ── Persistence ────────────────────────────────────────────────────────

function persistDecision(
  signal: NotificationSignal,
  decision: NotificationDecision,
): string | undefined {
  try {
    const decisionId = uuid();

    // Summarize conversation actions for the audit trail
    const conversationActionSummary: Record<string, string> = {};
    if (decision.conversationActions) {
      for (const [ch, ta] of Object.entries(decision.conversationActions)) {
        if (ta.action === "reuse_existing") {
          conversationActionSummary[ch] = `reuse:${ta.conversationId}`;
        } else {
          conversationActionSummary[ch] = "start_new";
        }
      }
    }

    createDecision({
      id: decisionId,
      notificationEventId: signal.signalId,
      shouldNotify: decision.shouldNotify,
      selectedChannels: decision.selectedChannels,
      reasoningSummary: decision.reasoningSummary,
      confidence: decision.confidence,
      fallbackUsed: decision.fallbackUsed,
      promptVersion: PROMPT_VERSION,
      validationResults: {
        dedupeKey: decision.dedupeKey,
        channelCount: decision.selectedChannels.length,
        hasCopy: Object.keys(decision.renderedCopy).length > 0,
        ...(Object.keys(conversationActionSummary).length > 0
          ? { conversationActions: conversationActionSummary }
          : {}),
      },
    });
    return decisionId;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.warn({ err: errMsg }, "Failed to persist notification decision");
    return undefined;
  }
}
