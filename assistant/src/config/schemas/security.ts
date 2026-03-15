import { z } from "zod";

const VALID_SECRET_ACTIONS = ["redact", "warn", "block", "prompt"] as const;
const VALID_PERMISSIONS_MODES = ["strict", "workspace"] as const;

export { VALID_PERMISSIONS_MODES, VALID_SECRET_ACTIONS };

const CustomSecretPatternSchema = z.object({
  label: z.string({
    error: "secretDetection.customPatterns[].label must be a string",
  }),
  pattern: z.string({
    error: "secretDetection.customPatterns[].pattern must be a string",
  }),
});

export const SecretDetectionConfigSchema = z.object({
  enabled: z
    .boolean({ error: "secretDetection.enabled must be a boolean" })
    .default(true),
  action: z
    .enum(VALID_SECRET_ACTIONS, {
      error: `secretDetection.action must be one of: ${VALID_SECRET_ACTIONS.join(
        ", ",
      )}`,
    })
    .default("redact"),
  entropyThreshold: z
    .number({ error: "secretDetection.entropyThreshold must be a number" })
    .finite("secretDetection.entropyThreshold must be finite")
    .positive("secretDetection.entropyThreshold must be a positive number")
    .default(4.0),
  allowOneTimeSend: z
    .boolean({ error: "secretDetection.allowOneTimeSend must be a boolean" })
    .default(false),
  blockIngress: z
    .boolean({ error: "secretDetection.blockIngress must be a boolean" })
    .default(true),
  customPatterns: z.array(CustomSecretPatternSchema).optional(),
});

export const PermissionsConfigSchema = z.object({
  mode: z
    .enum(VALID_PERMISSIONS_MODES, {
      error: `permissions.mode must be one of: ${VALID_PERMISSIONS_MODES.join(
        ", ",
      )}`,
    })
    .default("workspace"),
});

export type SecretDetectionConfig = z.infer<typeof SecretDetectionConfigSchema>;
export type PermissionsConfig = z.infer<typeof PermissionsConfigSchema>;
