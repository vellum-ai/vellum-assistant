/**
 * Template-only copy for outbound guardian verification messages (Telegram, Slack, and voice).
 *
 * All outbound verification messages are composed from these templates
 * to prevent free-form caller/user text injection. Only typed variables
 * are interpolated into the message body.
 */

// ---------------------------------------------------------------------------
// Template Keys
// ---------------------------------------------------------------------------

export const GUARDIAN_VERIFY_TEMPLATE_KEYS = {
  /** Response when the user is already verified. */
  ALREADY_VERIFIED: "guardian_verify.already_verified",
  /** Initial outbound Telegram verification prompt (code is not included). */
  TELEGRAM_CHALLENGE_REQUEST: "guardian_verify.telegram.challenge_request",
  /** Resend Telegram verification prompt (code is not included). */
  TELEGRAM_RESEND: "guardian_verify.telegram.resend",
  /** Initial outbound Slack DM verification prompt. */
  SLACK_CHALLENGE_REQUEST: "guardian_verify.slack.challenge_request",
  /** Resend Slack DM verification prompt. */
  SLACK_RESEND: "guardian_verify.slack.resend",
  /** Slack DM verification for inbound trusted contact (includes the code). */
  SLACK_TRUSTED_CONTACT_CHALLENGE:
    "guardian_verify.slack.trusted_contact_challenge",
  /** Resend Slack DM verification for inbound trusted contact (includes the code). */
  SLACK_TRUSTED_CONTACT_RESEND: "guardian_verify.slack.trusted_contact_resend",
  /** Outbound voice call intro prompt: asks guardian to enter verification code via keypad. */
  VOICE_CALL_INTRO: "guardian_verify.voice.call_intro",
  /** Voice retry prompt after an incorrect code entry. */
  VOICE_RETRY: "guardian_verify.voice.retry",
  /** Voice success prompt after successful verification. */
  VOICE_SUCCESS: "guardian_verify.voice.success",
  /** Voice failure prompt after too many incorrect attempts. */
  VOICE_FAILURE: "guardian_verify.voice.failure",
  /** Deterministic reply after successful verification (guardian or trusted contact). */
  CHANNEL_VERIFY_SUCCESS: "guardian_verify.channel.success",
  /** Deterministic reply after failed channel verification command. */
  CHANNEL_VERIFY_FAILED: "guardian_verify.channel.failed",
  /** Deterministic reply for bootstrap deep-link success. */
  CHANNEL_BOOTSTRAP_BOUND: "guardian_verify.channel.bootstrap_bound",
} as const;

export type GuardianVerifyTemplateKey =
  (typeof GUARDIAN_VERIFY_TEMPLATE_KEYS)[keyof typeof GUARDIAN_VERIFY_TEMPLATE_KEYS];

/** Template keys for Telegram/Slack text-based verification messages. */
type TextVerifyTemplateKey =
  | typeof GUARDIAN_VERIFY_TEMPLATE_KEYS.ALREADY_VERIFIED
  | typeof GUARDIAN_VERIFY_TEMPLATE_KEYS.TELEGRAM_CHALLENGE_REQUEST
  | typeof GUARDIAN_VERIFY_TEMPLATE_KEYS.TELEGRAM_RESEND
  | typeof GUARDIAN_VERIFY_TEMPLATE_KEYS.SLACK_CHALLENGE_REQUEST
  | typeof GUARDIAN_VERIFY_TEMPLATE_KEYS.SLACK_RESEND
  | typeof GUARDIAN_VERIFY_TEMPLATE_KEYS.SLACK_TRUSTED_CONTACT_CHALLENGE
  | typeof GUARDIAN_VERIFY_TEMPLATE_KEYS.SLACK_TRUSTED_CONTACT_RESEND;

/** Template keys for deterministic channel verification reply messages. */
export type ChannelVerifyReplyTemplateKey =
  | typeof GUARDIAN_VERIFY_TEMPLATE_KEYS.CHANNEL_VERIFY_SUCCESS
  | typeof GUARDIAN_VERIFY_TEMPLATE_KEYS.CHANNEL_VERIFY_FAILED
  | typeof GUARDIAN_VERIFY_TEMPLATE_KEYS.CHANNEL_BOOTSTRAP_BOUND;

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

export interface ChannelVerifyReplyVars {
  /** Failure reason (anti-oracle: generic message). Only used for failed template. */
  failureReason?: string;
  /** Drives different success copy for guardian vs trusted contact verification. */
  verificationType?: "guardian" | "trusted_contact";
}

// ---------------------------------------------------------------------------
// Template Composers
// ---------------------------------------------------------------------------

const templates: Record<
  TextVerifyTemplateKey,
  (vars: GuardianVerifyTemplateVars) => string
> = {
  [GUARDIAN_VERIFY_TEMPLATE_KEYS.ALREADY_VERIFIED]: (_vars) => {
    return "This channel is already verified. No further action is needed.";
  },

  [GUARDIAN_VERIFY_TEMPLATE_KEYS.TELEGRAM_CHALLENGE_REQUEST]: (_vars) => {
    return "Vellum assistant guardian verification requested. Reply with the 6-digit code you were given.";
  },

  [GUARDIAN_VERIFY_TEMPLATE_KEYS.TELEGRAM_RESEND]: (_vars) => {
    return "Vellum assistant guardian verification requested. Reply with the 6-digit code you were given. (resent)";
  },

  [GUARDIAN_VERIFY_TEMPLATE_KEYS.SLACK_CHALLENGE_REQUEST]: (_vars) => {
    return "Vellum assistant guardian verification requested. Reply with the 6-digit code you were given.";
  },

  [GUARDIAN_VERIFY_TEMPLATE_KEYS.SLACK_RESEND]: (_vars) => {
    return "Vellum assistant guardian verification requested. Reply with the 6-digit code you were given. (resent)";
  },

  [GUARDIAN_VERIFY_TEMPLATE_KEYS.SLACK_TRUSTED_CONTACT_CHALLENGE]: (vars) => {
    return `Vellum assistant verification: your code is ${vars.code}. Reply with this code to verify your identity. It expires in ${vars.expiresInMinutes} minutes.`;
  },

  [GUARDIAN_VERIFY_TEMPLATE_KEYS.SLACK_TRUSTED_CONTACT_RESEND]: (vars) => {
    return `Vellum assistant verification: your code is ${vars.code}. Reply with this code to verify your identity. It expires in ${vars.expiresInMinutes} minutes. (resent)`;
  },
};

/**
 * Compose an outbound verification Slack DM from a template key and typed variables.
 * Returns plain string content suitable for Slack delivery.
 */
export function composeVerificationSlack(
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

const voiceTemplates: Record<
  VoiceTemplateKey,
  (vars: GuardianVerifyVoiceTemplateVars) => string
> = {
  [GUARDIAN_VERIFY_TEMPLATE_KEYS.VOICE_CALL_INTRO]: (vars) =>
    `You are receiving a guardian verification call for your Vellum assistant. Please enter your ${vars.codeDigits}-digit verification code using your keypad.`,

  [GUARDIAN_VERIFY_TEMPLATE_KEYS.VOICE_RETRY]: (_vars) =>
    "That code was incorrect. Please try again.",

  [GUARDIAN_VERIFY_TEMPLATE_KEYS.VOICE_SUCCESS]: (_vars) =>
    "Verification successful.",

  [GUARDIAN_VERIFY_TEMPLATE_KEYS.VOICE_FAILURE]: (_vars) =>
    "Too many incorrect attempts. Goodbye.",
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

// ---------------------------------------------------------------------------
// Channel Verification Reply Templates (deterministic, non-agent)
// ---------------------------------------------------------------------------

const channelVerifyReplyTemplates: Record<
  ChannelVerifyReplyTemplateKey,
  (vars: ChannelVerifyReplyVars) => string
> = {
  [GUARDIAN_VERIFY_TEMPLATE_KEYS.CHANNEL_VERIFY_SUCCESS]: (vars) =>
    vars.verificationType === "trusted_contact"
      ? "Verification successful! You can now message the assistant."
      : "Verification successful. You are now set as the guardian for this channel.",

  [GUARDIAN_VERIFY_TEMPLATE_KEYS.CHANNEL_VERIFY_FAILED]: (vars) =>
    vars.failureReason ?? "The verification code is invalid or has expired.",

  [GUARDIAN_VERIFY_TEMPLATE_KEYS.CHANNEL_BOOTSTRAP_BOUND]: () =>
    "Welcome! Your identity has been linked. Please check for a verification code message.",
};

/**
 * Compose a deterministic channel verification reply from a template key.
 * These replies are delivered directly via channel reply delivery and
 * never enter the agent pipeline, ensuring verification commands produce
 * only template-driven copy.
 */
export function composeChannelVerifyReply(
  templateKey: ChannelVerifyReplyTemplateKey,
  vars: ChannelVerifyReplyVars = {},
): string {
  const composer = channelVerifyReplyTemplates[templateKey];
  return composer(vars);
}
