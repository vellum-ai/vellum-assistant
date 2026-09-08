/**
 * Shared request-kind and instruction-mode resolver for guardian.question signals.
 *
 * Explicit request kinds provide a stable contract between producers and
 * notification rendering logic, avoiding implicit inference from incidental
 * fields like `toolName`.
 *
 * Payload shapes are defined as Zod schemas — single source of truth for
 * both runtime validation and TypeScript types.
 * https://zod.dev/?id=basic-usage
 */

import { z } from "zod";

import { externalSourceLinkSchema } from "../messaging/channel-binding-schema.js";
import { isSlackDmConversation } from "../messaging/providers/slack/message-metadata.js";
import {
  nonEmpty,
  stripReplyMechanicsFromCopy,
  stripRequestCodeDirectives,
} from "./notification-utils.js";
import type { RenderedChannelCopy } from "./types.js";

// ── Schema primitives ──────────────────────────────────────────────────

export const GuardianQuestionRequestKindSchema = z.enum([
  "pending_question",
  "tool_approval",
  "tool_grant_request",
  "access_request",
]);

export type GuardianQuestionRequestKind = z.infer<
  typeof GuardianQuestionRequestKindSchema
>;

type GuardianQuestionInstructionMode = "approval" | "answer";

interface GuardianRequestKindModeConfig {
  defaultMode: GuardianQuestionInstructionMode;
  modeWhenToolNamePresent?: GuardianQuestionInstructionMode;
}

const REQUEST_KIND_MODE_CONFIG: Record<
  GuardianQuestionRequestKind,
  GuardianRequestKindModeConfig
> = {
  pending_question: {
    defaultMode: "answer",
    modeWhenToolNamePresent: "approval",
  },
  tool_approval: {
    defaultMode: "approval",
  },
  tool_grant_request: {
    defaultMode: "approval",
  },
  access_request: {
    defaultMode: "approval",
  },
};

// ── Zod schemas for guardian.question payloads ──────────────────────────

const GuardianQuestionPayloadBaseSchema = z.object({
  requestId: z.string().min(1),
  requestCode: z.string().min(1),
  questionText: z.string().min(1),
  /** Channel the request originated from. Set by producers but previously
   *  invisible to the type system (passed via index signature). */
  sourceChannel: z.string().optional(),
  /** Display name or identifier of the requester. */
  requesterIdentifier: z.string().optional(),
  /** External user ID of the requester (e.g. Slack user ID). */
  requesterExternalUserId: z.string().optional(),
  /** External chat ID of the requester. */
  requesterChatId: z.string().nullable().optional(),
});

export const PendingQuestionPayloadSchema =
  GuardianQuestionPayloadBaseSchema.extend({
    requestKind: z.literal("pending_question"),
    /** Present only for voice-call questions; absent for ask_question prompts. */
    callSessionId: z.string().min(1).optional(),
    activeGuardianRequestCount: z.number().optional(),
    toolName: z.string().optional(),
    /**
     * Structured answer options for an ask_question prompt (2–4 entries).
     * When present, the broadcaster renders them as tappable option actions
     * (see {@link buildQuestionOptionActionId}); absent payloads render as
     * plain text with request-code reply instructions.
     */
    options: z
      .array(z.object({ id: z.string().min(1), label: z.string().min(1) }))
      .optional(),
  });

/**
 * Channel-neutral reference to the message that triggered the approval,
 * resolved per-channel by `runtime/approval-source-link.ts` (currently only
 * Slack registers a resolver). Card renderers consume it via
 * {@link buildToolApprovalSourceView} without channel-format knowledge.
 */
const sourceReferenceFields = {
  /** Channel-native chat/conversation id the request originated from. */
  sourceChatId: z.string().optional(),
  /** Display name of the originating chat, when ingress captured one. */
  sourceChatName: z.string().optional(),
  /** Deep link to the originating message/thread, when derivable. */
  sourceLink: externalSourceLinkSchema.optional(),
};

export const ToolApprovalPayloadSchema =
  GuardianQuestionPayloadBaseSchema.extend({
    requestKind: z.literal("tool_approval"),
    toolName: z.string().min(1),
    /** Risk classification from the permission checker (e.g. "low", "medium", "high"). */
    riskLevel: z.string().optional(),
    /** Secret-redacted summary of the tool invocation arguments. */
    commandPreview: z.string().optional(),
    ...sourceReferenceFields,
  });

export const ToolGrantPayloadSchema = GuardianQuestionPayloadBaseSchema.extend({
  requestKind: z.literal("tool_grant_request"),
  toolName: z.string().min(1),
  /** Risk classification from the permission checker (e.g. "low", "medium", "high"). */
  riskLevel: z.string().optional(),
  /** Secret-redacted summary of the tool invocation arguments. */
  commandPreview: z.string().optional(),
  ...sourceReferenceFields,
});

export const AccessRequestGuardianPayloadSchema =
  GuardianQuestionPayloadBaseSchema.extend({
    requestKind: z.literal("access_request"),
  });

export const GuardianQuestionPayloadSchema = z.discriminatedUnion(
  "requestKind",
  [
    PendingQuestionPayloadSchema,
    ToolApprovalPayloadSchema,
    ToolGrantPayloadSchema,
    AccessRequestGuardianPayloadSchema,
  ],
);

/**
 * Lenient schema for tool-approval rendering. Requires only `requestKind`
 * (for mode detection) — everything else is optional. Handles partially
 * constructed payloads that don't satisfy the strict discriminated union
 * (e.g. missing `callSessionId` on a `pending_question` with `toolName`).
 *
 * Used by `buildToolApprovalSeedContentBlocks` which must degrade
 * gracefully rather than refuse to render when optional card fields
 * are absent.
 */
export const LenientToolApprovalPayloadSchema = z.object({
  requestKind: GuardianQuestionRequestKindSchema,
  requestId: z.string().nullable().optional(),
  requestCode: z.string().nullable().optional(),
  questionText: z.string().nullable().optional(),
  toolName: z.string().nullable().optional(),
  sourceChannel: z.string().nullable().optional(),
  requesterIdentifier: z.string().nullable().optional(),
  requesterExternalUserId: z.string().nullable().optional(),
  requesterChatId: z.string().nullable().optional(),
  riskLevel: z.string().nullable().optional(),
  commandPreview: z.string().nullable().optional(),
  sourceChatId: z.string().nullable().optional(),
  sourceChatName: z.string().nullable().optional(),
  sourceLink: sourceReferenceFields.sourceLink.nullable(),
});

export type LenientToolApprovalPayload = z.infer<
  typeof LenientToolApprovalPayloadSchema
>;

// ── Source reference projection ─────────────────────────────────────────

/**
 * Display-ready source reference for a tool-approval card, shared by every
 * renderer (the Vellum Surface card and the channel adapters) so the
 * chat-id/permalink derivation lives in exactly one place. Declared as a
 * Zod schema because the broadcaster carries the projected view on
 * `ChannelDeliveryPayload` (computed once per broadcast, never re-derived
 * per channel).
 *
 * Core fields (`channel`, `chatId`, `permalink`) are channel-neutral.
 * Channel-scoped display facts are named for their channel (`isSlackDm`)
 * and gated on `channel` — renderers branch on them for richer labels but
 * must degrade to the neutral fields for every other channel, so a new
 * channel renders correctly with no projection changes.
 */
export const ToolApprovalSourceViewSchema = z.object({
  /** Channel the request originated from (e.g. `"slack"`). */
  channel: z.string(),
  /** Channel-native chat id, when the payload carries one. */
  chatId: z.string().optional(),
  /** Display name of the originating chat, when ingress captured one. */
  chatName: z.string().optional(),
  /** Whether the source chat is a Slack direct message (`false` for other channels). */
  isSlackDm: z.boolean(),
  /** Link to the originating message/thread, when derivable. */
  permalink: z.string().optional(),
});

export type ToolApprovalSourceView = z.infer<
  typeof ToolApprovalSourceViewSchema
>;

/**
 * Project a tool-approval payload's source reference into display-ready
 * facts. Returns `undefined` when the payload names no chat and carries no
 * link — renderers then fall back to the plain channel label.
 */
/**
 * Bare display label for the source chat, derived once for every
 * renderer: `Direct message` for a DM, `#name` for a named channel,
 * `#<id>` when only the id is known, empty when the view names no chat.
 * Slack-scoped like the facts it reads; surfaces add their own framing
 * (the card prefixes the channel word, the bell uses it bare).
 */
export function describeSlackChatLabel(
  view: Pick<ToolApprovalSourceView, "chatId" | "chatName" | "isSlackDm">,
): string {
  if (view.isSlackDm) {
    return "Direct message";
  }
  if (view.chatName) {
    return `#${view.chatName}`;
  }
  if (view.chatId) {
    return `#${view.chatId}`;
  }
  return "";
}

export function buildToolApprovalSourceView(
  p: Pick<
    LenientToolApprovalPayload,
    | "sourceChannel"
    | "sourceChatId"
    | "sourceChatName"
    | "sourceLink"
    | "requesterChatId"
  >,
): ToolApprovalSourceView | undefined {
  const channel = nonEmpty(p.sourceChannel);
  if (!channel) {
    return undefined;
  }
  const chatId = nonEmpty(p.sourceChatId) ?? nonEmpty(p.requesterChatId);
  const permalink =
    nonEmpty(p.sourceLink?.webUrl) ?? nonEmpty(p.sourceLink?.appUrl);
  if (!chatId && !permalink) {
    return undefined;
  }

  return {
    channel,
    chatId,
    chatName: nonEmpty(p.sourceChatName),
    isSlackDm:
      channel === "slack" && chatId != null && isSlackDmConversation(chatId),
    permalink,
  };
}

// ── Answer-option action tokens ─────────────────────────────────────────

/**
 * Action-id scheme for answer-mode option buttons on a `pending_question`
 * card. The broadcaster builds card actions with these ids (so every channel
 * adapter renders them without knowing they're question options), the reply
 * router recognizes a tapped id as an answer selection rather than an
 * approval action, and the question resolver maps the index back to the
 * pending interaction's option. Index-based (not the raw option id) so the
 * channel callback stays small and the LLM-supplied option id never rides
 * the wire.
 */
export const QUESTION_SKIP_ACTION_ID = "answer_skip";

/** Action id for the option at `index` on a question card. */
export function buildQuestionOptionActionId(index: number): string {
  return `answer_${index}`;
}

/**
 * The full answer action set for a question's options: one action per option
 * in the interaction's own order, then an explicit skip.
 *
 * Shared because a question is rendered twice from the same options, once as
 * an approval-metadata action set for a channel transport and once as card
 * actions on the in-app surface, and the two must agree: the resolver maps
 * the index back to the pending interaction, so a divergence answers the
 * wrong option rather than failing.
 */
/**
 * The message text for a question that must be answered: the question, its
 * options numbered as they are ordered, and how to reply by reference code.
 *
 * Deterministic on purpose. A notification's channel copy is otherwise
 * composed by the decision engine, and a question is the one payload that
 * cannot survive being paraphrased: the guardian is being asked to choose
 * between these words, so the words have to arrive.
 */
export function buildQuestionDeliveryText(p: {
  questionText: string;
  options?: readonly { label: string }[];
}): string {
  const parts = [p.questionText];
  const options = p.options ?? [];
  if (options.length > 0) {
    parts.push(
      options
        .map((option, index) => `${index + 1}. ${option.label}`)
        .join("\n"),
    );
  }
  return parts.join("\n\n");
}

export function buildQuestionAnswerActions(
  options: readonly { label: string }[],
): Array<{ id: string; label: string }> {
  if (options.length === 0) {
    return [];
  }
  return [
    ...options.map((option, index) => ({
      id: buildQuestionOptionActionId(index),
      label: option.label,
    })),
    { id: QUESTION_SKIP_ACTION_ID, label: "Skip" },
  ];
}

export type QuestionAnswerSelection =
  | { kind: "option"; index: number }
  | { kind: "skip" };

/**
 * Parse an action token from a question card. Returns `null` for anything
 * that is not an answer-option token (including ordinary approval actions),
 * so callers can fall through to approval handling.
 */
export function parseQuestionAnswerActionId(
  token: string,
): QuestionAnswerSelection | null {
  if (token === QUESTION_SKIP_ACTION_ID) {
    return { kind: "skip" };
  }
  const match = /^answer_(\d+)$/.exec(token);
  if (!match) {
    return null;
  }
  const index = Number(match[1]);
  if (!Number.isInteger(index) || index < 0) {
    return null;
  }
  return { kind: "option", index };
}

interface GuardianRequestModeInput {
  kind: unknown;
  toolName?: unknown;
}

interface GuardianRequestTextInput {
  requestCode: string;
  questionText?: string | null;
  toolName?: string | null;
}

type GuardianDisambiguationCategory = "questions" | "approvals";

interface GuardianModeTextConfig {
  invalidActionWithCode: (requestCode: string) => string;
  invalidActionWithoutCode: string;
  buildCodeOnlyHeader: (request: GuardianRequestTextInput) => string;
  buildCodeOnlyDetailLine: (request: GuardianRequestTextInput) => string | null;
  buildDisambiguationLabel: (
    request: Pick<GuardianRequestTextInput, "questionText" | "toolName">,
  ) => string;
  disambiguationCategory: GuardianDisambiguationCategory;
}

const MODE_TEXT_CONFIG: Record<
  GuardianQuestionInstructionMode,
  GuardianModeTextConfig
> = {
  answer: {
    invalidActionWithCode: (requestCode) =>
      `I found request ${requestCode}, but I still need your answer. Reply "${requestCode} <your answer>".`,
    invalidActionWithoutCode:
      'I couldn\'t determine your answer. Reply with the request code followed by your answer (e.g., "ABC123 3pm works").',
    buildCodeOnlyHeader: (request) =>
      `I found question ${request.requestCode}.`,
    buildCodeOnlyDetailLine: (request) =>
      request.questionText ? `Question: ${request.questionText}` : null,
    buildDisambiguationLabel: (request) => request.questionText ?? "question",
    disambiguationCategory: "questions",
  },
  approval: {
    invalidActionWithCode: (requestCode) =>
      `I found request ${requestCode}, but I need to know your decision. Reply "${requestCode} approve" or "${requestCode} reject".`,
    invalidActionWithoutCode:
      "I couldn't determine your intended action. Reply with the request code followed by 'approve' or 'reject' (e.g., \"ABC123 approve\").",
    buildCodeOnlyHeader: (request) =>
      `I found request ${request.requestCode} for ${
        request.toolName ?? "an action"
      }.`,
    buildCodeOnlyDetailLine: (request) =>
      request.questionText ? `Details: ${request.questionText}` : null,
    buildDisambiguationLabel: (request) =>
      request.toolName ?? request.questionText ?? "action",
    disambiguationCategory: "approvals",
  },
};

// ── Derived TypeScript types ─────────────────────────────────────────────

export type PendingQuestionGuardianPayload = z.infer<
  typeof PendingQuestionPayloadSchema
>;
export type ToolApprovalGuardianPayload = z.infer<
  typeof ToolApprovalPayloadSchema
>;
export type ToolGrantGuardianPayload = z.infer<typeof ToolGrantPayloadSchema>;
export type AccessRequestGuardianPayload = z.infer<
  typeof AccessRequestGuardianPayloadSchema
>;
export type GuardianQuestionPayload = z.infer<
  typeof GuardianQuestionPayloadSchema
>;

interface GuardianQuestionModeResolution {
  mode: GuardianQuestionInstructionMode;
  requestKind: GuardianQuestionRequestKind | null;
}

// ── Payload parsing ────────────────────────────────────────────────────

/**
 * Parse a guardian.question context payload into a strict discriminated union
 * using Zod validation. Returns null when the payload is missing required
 * fields or has an unknown/missing requestKind.
 */
export function parseGuardianQuestionPayload(
  payload: Record<string, unknown>,
): GuardianQuestionPayload | null {
  const result = GuardianQuestionPayloadSchema.safeParse(payload);
  return result.success ? result.data : null;
}

function resolveGuardianInstructionModeForRequestKind(
  requestKind: GuardianQuestionRequestKind,
  toolName?: string | null,
): GuardianQuestionInstructionMode {
  const config = REQUEST_KIND_MODE_CONFIG[requestKind];
  const normalizedToolName = nonEmpty(toolName ?? undefined) ?? null;
  if (normalizedToolName && config.modeWhenToolNamePresent) {
    return config.modeWhenToolNamePresent;
  }

  return config.defaultMode;
}

export function resolveGuardianInstructionModeFromFields(
  requestKindValue: unknown,
  toolNameValue: unknown,
): {
  requestKind: GuardianQuestionRequestKind;
  mode: GuardianQuestionInstructionMode;
} | null {
  const parsed = GuardianQuestionRequestKindSchema.safeParse(requestKindValue);
  if (!parsed.success) {
    return null;
  }

  return {
    requestKind: parsed.data,
    mode: resolveGuardianInstructionModeForRequestKind(
      parsed.data,
      typeof toolNameValue === "string" ? toolNameValue : null,
    ),
  };
}

export function resolveGuardianInstructionModeForRequest(
  request?: GuardianRequestModeInput | null,
): GuardianQuestionInstructionMode {
  if (!request) {
    return "approval";
  }
  const modeResolution = resolveGuardianInstructionModeFromFields(
    request.kind,
    request.toolName,
  );
  if (!modeResolution) {
    return "approval";
  }
  return modeResolution.mode;
}

/**
 * Resolve instruction mode directly from a typed guardian question payload.
 * Avoids re-parsing when the caller already holds a validated payload.
 */
export function resolveGuardianInstructionModeFromPayload(
  payload: GuardianQuestionPayload,
): GuardianQuestionModeResolution {
  const toolName = "toolName" in payload ? payload.toolName : undefined;
  return {
    mode: resolveGuardianInstructionModeForRequestKind(
      payload.requestKind,
      toolName ?? null,
    ),
    requestKind: payload.requestKind,
  };
}

function getModeTextConfig(
  mode: GuardianQuestionInstructionMode,
): GuardianModeTextConfig {
  return MODE_TEXT_CONFIG[mode];
}

export function buildGuardianReplyDirective(
  requestCode: string,
  mode: GuardianQuestionInstructionMode,
): string {
  switch (mode) {
    case "approval":
      return `Reply "${requestCode} approve" or "${requestCode} reject".`;
    case "answer":
      return `Reply "${requestCode} <your answer>".`;
    default: {
      const _never: never = mode;
      return _never;
    }
  }
}

export function buildGuardianRequestCodeInstruction(
  requestCode: string,
  mode: GuardianQuestionInstructionMode,
): string {
  return `Reference code: ${requestCode}. ${buildGuardianReplyDirective(
    requestCode,
    mode,
  )}`;
}

export function buildGuardianInvalidActionReply(
  mode: GuardianQuestionInstructionMode,
  requestCode?: string,
): string {
  const config = getModeTextConfig(mode);
  if (requestCode) {
    return config.invalidActionWithCode(requestCode);
  }
  return config.invalidActionWithoutCode;
}

export function buildGuardianCodeOnlyClarification(
  mode: GuardianQuestionInstructionMode,
  request: GuardianRequestTextInput,
): string {
  const config = getModeTextConfig(mode);
  const lines = [config.buildCodeOnlyHeader(request)];
  const detailLine = config.buildCodeOnlyDetailLine(request);
  if (detailLine) {
    lines.push(detailLine);
  }
  lines.push(buildGuardianReplyDirective(request.requestCode, mode));
  return lines.join("\n");
}

export function buildGuardianDisambiguationLabel(
  mode: GuardianQuestionInstructionMode,
  request: Pick<GuardianRequestTextInput, "questionText" | "toolName">,
): string {
  return getModeTextConfig(mode).buildDisambiguationLabel(request);
}

export function buildGuardianDisambiguationExample(
  mode: GuardianQuestionInstructionMode,
  requestCode: string,
): string {
  const category = getModeTextConfig(mode).disambiguationCategory;
  const replyDirective = buildGuardianReplyDirective(requestCode, mode);
  return `For ${category}: ${replyDirective.replace(/^Reply/, "reply")}`;
}

/**
 * Parse a guardian.question payload that renders channel-native
 * Approve/Reject actions on button-capable channels: it parses strictly,
 * resolves to approval mode, and carries the requestId the action
 * callbacks target. Returns `null` otherwise — those payloads render as
 * plain text and rely on request-code replies.
 */
export function parseInteractiveApprovalPayload(
  payload: Record<string, unknown>,
): GuardianQuestionPayload | null {
  const parsed = parseGuardianQuestionPayload(payload);
  if (!parsed) {
    return null;
  }
  const { mode } = resolveGuardianInstructionModeFromPayload(parsed);
  if (mode !== "approval") {
    return null;
  }
  return nonEmpty(parsed.requestId) ? parsed : null;
}

// ── Reply mechanics ─────────────────────────────────────────────────────

/**
 * Remove request-code reply mechanics from one channel's copy of a
 * `guardian.question` signal. Composed copy never carries them: the
 * broadcaster's `plainTextFallback` does, and a transport appends it only
 * when it sends text without buttons. What this removes is the model's own
 * echo of the mechanics, in either mode, plus bare code mentions; a field
 * left empty becomes the request's question text.
 */
export function stripGuardianReplyMechanicsFromCopy(
  copy: RenderedChannelCopy,
  requestCode: string,
  questionText: string | undefined,
): RenderedChannelCopy {
  return stripReplyMechanicsFromCopy(copy, {
    strip: (text) => stripRequestCodeDirectives(text, requestCode),
    ask: questionText,
    headline: GUARDIAN_QUESTION_TITLE,
  });
}

/**
 * The deterministic title for a `guardian.question` notification: the
 * template composer's own, and what a title that was nothing but reply
 * mechanics becomes.
 */
export const GUARDIAN_QUESTION_TITLE = "Guardian Question";

/**
 * Resolve guardian reply instruction mode from a raw context payload.
 *
 * Attempts Zod-based parsing first. When that fails, falls back to
 * field-level requestKind resolution. Defaults to "approval" mode
 * when requestKind is missing or unknown.
 */
export function resolveGuardianQuestionInstructionMode(
  payload: Record<string, unknown>,
): GuardianQuestionModeResolution {
  const parsed = parseGuardianQuestionPayload(payload);
  if (parsed) {
    return resolveGuardianInstructionModeFromPayload(parsed);
  }

  const requestKindResolution = resolveGuardianInstructionModeFromFields(
    payload.requestKind,
    payload.toolName,
  );
  if (requestKindResolution) {
    return {
      mode: requestKindResolution.mode,
      requestKind: requestKindResolution.requestKind,
    };
  }

  return {
    mode: "approval",
    requestKind: null,
  };
}
