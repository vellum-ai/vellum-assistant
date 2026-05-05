/**
 * Shared request-kind and instruction-mode resolver for guardian.question signals.
 *
 * Explicit request kinds provide a stable contract between producers and
 * notification rendering logic, avoiding implicit inference from incidental
 * fields like `toolName`.
 */

type GuardianQuestionRequestKind =
  | "pending_question"
  | "tool_approval"
  | "tool_grant_request"
  | "access_request";
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

interface GuardianQuestionPayloadBase {
  requestId: string;
  requestCode: string;
  questionText: string;
}

interface GuardianQuestionPayloadBaseWithDiscriminator extends GuardianQuestionPayloadBase {
  requestKind: GuardianQuestionRequestKind;
  [key: string]: unknown;
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

export interface PendingQuestionGuardianPayload extends GuardianQuestionPayloadBaseWithDiscriminator {
  requestKind: "pending_question";
  callSessionId: string;
  activeGuardianRequestCount: number;
  /**
   * Voice tool-approval requests are persisted as pending_question with tool
   * metadata so they still route through pending-question resolution.
   */
  toolName?: string;
}

export interface ToolApprovalGuardianPayload extends GuardianQuestionPayloadBaseWithDiscriminator {
  requestKind: "tool_approval";
  toolName: string;
}

export interface ToolGrantGuardianPayload extends GuardianQuestionPayloadBaseWithDiscriminator {
  requestKind: "tool_grant_request";
  toolName: string;
}

export interface AccessRequestGuardianPayload extends GuardianQuestionPayloadBaseWithDiscriminator {
  requestKind: "access_request";
}

export type GuardianQuestionPayload =
  | PendingQuestionGuardianPayload
  | ToolApprovalGuardianPayload
  | ToolGrantGuardianPayload
  | AccessRequestGuardianPayload;

interface GuardianQuestionModeResolution {
  mode: GuardianQuestionInstructionMode;
  requestKind: GuardianQuestionRequestKind | null;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseGuardianQuestionRequestKind(
  payload: Record<string, unknown>,
): GuardianQuestionRequestKind | null {
  const raw = nonEmptyString(payload.requestKind);
  if (!raw) return null;

  switch (raw) {
    case "pending_question":
    case "tool_approval":
    case "tool_grant_request":
    case "access_request":
      return raw;
    default:
      return null;
  }
}

function parseBasePayload(
  payload: Record<string, unknown>,
): GuardianQuestionPayloadBase | null {
  const requestId = nonEmptyString(payload.requestId);
  const requestCode = nonEmptyString(payload.requestCode);
  const questionText = nonEmptyString(payload.questionText);
  if (!requestId || !requestCode || !questionText) return null;
  return { requestId, requestCode, questionText };
}

/**
 * Parse a guardian.question context payload into a strict discriminated union.
 *
 * Returns null when required fields for the declared requestKind are missing,
 * or when requestKind is absent/unknown.
 */
export function parseGuardianQuestionPayload(
  payload: Record<string, unknown>,
): GuardianQuestionPayload | null {
  const requestKind = parseGuardianQuestionRequestKind(payload);
  if (!requestKind) return null;

  const base = parseBasePayload(payload);
  if (!base) return null;

  switch (requestKind) {
    case "pending_question": {
      const callSessionId = nonEmptyString(payload.callSessionId);
      const activeGuardianRequestCount =
        typeof payload.activeGuardianRequestCount === "number"
          ? payload.activeGuardianRequestCount
          : undefined;
      const toolName = nonEmptyString(payload.toolName);
      if (
        !callSessionId ||
        activeGuardianRequestCount === undefined ||
        Number.isNaN(activeGuardianRequestCount)
      ) {
        return null;
      }
      const pendingQuestionPayload: PendingQuestionGuardianPayload = {
        requestKind,
        ...base,
        callSessionId,
        activeGuardianRequestCount,
      };
      if (toolName) {
        pendingQuestionPayload.toolName = toolName;
      }
      return {
        ...pendingQuestionPayload,
      };
    }
    case "tool_approval":
    case "tool_grant_request": {
      const toolName = nonEmptyString(payload.toolName);
      if (!toolName) return null;
      return {
        requestKind,
        ...base,
        toolName,
      };
    }
    case "access_request":
      return {
        requestKind,
        ...base,
      };
    default:
      return null;
  }
}

function resolveGuardianInstructionModeForRequestKind(
  requestKind: GuardianQuestionRequestKind,
  toolName?: string | null,
): GuardianQuestionInstructionMode {
  const config = REQUEST_KIND_MODE_CONFIG[requestKind];
  const normalizedToolName = nonEmptyString(toolName);
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
  const requestKind = parseGuardianQuestionRequestKind({
    requestKind: requestKindValue,
  });
  if (!requestKind) return null;

  return {
    requestKind,
    mode: resolveGuardianInstructionModeForRequestKind(
      requestKind,
      nonEmptyString(toolNameValue),
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

export function stripConflictingGuardianRequestInstructions(
  text: string,
  requestCode: string,
  mode: GuardianQuestionInstructionMode,
): string {
  const escapedCode = escapeRegExp(requestCode);
  const approvalInstructionPattern = new RegExp(
    `(?:Reference\\s+code:\\s*${escapedCode}\\.?\\s*)?Reply\\s+"${escapedCode}\\s+approve"\\s+or\\s+"${escapedCode}\\s+reject"\\.?`,
    "ig",
  );
  const answerInstructionPattern = new RegExp(
    `(?:Reference\\s+code:\\s*${escapedCode}\\.?\\s*)?Reply\\s+"${escapedCode}\\s+<your\\s+answer>"\\.?`,
    "ig",
  );

  const next =
    mode === "answer"
      ? text.replace(approvalInstructionPattern, "")
      : text.replace(answerInstructionPattern, "");

  return normalizeInstructionText(next);
}

/**
 * Resolve guardian reply instruction mode from request kind.
 *
 * Requires a valid requestKind in the payload. When the payload cannot be
 * fully parsed as a typed guardian question, falls back to field-level
 * requestKind resolution. If requestKind is missing or unknown, defaults
 * to "approval" mode.
 */
export function resolveGuardianQuestionInstructionMode(
  payload: Record<string, unknown>,
): GuardianQuestionModeResolution {
  const parsed = parseGuardianQuestionPayload(payload);
  if (parsed) {
    const parsedToolName = nonEmptyString(
      "toolName" in parsed ? parsed.toolName : null,
    );
    return {
      mode: resolveGuardianInstructionModeForRequestKind(
        parsed.requestKind,
        parsedToolName,
      ),
      requestKind: parsed.requestKind,
    };
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
