import { z } from "zod";

const VALID_SECRET_ACTIONS = ["redact", "warn", "block", "prompt"] as const;
const VALID_PERMISSIONS_MODES = ["strict", "workspace"] as const;

export { VALID_PERMISSIONS_MODES, VALID_SECRET_ACTIONS };

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

export const PermissionsConfigSchema = z
  .object({
    mode: z
      .enum(VALID_PERMISSIONS_MODES, {
        error: `permissions.mode must be one of: ${VALID_PERMISSIONS_MODES.join(
          ", ",
        )}`,
      })
      .default("workspace")
      .describe(
        "Permission mode — 'strict' requires explicit approval for all operations, 'workspace' allows operations within the workspace",
      ),
    hostAccess: z
      .boolean({
        error: "permissions.hostAccess must be a boolean",
      })
      .default(false)
      .describe(
        "Whether the assistant can execute commands on the host machine without prompting",
      ),
  })
  .describe("Permission enforcement mode for tool operations");

export type SecretDetectionConfig = z.infer<typeof SecretDetectionConfigSchema>;
export type PermissionsConfig = z.infer<typeof PermissionsConfigSchema>;
