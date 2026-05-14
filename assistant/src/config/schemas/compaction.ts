import { z } from "zod";

export const CompactionConfigSchema = z
  .object({
    enabled: z
      .boolean({ error: "compaction.enabled must be a boolean" })
      .default(true)
      .describe("Whether assistant-driven context compaction is enabled"),
    autoThreshold: z
      .number({ error: "compaction.autoThreshold must be a number" })
      .finite("compaction.autoThreshold must be finite")
      .gt(0, "compaction.autoThreshold must be greater than 0")
      .lte(1, "compaction.autoThreshold must be less than or equal to 1")
      .default(0.7)
      .describe(
        "Fraction of the context window at which automatic compaction fires",
      ),
    prompt: z
      .string({ error: "compaction.prompt must be a string" })
      .nullable()
      .optional()
      .describe(
        "Custom compaction instruction. When set, replaces the generic default verbatim. The `{image_manifest}` placeholder is still interpolated.",
      ),
  })
  .describe("Assistant-driven context compaction");

export type CompactionConfig = z.infer<typeof CompactionConfigSchema>;
