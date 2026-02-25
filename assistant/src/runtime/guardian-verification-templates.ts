/**
 * Template-only copy for outbound guardian verification messages (SMS, Telegram, and voice).
 *
 * All outbound verification messages are composed from these templates
 * to prevent free-form caller/user text injection. Only typed variables
 * are interpolated into the message body.
 */

// ---------------------------------------------------------------------------
// Template Keys
// ---------------------------------------------------------------------------

export const GUARDIAN_VERIFY_TEMPLATE_KEYS = {
  /** Initial outbound SMS with verification code. */
  CHALLENGE_REQUEST: 'guardian_verify.sms.challenge_request',
  /** Resend SMS with verification code. */
  RESEND: 'guardian_verify.sms.resend',
  /** Response when the user is already verified. */
  ALREADY_VERIFIED: 'guardian_verify.already_verified',
  /** Initial outbound Telegram message with verification code. */
  TELEGRAM_CHALLENGE_REQUEST: 'guardian_verify.telegram.challenge_request',
  /** Resend Telegram message with verification code. */
  TELEGRAM_RESEND: 'guardian_verify.telegram.resend',
  /** Outbound voice call intro prompt: asks guardian to enter verification code via keypad. */
  VOICE_CALL_INTRO: 'guardian_verify.voice.call_intro',
  /** Voice retry prompt after an incorrect code entry. */
  VOICE_RETRY: 'guardian_verify.voice.retry',
  /** Voice success prompt after successful verification. */
  VOICE_SUCCESS: 'guardian_verify.voice.success',
  /** Voice failure prompt after too many incorrect attempts. */
  VOICE_FAILURE: 'guardian_verify.voice.failure',
} as const;

export type GuardianVerifyTemplateKey =
  (typeof GUARDIAN_VERIFY_TEMPLATE_KEYS)[keyof typeof GUARDIAN_VERIFY_TEMPLATE_KEYS];

/** Template keys for SMS/Telegram text-based verification messages. */
type TextVerifyTemplateKey =
  | typeof GUARDIAN_VERIFY_TEMPLATE_KEYS.CHALLENGE_REQUEST
  | typeof GUARDIAN_VERIFY_TEMPLATE_KEYS.RESEND
  | typeof GUARDIAN_VERIFY_TEMPLATE_KEYS.ALREADY_VERIFIED
  | typeof GUARDIAN_VERIFY_TEMPLATE_KEYS.TELEGRAM_CHALLENGE_REQUEST
  | typeof GUARDIAN_VERIFY_TEMPLATE_KEYS.TELEGRAM_RESEND;

// ---------------------------------------------------------------------------
// Template Variables
// ---------------------------------------------------------------------------

export interface GuardianVerifyTemplateVars {
  code: string;
  expiresInMinutes: number;
  assistantName?: string;
}

export interface GuardianVerifyVoiceTemplateVars {
  /** Number of digits in the verification code. */
  codeDigits: number;
}

// ---------------------------------------------------------------------------
// Template Composers
// ---------------------------------------------------------------------------

const templates: Record<TextVerifyTemplateKey, (vars: GuardianVerifyTemplateVars) => string> = {
  [GUARDIAN_VERIFY_TEMPLATE_KEYS.CHALLENGE_REQUEST]: (vars) => {
    const prefix = vars.assistantName ? `[${vars.assistantName}] ` : '';
    return `${prefix}Your verification code is: ${vars.code}. It expires in ${vars.expiresInMinutes} minutes. Reply with this code to verify.`;
  },

  [GUARDIAN_VERIFY_TEMPLATE_KEYS.RESEND]: (vars) => {
    const prefix = vars.assistantName ? `[${vars.assistantName}] ` : '';
    return `${prefix}Your verification code is: ${vars.code}. It expires in ${vars.expiresInMinutes} minutes. Reply with this code to verify. (resent)`;
  },

  [GUARDIAN_VERIFY_TEMPLATE_KEYS.ALREADY_VERIFIED]: (_vars) => {
    const prefix = _vars.assistantName ? `[${_vars.assistantName}] ` : '';
    return `${prefix}This channel is already verified. No further action is needed.`;
  },

  [GUARDIAN_VERIFY_TEMPLATE_KEYS.TELEGRAM_CHALLENGE_REQUEST]: (vars) => {
    const prefix = vars.assistantName ? `[${vars.assistantName}] ` : '';
    return `${prefix}Your verification code is: ${vars.code}. Reply with: /guardian_verify ${vars.code}`;
  },

  [GUARDIAN_VERIFY_TEMPLATE_KEYS.TELEGRAM_RESEND]: (vars) => {
    const prefix = vars.assistantName ? `[${vars.assistantName}] ` : '';
    return `${prefix}Your verification code is: ${vars.code}. (resent)\nReply with: /guardian_verify ${vars.code}`;
  },
};

/**
 * Compose an outbound verification SMS body from a template key and typed variables.
 * Returns plain string content suitable for SMS delivery.
 */
export function composeVerificationSms(
  templateKey: TextVerifyTemplateKey,
  vars: GuardianVerifyTemplateVars,
): string {
  const composer = templates[templateKey];
  return composer(vars);
}

/**
 * Compose an outbound verification Telegram message from a template key and typed variables.
 * Returns plain string content suitable for Telegram delivery.
 */
export function composeVerificationTelegram(
  templateKey: TextVerifyTemplateKey,
  vars: GuardianVerifyTemplateVars,
): string {
  const composer = templates[templateKey];
  return composer(vars);
}

// ---------------------------------------------------------------------------
// Voice Templates
// ---------------------------------------------------------------------------

type VoiceTemplateKey =
  | typeof GUARDIAN_VERIFY_TEMPLATE_KEYS.VOICE_CALL_INTRO
  | typeof GUARDIAN_VERIFY_TEMPLATE_KEYS.VOICE_RETRY
  | typeof GUARDIAN_VERIFY_TEMPLATE_KEYS.VOICE_SUCCESS
  | typeof GUARDIAN_VERIFY_TEMPLATE_KEYS.VOICE_FAILURE;

const voiceTemplates: Record<VoiceTemplateKey, (vars: GuardianVerifyVoiceTemplateVars) => string> = {
  [GUARDIAN_VERIFY_TEMPLATE_KEYS.VOICE_CALL_INTRO]: (vars) =>
    `You are receiving a verification call. Please enter your ${vars.codeDigits}-digit verification code using your keypad.`,

  [GUARDIAN_VERIFY_TEMPLATE_KEYS.VOICE_RETRY]: (_vars) =>
    'That code was incorrect. Please try again.',

  [GUARDIAN_VERIFY_TEMPLATE_KEYS.VOICE_SUCCESS]: (_vars) =>
    'Verification successful. Thank you. Goodbye.',

  [GUARDIAN_VERIFY_TEMPLATE_KEYS.VOICE_FAILURE]: (_vars) =>
    'Too many incorrect attempts. Goodbye.',
};

/**
 * Compose an outbound verification voice prompt from a template key and typed variables.
 * Returns plain string content suitable for TTS playback.
 */
export function composeVerificationVoice(
  templateKey: VoiceTemplateKey,
  vars: GuardianVerifyVoiceTemplateVars,
): string {
  const composer = voiceTemplates[templateKey];
  return composer(vars);
}
