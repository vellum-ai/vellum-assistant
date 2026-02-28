/**
 * Shared request-kind and instruction-mode resolver for guardian.question signals.
 *
 * Explicit request kinds provide a stable contract between producers and
 * notification rendering logic, avoiding implicit inference from incidental
 * fields like `toolName`.
 */

export const GUARDIAN_QUESTION_REQUEST_KINDS = {
  pending_question: 'pending_question',
  tool_approval: 'tool_approval',
  tool_grant_request: 'tool_grant_request',
  access_request: 'access_request',
} as const;

export type GuardianQuestionRequestKind = keyof typeof GUARDIAN_QUESTION_REQUEST_KINDS;
export type GuardianQuestionInstructionMode = 'approval' | 'answer';

interface GuardianRequestKindModeConfig {
  defaultMode: GuardianQuestionInstructionMode;
  modeWhenToolNamePresent?: GuardianQuestionInstructionMode;
}

const REQUEST_KIND_MODE_CONFIG: Record<GuardianQuestionRequestKind, GuardianRequestKindModeConfig> = {
  pending_question: {
    defaultMode: 'answer',
    modeWhenToolNamePresent: 'approval',
  },
  tool_approval: {
    defaultMode: 'approval',
  },
  tool_grant_request: {
    defaultMode: 'approval',
  },
  access_request: {
    defaultMode: 'approval',
  },
};

interface GuardianQuestionPayloadBase {
  requestKind: GuardianQuestionRequestKind;
  requestId: string;
  requestCode: string;
  questionText: string;
}

export interface PendingQuestionGuardianPayload extends GuardianQuestionPayloadBase {
  requestKind: 'pending_question';
  callSessionId: string;
  activeGuardianRequestCount: number;
  /**
   * Voice tool-approval requests are persisted as pending_question with tool
   * metadata so they still route through pending-question resolution.
   */
  toolName?: string;
}

export interface ToolApprovalGuardianPayload extends GuardianQuestionPayloadBase {
  requestKind: 'tool_approval';
  toolName: string;
}

export interface ToolGrantGuardianPayload extends GuardianQuestionPayloadBase {
  requestKind: 'tool_grant_request';
  toolName: string;
}

export interface AccessRequestGuardianPayload extends GuardianQuestionPayloadBase {
  requestKind: 'access_request';
}

export type GuardianQuestionPayload =
  | PendingQuestionGuardianPayload
  | ToolApprovalGuardianPayload
  | ToolGrantGuardianPayload
  | AccessRequestGuardianPayload;

export interface GuardianQuestionModeResolution {
  mode: GuardianQuestionInstructionMode;
  requestKind: GuardianQuestionRequestKind | null;
  legacyFallbackUsed: boolean;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function parseGuardianQuestionRequestKind(
  payload: Record<string, unknown>,
): GuardianQuestionRequestKind | null {
  const raw = nonEmptyString(payload.requestKind);
  if (!raw) return null;

  switch (raw) {
    case 'pending_question':
    case 'tool_approval':
    case 'tool_grant_request':
    case 'access_request':
      return raw;
    default:
      return null;
  }
}

function parseBasePayload(payload: Record<string, unknown>): Omit<GuardianQuestionPayloadBase, 'requestKind'> | null {
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
    case 'pending_question': {
      const callSessionId = nonEmptyString(payload.callSessionId);
      const activeGuardianRequestCount = typeof payload.activeGuardianRequestCount === 'number'
        ? payload.activeGuardianRequestCount
        : null;
      const toolName = nonEmptyString(payload.toolName);
      if (!callSessionId || activeGuardianRequestCount === null || Number.isNaN(activeGuardianRequestCount)) {
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
    case 'tool_approval':
    case 'tool_grant_request': {
      const toolName = nonEmptyString(payload.toolName);
      if (!toolName) return null;
      return {
        requestKind,
        ...base,
        toolName,
      };
    }
    case 'access_request':
      return {
        requestKind,
        ...base,
      };
    default:
      return null;
  }
}

export function resolveGuardianInstructionModeForRequestKind(
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
): { requestKind: GuardianQuestionRequestKind; mode: GuardianQuestionInstructionMode } | null {
  const requestKind = parseGuardianQuestionRequestKind({ requestKind: requestKindValue });
  if (!requestKind) return null;

  return {
    requestKind,
    mode: resolveGuardianInstructionModeForRequestKind(requestKind, nonEmptyString(toolNameValue)),
  };
}

export function buildGuardianRequestCodeInstruction(
  requestCode: string,
  mode: GuardianQuestionInstructionMode,
): string {
  switch (mode) {
    case 'approval':
      return `Reference code: ${requestCode}. Reply "${requestCode} approve" or "${requestCode} reject".`;
    case 'answer':
      return `Reference code: ${requestCode}. Reply "${requestCode} <your answer>".`;
    default: {
      const _never: never = mode;
      return _never;
    }
  }
}

export function hasGuardianRequestCodeInstruction(
  text: string | undefined,
  requestCode: string,
  mode: GuardianQuestionInstructionMode,
): boolean {
  if (typeof text !== 'string') return false;
  const upper = text.toUpperCase();
  const normalizedCode = requestCode.toUpperCase();

  switch (mode) {
    case 'approval':
      return upper.includes(`${normalizedCode} APPROVE`) && upper.includes(`${normalizedCode} REJECT`);
    case 'answer': {
      const hasAnswerInstruction = upper.includes(`${normalizedCode} <YOUR ANSWER>`);
      const hasApprovalInstruction = upper.includes(`${normalizedCode} APPROVE`) || upper.includes(`${normalizedCode} REJECT`);
      return hasAnswerInstruction && !hasApprovalInstruction;
    }
    default: {
      const _never: never = mode;
      return _never;
    }
  }
}

/**
 * Resolve guardian reply instruction mode from request kind.
 *
 * Backward compatibility: if requestKind is missing/unknown, fall back to
 * toolName presence so previously persisted payloads keep working.
 */
export function resolveGuardianQuestionInstructionMode(
  payload: Record<string, unknown>,
): GuardianQuestionModeResolution {
  const parsed = parseGuardianQuestionPayload(payload);
  if (parsed) {
    const parsedToolName = 'toolName' in parsed ? parsed.toolName : null;
    return {
      mode: resolveGuardianInstructionModeForRequestKind(parsed.requestKind, parsedToolName),
      requestKind: parsed.requestKind,
      legacyFallbackUsed: false,
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
      legacyFallbackUsed: true,
    };
  }

  const toolName = nonEmptyString(payload.toolName);
  return {
    mode: toolName ? 'approval' : 'answer',
    requestKind: null,
    legacyFallbackUsed: true,
  };
}
