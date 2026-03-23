import { z } from "zod";

const VALID_CALL_PROVIDERS = ["twilio"] as const;
export const VALID_CALLER_IDENTITY_MODES = [
  "assistant_number",
  "user_number",
] as const;
const VALID_CALL_TRANSCRIPTION_PROVIDERS = ["Deepgram", "Google"] as const;
export const VALID_TTS_PROVIDERS = ["elevenlabs", "fish-audio"] as const;

export const CallsDisclosureConfigSchema = z
  .object({
    enabled: z
      .boolean({ error: "calls.disclosure.enabled must be a boolean" })
      .default(true)
      .describe(
        "Whether the assistant discloses it is calling on behalf of someone at the start of a call",
      ),
    text: z
      .string({ error: "calls.disclosure.text must be a string" })
      .default(
        'At the very beginning of the call, introduce yourself as an assistant calling on behalf of the person you represent. Do not say "AI assistant".',
      )
      .describe(
        "The instruction text used for the disclosure at the start of a call",
      ),
  })
  .describe(
    "Controls whether and how the assistant discloses its nature at the start of a phone call",
  );

export const CallsSafetyConfigSchema = z
  .object({
    denyCategories: z
      .array(
        z.string({
          error: "calls.safety.denyCategories values must be strings",
        }),
      )
      .default([])
      .describe(
        "Categories of calls that should be denied (e.g. for safety or compliance reasons)",
      ),
  })
  .describe("Safety guardrails for phone calls");

export const CallsVoiceConfigSchema = z
  .object({
    language: z
      .string({ error: "calls.voice.language must be a string" })
      .default("en-US")
      .describe("BCP-47 language code for speech recognition and synthesis"),
    transcriptionProvider: z
      .enum(VALID_CALL_TRANSCRIPTION_PROVIDERS, {
        error: `calls.voice.transcriptionProvider must be one of: ${VALID_CALL_TRANSCRIPTION_PROVIDERS.join(
          ", ",
        )}`,
      })
      .default("Deepgram")
      .describe("Speech-to-text provider used for call transcription"),
    speechModel: z
      .string({ error: "calls.voice.speechModel must be a string" })
      .optional()
      .describe(
        "ASR model to use for speech recognition (e.g. nova-3, nova-2-phonecall for Deepgram; telephony, long for Google)",
      ),
    ttsProvider: z
      .enum(VALID_TTS_PROVIDERS, {
        error: `calls.voice.ttsProvider must be one of: ${VALID_TTS_PROVIDERS.join(", ")}`,
      })
      .default("elevenlabs")
      .describe("Text-to-speech provider for phone calls"),
    hints: z
      .array(
        z.string({ error: "calls.voice.hints values must be strings" }),
      )
      .default([])
      .describe(
        "Static vocabulary hints for speech recognition — proper nouns, domain terms, and other words the STT provider should prioritize",
      ),
    interruptSensitivity: z
      .enum(["low", "medium", "high"], {
        error:
          "calls.voice.interruptSensitivity must be one of: low, medium, high",
      })
      .default("low")
      .describe(
        "How aggressively the STT provider detects the start of caller speech — low reduces false interrupts from background noise",
      ),
  })
  .describe("Voice and speech settings for phone calls");

export const CallerIdentityConfigSchema = z
  .object({
    allowPerCallOverride: z
      .boolean({
        error: "calls.callerIdentity.allowPerCallOverride must be a boolean",
      })
      .default(true)
      .describe("Whether the caller ID can be overridden on a per-call basis"),
    userNumber: z
      .string({ error: "calls.callerIdentity.userNumber must be a string" })
      .optional()
      .describe(
        "Phone number to display as the caller ID when using user_number mode",
      ),
  })
  .describe("Controls which phone number is shown as the caller ID");

export const CallsVerificationConfigSchema = z
  .object({
    enabled: z
      .boolean({ error: "calls.verification.enabled must be a boolean" })
      .default(false)
      .describe(
        "Whether callers must verify their identity with a code before the call proceeds",
      ),
    maxAttempts: z
      .number({ error: "calls.verification.maxAttempts must be a number" })
      .int("calls.verification.maxAttempts must be an integer")
      .positive("calls.verification.maxAttempts must be a positive integer")
      .default(3)
      .describe("Maximum number of verification code attempts before failing"),
    codeLength: z
      .number({ error: "calls.verification.codeLength must be a number" })
      .int("calls.verification.codeLength must be an integer")
      .positive("calls.verification.codeLength must be a positive integer")
      .default(6)
      .describe("Number of digits in the verification code"),
  })
  .describe(
    "Caller verification settings — requires callers to enter a code before proceeding",
  );

export const CallsConfigSchema = z
  .object({
    enabled: z
      .boolean({ error: "calls.enabled must be a boolean" })
      .default(true)
      .describe("Whether phone call functionality is enabled"),
    provider: z
      .enum(VALID_CALL_PROVIDERS, {
        error: `calls.provider must be one of: ${VALID_CALL_PROVIDERS.join(
          ", ",
        )}`,
      })
      .default("twilio")
      .describe("Telephony provider used for placing and receiving calls"),
    maxDurationSeconds: z
      .number({ error: "calls.maxDurationSeconds must be a number" })
      .int("calls.maxDurationSeconds must be an integer")
      .positive("calls.maxDurationSeconds must be a positive integer")
      .max(
        2_147_483,
        "calls.maxDurationSeconds must be at most 2147483 (setTimeout-safe limit)",
      )
      .default(3600)
      .describe("Maximum duration of a single call in seconds"),
    userConsultTimeoutSeconds: z
      .number({ error: "calls.userConsultTimeoutSeconds must be a number" })
      .int("calls.userConsultTimeoutSeconds must be an integer")
      .positive("calls.userConsultTimeoutSeconds must be a positive integer")
      .max(
        2_147_483,
        "calls.userConsultTimeoutSeconds must be at most 2147483 (setTimeout-safe limit)",
      )
      .default(120)
      .describe(
        "How long to wait for the user to respond to a consultation request during a call",
      ),
    ttsPlaybackDelayMs: z
      .number({ error: "calls.ttsPlaybackDelayMs must be a number" })
      .int("calls.ttsPlaybackDelayMs must be an integer")
      .min(0, "calls.ttsPlaybackDelayMs must be >= 0")
      .max(10_000, "calls.ttsPlaybackDelayMs must be at most 10000")
      .default(3000)
      .describe(
        "Delay in milliseconds before starting TTS playback to allow audio buffering",
      ),
    accessRequestPollIntervalMs: z
      .number({ error: "calls.accessRequestPollIntervalMs must be a number" })
      .int("calls.accessRequestPollIntervalMs must be an integer")
      .min(50, "calls.accessRequestPollIntervalMs must be >= 50")
      .max(10_000, "calls.accessRequestPollIntervalMs must be at most 10000")
      .default(500)
      .describe(
        "How often to poll for access request approval during a call (ms)",
      ),
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
      .default(15_000)
      .describe(
        "Initial interval between guardian wait status updates during a call (ms)",
      ),
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
      .default(30_000)
      .describe(
        "Duration of the initial window for guardian wait updates before switching to steady-state (ms)",
      ),
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
      .default(20_000)
      .describe(
        "Minimum interval between steady-state guardian wait updates (ms)",
      ),
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
      .default(30_000)
      .describe(
        "Maximum interval between steady-state guardian wait updates (ms)",
      ),
    disclosure: CallsDisclosureConfigSchema.default(
      CallsDisclosureConfigSchema.parse({}),
    ),
    safety: CallsSafetyConfigSchema.default(CallsSafetyConfigSchema.parse({})),
    voice: CallsVoiceConfigSchema.default(CallsVoiceConfigSchema.parse({})),
    model: z
      .string({ error: "calls.model must be a string" })
      .optional()
      .describe("Override the default model for phone call conversations"),
    callerIdentity: CallerIdentityConfigSchema.default(
      CallerIdentityConfigSchema.parse({}),
    ),
    verification: CallsVerificationConfigSchema.default(
      CallsVerificationConfigSchema.parse({}),
    ),
  })
  .describe(
    "Phone call configuration — controls telephony, voice, safety, and call behavior",
  );

export type CallsConfig = z.infer<typeof CallsConfigSchema>;
export type CallsDisclosureConfig = z.infer<typeof CallsDisclosureConfigSchema>;
export type CallsSafetyConfig = z.infer<typeof CallsSafetyConfigSchema>;
export type CallsVoiceConfig = z.infer<typeof CallsVoiceConfigSchema>;
export type CallerIdentityConfig = z.infer<typeof CallerIdentityConfigSchema>;
export type CallsVerificationConfig = z.infer<
  typeof CallsVerificationConfigSchema
>;
