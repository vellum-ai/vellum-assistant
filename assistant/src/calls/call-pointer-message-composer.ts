/**
 * Layered call pointer message composition system.
 *
 * Generates pointer/status copy through a priority chain:
 *   1. Generator-produced text (when provided by daemon and audience is trusted)
 *   2. Deterministic fallback templates (preserving existing semantics)
 *
 * Follows the same pattern as approval-message-composer.ts and
 * guardian-action-message-composer.ts.
 */
import type { PointerCopyGenerator } from '../runtime/http-types.js';
import { getLogger } from '../util/logger.js';

const log = getLogger('call-pointer-message-composer');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CallPointerMessageScenario =
  | 'started'
  | 'completed'
  | 'failed'
  | 'guardian_verification_succeeded'
  | 'guardian_verification_failed';

export interface CallPointerMessageContext {
  scenario: CallPointerMessageScenario;
  phoneNumber: string;
  duration?: string;
  reason?: string;
  verificationCode?: string;
  channel?: string;
}

export interface ComposeCallPointerMessageOptions {
  fallbackText?: string;
  requiredFacts?: string[];
  maxTokens?: number;
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Constants (exported for the daemon-injected generator implementation)
// ---------------------------------------------------------------------------

export const POINTER_COPY_TIMEOUT_MS = 3_000;
export const POINTER_COPY_MAX_TOKENS = 120;
export const POINTER_COPY_SYSTEM_PROMPT =
  'You are an assistant writing a brief status update about a phone call. '
  + 'Keep it concise (1-2 sentences), natural, and informative. '
  + 'Preserve all factual details exactly (phone numbers, durations, failure reasons, verification status). '
  + 'Do not mention internal systems or technical details. '
  + 'Return plain text only.';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compose pointer copy using the daemon-injected generator when available,
 * with deterministic fallback for reliability.
 *
 * The generator parameter is the daemon-provided function that knows about
 * providers. When absent (or in test env), only the deterministic fallback
 * is used.
 */
export async function composeCallPointerMessageGenerative(
  context: CallPointerMessageContext,
  options: ComposeCallPointerMessageOptions = {},
  generator?: PointerCopyGenerator,
): Promise<string> {
  const fallbackText = options.fallbackText?.trim() || getPointerFallbackMessage(context);

  if (process.env.NODE_ENV === 'test') {
    return fallbackText;
  }

  if (generator) {
    try {
      const generated = await generator(context, options);
      if (generated) return generated;
    } catch (err) {
      log.warn({ err, scenario: context.scenario }, 'Failed to generate pointer copy, using fallback');
    }
  }

  return fallbackText;
}

/** @internal Exported for use by the daemon-injected generator implementation. */
export function buildPointerGenerationPrompt(
  context: CallPointerMessageContext,
  fallbackText: string,
  requiredFacts: string[] | undefined,
): string {
  const factClause = requiredFacts && requiredFacts.length > 0
    ? `Required facts to include: ${requiredFacts.join(', ')}.\n`
    : '';
  return [
    'Rewrite the following call status message as a natural, conversational update.',
    'Keep the same concrete facts (phone number, duration, failure reason, verification status).',
    factClause,
    `Context JSON: ${JSON.stringify(context)}`,
    `Fallback message: ${fallbackText}`,
  ].filter(Boolean).join('\n\n');
}

/** @internal Exported for use by the daemon-injected generator implementation. */
export function includesRequiredFacts(text: string, requiredFacts: string[] | undefined): boolean {
  if (!requiredFacts || requiredFacts.length === 0) return true;
  return requiredFacts.every((fact) => text.includes(fact));
}

// ---------------------------------------------------------------------------
// Deterministic fallback templates
// ---------------------------------------------------------------------------

/**
 * Return a scenario-specific deterministic fallback message.
 *
 * These preserve the exact semantics of the original hard-coded pointer
 * templates from call-pointer-messages.ts.
 */
export function getPointerFallbackMessage(context: CallPointerMessageContext): string {
  switch (context.scenario) {
    case 'started':
      return context.verificationCode
        ? `\u{1F4DE} Call to ${context.phoneNumber} started. Verification code: ${context.verificationCode}`
        : `\u{1F4DE} Call to ${context.phoneNumber} started.`;
    case 'completed':
      return context.duration
        ? `\u{1F4DE} Call to ${context.phoneNumber} completed (${context.duration}).`
        : `\u{1F4DE} Call to ${context.phoneNumber} completed.`;
    case 'failed':
      return context.reason
        ? `\u{1F4DE} Call to ${context.phoneNumber} failed: ${context.reason}.`
        : `\u{1F4DE} Call to ${context.phoneNumber} failed.`;
    case 'guardian_verification_succeeded': {
      const ch = context.channel ?? 'voice';
      return `\u{2705} Guardian verification (${ch}) for ${context.phoneNumber} succeeded.`;
    }
    case 'guardian_verification_failed': {
      const ch = context.channel ?? 'voice';
      return context.reason
        ? `\u{274C} Guardian verification (${ch}) for ${context.phoneNumber} failed: ${context.reason}.`
        : `\u{274C} Guardian verification (${ch}) for ${context.phoneNumber} failed.`;
    }
    default: {
      const _exhaustive: never = context.scenario;
      return `Call status update. ${String(_exhaustive)}`;
    }
  }
}
