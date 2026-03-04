import { z } from "zod";

const VALID_CALL_PROVIDERS = ["twilio"] as const;
export const VALID_CALLER_IDENTITY_MODES = [
  "assistant_number",
  "user_number",
] as const;
const VALID_CALL_TRANSCRIPTION_PROVIDERS = ["Deepgram", "Google"] as const;

export const CallsDisclosureConfigSchema = z.object({
  enabled: z
    .boolean({ error: "calls.disclosure.enabled must be a boolean" })
    .default(true),
  text: z
    .string({ error: "calls.disclosure.text must be a string" })
    .default(
      'At the very beginning of the call, introduce yourself as an assistant calling on behalf of the person you represent. Do not say "AI assistant".',
    ),
});

export const CallsSafetyConfigSchema = z.object({
  denyCategories: z
    .array(
      z.string({ error: "calls.safety.denyCategories values must be strings" }),
    )
    .default([]),
});

export const CallsVoiceConfigSchema = z.object({
  language: z
    .string({ error: "calls.voice.language must be a string" })
    .default("en-US"),
  transcriptionProvider: z
    .enum(VALID_CALL_TRANSCRIPTION_PROVIDERS, {
      error: `calls.voice.transcriptionProvider must be one of: ${VALID_CALL_TRANSCRIPTION_PROVIDERS.join(
        ", ",
      )}`,
    })
    .default("Deepgram"),
});

export const CallerIdentityConfigSchema = z.object({
  allowPerCallOverride: z
    .boolean({
      error: "calls.callerIdentity.allowPerCallOverride must be a boolean",
    })
    .default(true),
  userNumber: z
    .string({ error: "calls.callerIdentity.userNumber must be a string" })
    .optional(),
});

export const CallsVerificationConfigSchema = z.object({
  enabled: z
    .boolean({ error: "calls.verification.enabled must be a boolean" })
    .default(false),
  maxAttempts: z
    .number({ error: "calls.verification.maxAttempts must be a number" })
    .int("calls.verification.maxAttempts must be an integer")
    .positive("calls.verification.maxAttempts must be a positive integer")
    .default(3),
  codeLength: z
    .number({ error: "calls.verification.codeLength must be a number" })
    .int("calls.verification.codeLength must be an integer")
    .positive("calls.verification.codeLength must be a positive integer")
    .default(6),
});

export const CallsConfigSchema = z.object({
  enabled: z
    .boolean({ error: "calls.enabled must be a boolean" })
    .default(true),
  provider: z
    .enum(VALID_CALL_PROVIDERS, {
      error: `calls.provider must be one of: ${VALID_CALL_PROVIDERS.join(
        ", ",
      )}`,
    })
    .default("twilio"),
  maxDurationSeconds: z
    .number({ error: "calls.maxDurationSeconds must be a number" })
    .int("calls.maxDurationSeconds must be an integer")
    .positive("calls.maxDurationSeconds must be a positive integer")
    .max(
      2_147_483,
      "calls.maxDurationSeconds must be at most 2147483 (setTimeout-safe limit)",
    )
    .default(3600),
  userConsultTimeoutSeconds: z
    .number({ error: "calls.userConsultTimeoutSeconds must be a number" })
    .int("calls.userConsultTimeoutSeconds must be an integer")
    .positive("calls.userConsultTimeoutSeconds must be a positive integer")
    .max(
      2_147_483,
      "calls.userConsultTimeoutSeconds must be at most 2147483 (setTimeout-safe limit)",
    )
    .default(120),
  ttsPlaybackDelayMs: z
    .number({ error: "calls.ttsPlaybackDelayMs must be a number" })
    .int("calls.ttsPlaybackDelayMs must be an integer")
    .min(0, "calls.ttsPlaybackDelayMs must be >= 0")
    .max(10_000, "calls.ttsPlaybackDelayMs must be at most 10000")
    .default(3000),
  accessRequestPollIntervalMs: z
    .number({ error: "calls.accessRequestPollIntervalMs must be a number" })
    .int("calls.accessRequestPollIntervalMs must be an integer")
    .min(50, "calls.accessRequestPollIntervalMs must be >= 50")
    .max(10_000, "calls.accessRequestPollIntervalMs must be at most 10000")
    .default(500),
  guardianWaitUpdateInitialIntervalMs: z
    .number({
      error: "calls.guardianWaitUpdateInitialIntervalMs must be a number",
    })
    .int("calls.guardianWaitUpdateInitialIntervalMs must be an integer")
    .min(1000, "calls.guardianWaitUpdateInitialIntervalMs must be >= 1000")
    .max(
      60_000,
      "calls.guardianWaitUpdateInitialIntervalMs must be at most 60000",
    )
    .default(15_000),
  guardianWaitUpdateInitialWindowMs: z
    .number({
      error: "calls.guardianWaitUpdateInitialWindowMs must be a number",
    })
    .int("calls.guardianWaitUpdateInitialWindowMs must be an integer")
    .min(1000, "calls.guardianWaitUpdateInitialWindowMs must be >= 1000")
    .max(
      60_000,
      "calls.guardianWaitUpdateInitialWindowMs must be at most 60000",
    )
    .default(30_000),
  guardianWaitUpdateSteadyMinIntervalMs: z
    .number({
      error: "calls.guardianWaitUpdateSteadyMinIntervalMs must be a number",
    })
    .int("calls.guardianWaitUpdateSteadyMinIntervalMs must be an integer")
    .min(1000, "calls.guardianWaitUpdateSteadyMinIntervalMs must be >= 1000")
    .max(
      60_000,
      "calls.guardianWaitUpdateSteadyMinIntervalMs must be at most 60000",
    )
    .default(20_000),
  guardianWaitUpdateSteadyMaxIntervalMs: z
    .number({
      error: "calls.guardianWaitUpdateSteadyMaxIntervalMs must be a number",
    })
    .int("calls.guardianWaitUpdateSteadyMaxIntervalMs must be an integer")
    .min(1000, "calls.guardianWaitUpdateSteadyMaxIntervalMs must be >= 1000")
    .max(
      60_000,
      "calls.guardianWaitUpdateSteadyMaxIntervalMs must be at most 60000",
    )
    .default(30_000),
  disclosure: CallsDisclosureConfigSchema.default(
    CallsDisclosureConfigSchema.parse({}),
  ),
  safety: CallsSafetyConfigSchema.default(CallsSafetyConfigSchema.parse({})),
  voice: CallsVoiceConfigSchema.default(CallsVoiceConfigSchema.parse({})),
  model: z.string({ error: "calls.model must be a string" }).optional(),
  callerIdentity: CallerIdentityConfigSchema.default(
    CallerIdentityConfigSchema.parse({}),
  ),
  verification: CallsVerificationConfigSchema.default(
    CallsVerificationConfigSchema.parse({}),
  ),
});

export type CallsConfig = z.infer<typeof CallsConfigSchema>;
export type CallsDisclosureConfig = z.infer<typeof CallsDisclosureConfigSchema>;
export type CallsSafetyConfig = z.infer<typeof CallsSafetyConfigSchema>;
export type CallsVoiceConfig = z.infer<typeof CallsVoiceConfigSchema>;
export type CallerIdentityConfig = z.infer<typeof CallerIdentityConfigSchema>;
export type CallsVerificationConfig = z.infer<
  typeof CallsVerificationConfigSchema
>;
