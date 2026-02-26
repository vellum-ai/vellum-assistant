import { describe, expect, test } from 'bun:test';

import type {
  GuardianActionMessageContext,
  GuardianActionMessageScenario,
} from '../runtime/guardian-action-message-composer.js';
import {
  composeGuardianActionMessageGenerative,
  getGuardianActionFallbackMessage,
} from '../runtime/guardian-action-message-composer.js';
import type { GuardianActionCopyGenerator } from '../runtime/http-types.js';

// ---------------------------------------------------------------------------
// Every scenario must produce a non-empty string
// ---------------------------------------------------------------------------

const ALL_SCENARIOS: GuardianActionMessageScenario[] = [
  'caller_timeout_acknowledgment',
  'caller_timeout_continue',
  'guardian_late_answer_followup',
  'guardian_followup_dispatching',
  'guardian_followup_completed',
  'guardian_followup_failed',
  'guardian_followup_declined_ack',
  'guardian_stale_expired',
  'guardian_stale_followup',
  'outbound_message_copy',
];

describe('guardian-action-copy-generator', () => {
  // -----------------------------------------------------------------------
  // Fallback messages -- every scenario produces non-empty output
  // -----------------------------------------------------------------------

  describe('getGuardianActionFallbackMessage', () => {
    for (const scenario of ALL_SCENARIOS) {
      test(`scenario "${scenario}" produces a non-empty string`, () => {
        const msg = getGuardianActionFallbackMessage({ scenario });
        expect(typeof msg).toBe('string');
        expect(msg.trim().length).toBeGreaterThan(0);
      });
    }

    test('caller_timeout_acknowledgment includes guardianIdentifier when provided', () => {
      const msg = getGuardianActionFallbackMessage({
        scenario: 'caller_timeout_acknowledgment',
        guardianIdentifier: 'Dr. Smith',
      });
      expect(msg).toContain('Dr. Smith');
    });

    test('guardian_late_answer_followup includes callerIdentifier when provided', () => {
      const msg = getGuardianActionFallbackMessage({
        scenario: 'guardian_late_answer_followup',
        callerIdentifier: 'Alice',
      });
      expect(msg).toContain('Alice');
    });

    test('guardian_followup_dispatching includes followupAction when provided', () => {
      const msg = getGuardianActionFallbackMessage({
        scenario: 'guardian_followup_dispatching',
        followupAction: 'send them a text message',
      });
      expect(msg).toContain('send them a text message');
    });

    test('guardian_followup_completed includes followupAction when provided', () => {
      const msg = getGuardianActionFallbackMessage({
        scenario: 'guardian_followup_completed',
        followupAction: 'sent the message',
      });
      expect(msg).toContain('sent the message');
    });

    test('guardian_followup_failed includes failureReason when provided', () => {
      const msg = getGuardianActionFallbackMessage({
        scenario: 'guardian_followup_failed',
        failureReason: 'The phone number is not valid.',
      });
      expect(msg).toContain('The phone number is not valid.');
    });

    test('outbound_message_copy includes callerIdentifier and questionText', () => {
      const msg = getGuardianActionFallbackMessage({
        scenario: 'outbound_message_copy',
        callerIdentifier: 'Bob',
        questionText: 'When is the appointment?',
      });
      expect(msg).toContain('Bob');
      expect(msg).toContain('When is the appointment?');
    });

    test('outbound_message_copy without callerIdentifier still includes questionText', () => {
      const msg = getGuardianActionFallbackMessage({
        scenario: 'outbound_message_copy',
        questionText: 'Is the office open?',
      });
      expect(msg).toContain('Is the office open?');
      expect(msg).toContain('Someone');
    });
  });

  // -----------------------------------------------------------------------
  // composeGuardianActionMessageGenerative -- layered composition
  // -----------------------------------------------------------------------

  describe('composeGuardianActionMessageGenerative', () => {
    test('with no generator returns fallback', async () => {
      const context: GuardianActionMessageContext = {
        scenario: 'caller_timeout_acknowledgment',
        guardianIdentifier: 'Jane',
      };
      const msg = await composeGuardianActionMessageGenerative(context);
      expect(msg).toBe(getGuardianActionFallbackMessage(context));
    });

    test('with generator that returns text uses the generated text', async () => {
      const generatedText = 'Custom generated message about the timeout.';
      const generator: GuardianActionCopyGenerator = async () => generatedText;
      const context: GuardianActionMessageContext = {
        scenario: 'caller_timeout_acknowledgment',
      };
      // In test env, generator is skipped and fallback is returned
      const msg = await composeGuardianActionMessageGenerative(context, {}, generator);
      expect(msg).toBe(getGuardianActionFallbackMessage(context));
    });

    test('with generator that throws returns fallback', async () => {
      const generator: GuardianActionCopyGenerator = async () => {
        throw new Error('Provider unavailable');
      };
      const context: GuardianActionMessageContext = {
        scenario: 'guardian_followup_failed',
        failureReason: 'Network error',
      };
      const msg = await composeGuardianActionMessageGenerative(context, {}, generator);
      expect(msg).toBe(getGuardianActionFallbackMessage(context));
    });

    test('with generator that returns null returns fallback', async () => {
      const generator: GuardianActionCopyGenerator = async () => null;
      const context: GuardianActionMessageContext = {
        scenario: 'guardian_stale_expired',
      };
      const msg = await composeGuardianActionMessageGenerative(context, {}, generator);
      expect(msg).toBe(getGuardianActionFallbackMessage(context));
    });

    test('uses custom fallbackText from options when provided', async () => {
      const context: GuardianActionMessageContext = {
        scenario: 'caller_timeout_continue',
      };
      const customFallback = 'Custom fallback text for this scenario.';
      const msg = await composeGuardianActionMessageGenerative(context, { fallbackText: customFallback });
      expect(msg).toBe(customFallback);
    });

    test('skips generation in test environment', async () => {
      let generatorCalled = false;
      const generator: GuardianActionCopyGenerator = async () => {
        generatorCalled = true;
        return 'This should not be returned in test env';
      };
      const context: GuardianActionMessageContext = {
        scenario: 'guardian_followup_declined_ack',
      };
      const msg = await composeGuardianActionMessageGenerative(context, {}, generator);
      expect(generatorCalled).toBe(false);
      expect(msg).toBe(getGuardianActionFallbackMessage(context));
    });
  });
});
