/**
 * Layered guardian action message composition system.
 *
 * Generates user-visible copy for guardian action scenarios through a
 * priority chain:
 *   1. Generator-produced text (when provided by daemon)
 *   2. Deterministic fallback templates (natural, scenario-specific messages)
 *
 * Follows the same pattern as approval-message-composer.ts.
 */
import { getLogger } from '../util/logger.js';
import type { GuardianActionCopyGenerator } from './http-types.js';

const log = getLogger('guardian-action-message-composer');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GuardianActionMessageScenario =
  | 'caller_timeout_acknowledgment'
  | 'caller_timeout_continue'
  | 'guardian_late_answer_followup'
  | 'guardian_followup_dispatching'
  | 'guardian_followup_completed'
  | 'guardian_followup_failed'
  | 'guardian_followup_declined_ack'
  | 'guardian_stale_expired'
  | 'outbound_message_copy';

export interface GuardianActionMessageContext {
  scenario: GuardianActionMessageScenario;
  channel?: string;
  questionText?: string;
  callerIdentifier?: string;
  guardianIdentifier?: string;
  lateAnswerText?: string;
  followupAction?: string;
  failureReason?: string;
}

export interface ComposeGuardianActionMessageOptions {
  fallbackText?: string;
  requiredKeywords?: string[];
  maxTokens?: number;
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Constants (exported for the daemon-injected generator implementation)
// ---------------------------------------------------------------------------

export const GUARDIAN_ACTION_COPY_TIMEOUT_MS = 4_000;
export const GUARDIAN_ACTION_COPY_MAX_TOKENS = 200;
export const GUARDIAN_ACTION_COPY_SYSTEM_PROMPT =
  'You are an assistant writing one user-facing message about a guardian action in a voice call scenario. '
  + 'Keep it concise, natural, and conversational. Preserve factual details exactly. '
  + 'These messages are spoken aloud or sent as SMS, so use a warm, human tone. '
  + 'Do not mention internal systems, scenario IDs, or technical details. '
  + 'Return plain text only.';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compose user-facing guardian action copy using the daemon-injected generator
 * when available, with deterministic fallback for reliability.
 *
 * The generator parameter is the daemon-provided function that knows about
 * providers. When absent (or in test env), only the deterministic fallback
 * is used.
 */
export async function composeGuardianActionMessageGenerative(
  context: GuardianActionMessageContext,
  options: ComposeGuardianActionMessageOptions = {},
  generator?: GuardianActionCopyGenerator,
): Promise<string> {
  const fallbackText = options.fallbackText?.trim() || getGuardianActionFallbackMessage(context);

  if (process.env.NODE_ENV === 'test') {
    return fallbackText;
  }

  if (generator) {
    try {
      const generated = await generator(context, options);
      if (generated) return generated;
    } catch (err) {
      log.warn({ err, scenario: context.scenario }, 'Failed to generate guardian action copy, using fallback');
    }
  }

  return fallbackText;
}

/** @internal Exported for use by the daemon-injected generator implementation. */
export function buildGuardianActionGenerationPrompt(
  context: GuardianActionMessageContext,
  fallbackText: string,
  requiredKeywords: string[] | undefined,
): string {
  const keywordClause = requiredKeywords && requiredKeywords.length > 0
    ? `Required words to include (as standalone words): ${requiredKeywords.join(', ')}.\n`
    : '';
  return [
    'Rewrite the following guardian action message as a natural, conversational reply.',
    'These messages are for voice call scenarios and may be spoken aloud or sent as SMS.',
    'Keep the same concrete facts and next-step guidance.',
    keywordClause,
    `Context JSON: ${JSON.stringify(context)}`,
    `Fallback message: ${fallbackText}`,
  ].filter(Boolean).join('\n\n');
}

/** @internal Exported for use by the daemon-injected generator implementation. */
export function includesRequiredKeywords(text: string, requiredKeywords: string[] | undefined): boolean {
  if (!requiredKeywords || requiredKeywords.length === 0) return true;
  return requiredKeywords.every((keyword) => {
    const re = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    return re.test(text);
  });
}

// ---------------------------------------------------------------------------
// Deterministic fallback templates
// ---------------------------------------------------------------------------

/**
 * Return a scenario-specific deterministic fallback message.
 *
 * Each template produces natural, conversational text suitable for voice
 * or SMS delivery.
 */
export function getGuardianActionFallbackMessage(context: GuardianActionMessageContext): string {
  switch (context.scenario) {
    case 'caller_timeout_acknowledgment':
      return context.guardianIdentifier
        ? `I wasn't able to reach ${context.guardianIdentifier} right now. I'm sorry about that.`
        : "I wasn't able to reach the guardian right now. I'm sorry about that.";

    case 'caller_timeout_continue':
      return 'Would you like me to leave a message for them to get back to you, or is there anything else I can help with?';

    case 'guardian_late_answer_followup':
      return context.callerIdentifier
        ? `${context.callerIdentifier} called earlier with a question, but I wasn't able to connect them. Would you like to call them back or send them a message?`
        : 'Someone called earlier with a question, but I wasn\'t able to connect them. Would you like to call them back or send them a message?';

    case 'guardian_followup_dispatching':
      return context.followupAction
        ? `Got it, I'll ${context.followupAction} now.`
        : "Got it, I'm taking care of that now.";

    case 'guardian_followup_completed':
      return context.followupAction
        ? `Done! I've ${context.followupAction} successfully.`
        : "Done! That's been taken care of.";

    case 'guardian_followup_failed':
      return context.failureReason
        ? `I'm sorry, I wasn't able to complete that. ${context.failureReason}`
        : "I'm sorry, I wasn't able to complete that. Please try again later.";

    case 'guardian_followup_declined_ack':
      return 'No problem. Let me know if you change your mind or need anything else.';

    case 'guardian_stale_expired':
      return 'That request has already expired. No further action is needed.';

    case 'outbound_message_copy':
      return context.callerIdentifier && context.questionText
        ? `Hi, ${context.callerIdentifier} tried to reach you earlier and asked: "${context.questionText}". Please reply when you get a chance.`
        : context.questionText
          ? `Someone tried to reach you earlier and asked: "${context.questionText}". Please reply when you get a chance.`
          : 'Someone tried to reach you earlier. Please reply when you get a chance.';

    default: {
      const _exhaustive: never = context.scenario;
      return `Guardian action update. ${String(_exhaustive)}`;
    }
  }
}
