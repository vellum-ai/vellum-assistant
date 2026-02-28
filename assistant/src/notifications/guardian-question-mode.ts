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
      if (!callSessionId || activeGuardianRequestCount === null || Number.isNaN(activeGuardianRequestCount)) {
        return null;
      }
      return {
        requestKind,
        ...base,
        callSessionId,
        activeGuardianRequestCount,
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

function modeForKind(requestKind: GuardianQuestionRequestKind): GuardianQuestionInstructionMode {
  switch (requestKind) {
    case 'pending_question':
      return 'answer';
    case 'tool_approval':
    case 'tool_grant_request':
    case 'access_request':
      return 'approval';
    default: {
      // Exhaustive guard for future request kinds
      const _never: never = requestKind;
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
    return {
      mode: modeForKind(parsed.requestKind),
      requestKind: parsed.requestKind,
      legacyFallbackUsed: false,
    };
  }

  const toolName = nonEmptyString(payload.toolName);
  return {
    mode: toolName ? 'approval' : 'answer',
    requestKind: parseGuardianQuestionRequestKind(payload),
    legacyFallbackUsed: true,
  };
}
