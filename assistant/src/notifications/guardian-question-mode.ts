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

import { nonEmpty } from "./notification-utils.js";

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
    callSessionId: z.string().min(1),
    activeGuardianRequestCount: z.number(),
    toolName: z.string().optional(),
  });

export const ToolApprovalPayloadSchema =
  GuardianQuestionPayloadBaseSchema.extend({
    requestKind: z.literal("tool_approval"),
    toolName: z.string().min(1),
    /** Risk classification from the permission checker (e.g. "low", "medium", "high"). */
    riskLevel: z.string().optional(),
    /** Secret-redacted summary of the tool invocation arguments. */
    commandPreview: z.string().optional(),
  });

export const ToolGrantPayloadSchema = GuardianQuestionPayloadBaseSchema.extend({
  requestKind: z.literal("tool_grant_request"),
  toolName: z.string().min(1),
  /** Risk classification from the permission checker (e.g. "low", "medium", "high"). */
  riskLevel: z.string().optional(),
  /** Secret-redacted summary of the tool invocation arguments. */
  commandPreview: z.string().optional(),
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
});

export type LenientToolApprovalPayload = z.infer<
  typeof LenientToolApprovalPayloadSchema
>;

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
  if (!parsed.success) return null;

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
  if (!request) return "approval";
  const modeResolution = resolveGuardianInstructionModeFromFields(
    request.kind,
    request.toolName,
  );
  if (!modeResolution) return "approval";
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
  if (requestCode) return config.invalidActionWithCode(requestCode);
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

export function hasGuardianRequestCodeInstruction(
  text: string | undefined,
  requestCode: string,
  mode: GuardianQuestionInstructionMode,
): boolean {
  if (typeof text !== "string") return false;
  const upper = text.toUpperCase();
  const normalizedCode = requestCode.toUpperCase();

  switch (mode) {
    case "approval":
      return (
        upper.includes(`${normalizedCode} APPROVE`) &&
        upper.includes(`${normalizedCode} REJECT`)
      );
    case "answer": {
      const hasAnswerInstruction = upper.includes(
        `${normalizedCode} <YOUR ANSWER>`,
      );
      const hasApprovalInstruction =
        upper.includes(`${normalizedCode} APPROVE`) ||
        upper.includes(`${normalizedCode} REJECT`);
      return hasAnswerInstruction && !hasApprovalInstruction;
    }
    default: {
      const _never: never = mode;
      return _never;
    }
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeInstructionText(value: string): string {
  return value
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildApprovalInstructionPattern(escapedCode: string): RegExp {
  return new RegExp(
    `(?:Reference\\s+code:\\s*${escapedCode}\\.?\\s*)?Reply\\s+"${escapedCode}\\s+approve"\\s+or\\s+"${escapedCode}\\s+reject"\\.?`,
    "ig",
  );
}

function buildAnswerInstructionPattern(escapedCode: string): RegExp {
  return new RegExp(
    `(?:Reference\\s+code:\\s*${escapedCode}\\.?\\s*)?Reply\\s+"${escapedCode}\\s+<your\\s+answer>"\\.?`,
    "ig",
  );
}

export function stripConflictingGuardianRequestInstructions(
  text: string,
  requestCode: string,
  mode: GuardianQuestionInstructionMode,
): string {
  const escapedCode = escapeRegExp(requestCode);
  const next =
    mode === "answer"
      ? text.replace(buildApprovalInstructionPattern(escapedCode), "")
      : text.replace(buildAnswerInstructionPattern(escapedCode), "");

  return normalizeInstructionText(next);
}

/**
 * Remove every request-code reply instruction (both modes) plus bare
 * "Reference code: X." / "Approval code: X." mentions from copy destined
 * for a surface that renders interactive Approve/Reject buttons, where
 * code-reply instructions are redundant noise.
 */
export function stripGuardianRequestCodeInstructions(
  text: string,
  requestCode: string,
): string {
  const escapedCode = escapeRegExp(requestCode);
  const next = text
    .replace(buildApprovalInstructionPattern(escapedCode), "")
    .replace(buildAnswerInstructionPattern(escapedCode), "")
    .replace(
      new RegExp(`(?:Reference|Approval)\\s+code:\\s*${escapedCode}\\.?`, "ig"),
      "",
    );

  return normalizeInstructionText(next);
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
