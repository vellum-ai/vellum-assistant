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

/**
 * Resolve guardian reply instruction mode from request kind.
 *
 * Backward compatibility: if requestKind is missing/unknown, fall back to
 * toolName presence so previously persisted payloads keep working.
 */
export function resolveGuardianQuestionInstructionMode(
  payload: Record<string, unknown>,
): GuardianQuestionInstructionMode {
  const requestKind = parseGuardianQuestionRequestKind(payload);
  if (requestKind === 'pending_question') return 'answer';
  if (requestKind === 'tool_approval' || requestKind === 'tool_grant_request' || requestKind === 'access_request') {
    return 'approval';
  }

  const toolName = nonEmptyString(payload.toolName);
  return toolName ? 'approval' : 'answer';
}

