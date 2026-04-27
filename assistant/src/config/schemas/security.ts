import { z } from "zod";

const VALID_SECRET_ACTIONS = ["redact", "warn", "block", "prompt"] as const;

const CustomSecretPatternSchema = z
  .object({
    label: z
      .string({
        error: "secretDetection.customPatterns[].label must be a string",
      })
      .describe("Human-readable label for this secret pattern"),
    pattern: z
      .string({
        error: "secretDetection.customPatterns[].pattern must be a string",
      })
      .describe("Regular expression pattern to match secrets"),
  })
  .describe("Custom pattern for detecting secrets in messages");

export const SecretDetectionConfigSchema = z
  .object({
    enabled: z
      .boolean({ error: "secretDetection.enabled must be a boolean" })
      .default(true)
      .describe("Whether automatic secret detection is enabled"),
    action: z
      .enum(VALID_SECRET_ACTIONS, {
        error: `secretDetection.action must be one of: ${VALID_SECRET_ACTIONS.join(
          ", ",
        )}`,
      })
      .default("redact")
      .describe(
        "Action to take when a secret is detected: redact (replace with placeholder), warn (log a warning), block (reject the message), or prompt (ask the user)",
      ),
    entropyThreshold: z
      .number({ error: "secretDetection.entropyThreshold must be a number" })
      .finite("secretDetection.entropyThreshold must be finite")
      .positive("secretDetection.entropyThreshold must be a positive number")
      .default(4.0)
      .describe(
        "Shannon entropy threshold for detecting high-entropy strings as potential secrets",
      ),
    blockIngress: z
      .boolean({ error: "secretDetection.blockIngress must be a boolean" })
      .default(true)
      .describe(
        "Whether to block user messages containing detected secrets at ingress",
      ),
    allowOneTimeSend: z
      .boolean({ error: "secretDetection.allowOneTimeSend must be a boolean" })
      .default(false)
      .describe(
        "Whether to allow sending a detected secret once (with user confirmation) before redacting future occurrences",
      ),
    customPatterns: z
      .array(CustomSecretPatternSchema)
      .optional()
      .describe(
        "Additional regex patterns for detecting domain-specific secrets",
      ),
  })
  .describe(
    "Automatic secret detection and redaction to prevent leaking sensitive data",
  );

export type SecretDetectionConfig = z.infer<typeof SecretDetectionConfigSchema>;
