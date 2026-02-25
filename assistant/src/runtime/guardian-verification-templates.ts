/**
 * Template-only copy for outbound guardian verification messages (SMS + Telegram).
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
} as const;

export type GuardianVerifyTemplateKey =
  (typeof GUARDIAN_VERIFY_TEMPLATE_KEYS)[keyof typeof GUARDIAN_VERIFY_TEMPLATE_KEYS];

// ---------------------------------------------------------------------------
// Template Variables
// ---------------------------------------------------------------------------

export interface GuardianVerifyTemplateVars {
  code: string;
  expiresInMinutes: number;
  assistantName?: string;
}

// ---------------------------------------------------------------------------
// Template Composers
// ---------------------------------------------------------------------------

const templates: Record<GuardianVerifyTemplateKey, (vars: GuardianVerifyTemplateVars) => string> = {
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
    return `${prefix}Your verification code is: ${vars.code}. Reply with: /guardian_verify ${vars.code} (resent)`;
  },
};

/**
 * Compose an outbound verification SMS body from a template key and typed variables.
 * Returns plain string content suitable for SMS delivery.
 */
export function composeVerificationSms(
  templateKey: GuardianVerifyTemplateKey,
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
  templateKey: GuardianVerifyTemplateKey,
  vars: GuardianVerifyTemplateVars,
): string {
  const composer = templates[templateKey];
  return composer(vars);
}
