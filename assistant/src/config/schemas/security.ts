import { z } from "zod";

export const SecretDetectionConfigSchema = z
  .object({
    enabled: z
      .boolean({ error: "secretDetection.enabled must be a boolean" })
      .default(true)
      .describe("Whether automatic secret detection is enabled"),
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
  })
  .describe(
    "Prefix-based secret detection at user-message ingress, plus one-time-send override for the secure credential prompt",
  );

export type SecretDetectionConfig = z.infer<typeof SecretDetectionConfigSchema>;
