/**
 * Extracted verification logic for the ConversationRelay voice pipeline.
 *
 * These pure-ish functions encapsulate the decision-making for guardian code
 * verification and invite code redemption without directly mutating relay
 * connection state. They return structured result objects that the caller
 * (RelayConnection) interprets to drive side-effects (TTS, session updates,
 * timer scheduling, etc.).
 */

import {
  getGuardianBinding,
  validateAndConsumeVerification,
} from "../runtime/channel-verification-service.js";
import { redeemVoiceInviteCode } from "../runtime/invite-service.js";
import {
  composeVerificationVoice,
  GUARDIAN_VERIFY_TEMPLATE_KEYS,
} from "../runtime/verification-templates.js";
import type { CallEventType } from "./types.js";

// ── parseDigitsFromSpeech ──────────────────────────────────────────────

const wordToDigit: Record<string, string> = {
  zero: "0",
  oh: "0",
  o: "0",
  one: "1",
  won: "1",
  two: "2",
  too: "2",
  to: "2",
  three: "3",
  four: "4",
  for: "4",
  fore: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  ate: "8",
  nine: "9",
};

/**
 * Extract digit characters from a speech transcript. Recognizes both
 * raw digit characters ("1 2 3") and spoken number words ("one two three").
 */
export function parseDigitsFromSpeech(transcript: string): string {
  const digits: string[] = [];
  const lower = transcript.toLowerCase();

  // Split on whitespace and non-alphanumeric boundaries
  const tokens = lower.split(/[\s,.\-;:!?]+/);
  for (const token of tokens) {
    if (/^\d$/.test(token)) {
      digits.push(token);
    } else if (wordToDigit[token]) {
      digits.push(wordToDigit[token]);
    } else if (/^\d+$/.test(token)) {
      // Multi-digit number like "123456" — split into individual digits
      digits.push(...token.split(""));
    }
  }

  return digits.join("");
}

// ── Guardian code verification ─────────────────────────────────────────

export interface VerificationCallParams {
  verificationAssistantId: string;
  verificationFromNumber: string;
  enteredCode: string;
  isOutbound: boolean;
  codeDigits: number;
  verificationAttempts: number;
  verificationMaxAttempts: number;
}

export type VerificationCallResult =
  | {
      outcome: "success";
      verificationType: "guardian" | "trusted_contact";
      /** Event name to record */
      eventName: CallEventType;
      /** For guardian type: whether a binding conflict was detected */
      bindingConflict?: {
        existingGuardian: string;
      };
      /** For guardian type when no conflict: the canonical principal to use */
      canonicalPrincipal?: string;
      /** For outbound success: the TTS text to play */
      ttsMessage?: string;
    }
  | {
      outcome: "failure";
      eventName: CallEventType;
      ttsMessage: string;
      attempts: number;
    }
  | {
      outcome: "retry";
      ttsMessage: string;
      attempt: number;
      maxAttempts: number;
    };

/**
 * Core logic for validating an entered code against the pending voice
 * guardian challenge. Returns a structured result describing what happened
 * so the caller can apply side-effects (state mutations, TTS, session
 * updates) without this function needing access to the relay connection.
 */
export function attemptVerificationCode(
  params: VerificationCallParams,
): VerificationCallResult {
  const {
    verificationAssistantId,
    verificationFromNumber,
    enteredCode,
    isOutbound,
    codeDigits,
    verificationAttempts,
    verificationMaxAttempts,
  } = params;

  const result = validateAndConsumeVerification(
    "phone",
    enteredCode,
    verificationFromNumber,
    verificationFromNumber,
  );

  if (result.success) {
    const eventName = isOutbound
      ? "outbound_voice_verification_succeeded"
      : "voice_verification_succeeded";

    // Resolve binding conflict and canonical principal for guardian type
    let bindingConflict: { existingGuardian: string } | undefined;
    let canonicalPrincipal: string | undefined;

    if (result.verificationType === "guardian") {
      const existingBinding = getGuardianBinding(
        verificationAssistantId,
        "phone",
      );
      if (
        existingBinding &&
        existingBinding.guardianExternalUserId !== verificationFromNumber
      ) {
        bindingConflict = {
          existingGuardian: existingBinding.guardianExternalUserId,
        };
      } else {
        // Resolve canonical principal from the vellum channel binding
        const vellumBinding = getGuardianBinding(
          verificationAssistantId,
          "vellum",
        );
        canonicalPrincipal =
          vellumBinding?.guardianPrincipalId ?? verificationFromNumber;
      }
    }

    let ttsMessage: string | undefined;
    if (isOutbound) {
      ttsMessage = composeVerificationVoice(
        GUARDIAN_VERIFY_TEMPLATE_KEYS.VOICE_SUCCESS,
        { codeDigits },
      );
    }

    return {
      outcome: "success",
      verificationType: result.verificationType,
      eventName,
      bindingConflict,
      canonicalPrincipal,
      ttsMessage,
    };
  }

  // Failure path
  const newAttempts = verificationAttempts + 1;

  if (newAttempts >= verificationMaxAttempts) {
    const failEventName = isOutbound
      ? "outbound_voice_verification_failed"
      : "voice_verification_failed";

    const failureText = isOutbound
      ? composeVerificationVoice(GUARDIAN_VERIFY_TEMPLATE_KEYS.VOICE_FAILURE, {
          codeDigits,
        })
      : "Verification failed. Goodbye.";

    return {
      outcome: "failure",
      eventName: failEventName,
      ttsMessage: failureText,
      attempts: newAttempts,
    };
  }

  const retryText = isOutbound
    ? composeVerificationVoice(GUARDIAN_VERIFY_TEMPLATE_KEYS.VOICE_RETRY, {
        codeDigits,
      })
    : "That code was incorrect. Please try again.";

  return {
    outcome: "retry",
    ttsMessage: retryText,
    attempt: newAttempts,
    maxAttempts: verificationMaxAttempts,
  };
}

// ── Invite code redemption ─────────────────────────────────────────────

export interface InviteRedemptionParams {
  inviteRedemptionAssistantId: string;
  inviteRedemptionFromNumber: string;
  enteredCode: string;
  inviteRedemptionGuardianName: string | null;
}

export type InviteRedemptionResult =
  | {
      outcome: "success";
      memberId: string;
      type: "redeemed" | "already_member";
      inviteId?: string;
    }
  | {
      outcome: "failure";
      ttsMessage: string;
    };

/**
 * Validate an entered invite code against active voice invites for the
 * caller. Returns a structured result so the caller can handle state
 * mutations and session updates.
 */
export function attemptInviteCodeRedemption(
  params: InviteRedemptionParams,
): InviteRedemptionResult {
  const {
    inviteRedemptionAssistantId,
    inviteRedemptionFromNumber,
    enteredCode,
    inviteRedemptionGuardianName,
  } = params;

  const result = redeemVoiceInviteCode({
    assistantId: inviteRedemptionAssistantId,
    callerExternalUserId: inviteRedemptionFromNumber,
    sourceChannel: "phone",
    code: enteredCode,
  });

  if (result.ok) {
    return {
      outcome: "success",
      memberId: result.memberId,
      type: result.type,
      ...(result.type === "redeemed" ? { inviteId: result.inviteId } : {}),
    };
  }

  const displayGuardian = inviteRedemptionGuardianName ?? "your contact";
  return {
    outcome: "failure",
    ttsMessage: `Sorry, the code you provided is incorrect or has since expired. Please ask ${displayGuardian} for a new code. Goodbye.`,
  };
}
