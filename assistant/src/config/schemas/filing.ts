import { z } from "zod";

import { SpeedSchema } from "./inference.js";

export const FilingConfigSchema = z
  .object({
    enabled: z
      .boolean({ error: "filing.enabled must be a boolean" })
      .default(true)
      .describe(
        "Whether periodic PKB filing is enabled — processes buffer.md into topic files and reviews knowledge base organization",
      ),
    intervalMs: z
      .number({ error: "filing.intervalMs must be a number" })
      .int("filing.intervalMs must be an integer")
      .positive("filing.intervalMs must be a positive integer")
      .default(4 * 3_600_000)
      .describe("Time between filing runs in milliseconds"),
    speed: SpeedSchema.default("standard").describe(
      "Inference speed mode for filing conversations",
    ),
    activeHoursStart: z
      .number({ error: "filing.activeHoursStart must be a number" })
      .int("filing.activeHoursStart must be an integer")
      .min(0, "filing.activeHoursStart must be >= 0")
      .max(23, "filing.activeHoursStart must be <= 23")
      .nullable()
      .default(null)
      .describe(
        "Hour of the day (0-23) when filing runs begin, or null to disable active hours restriction",
      ),
    activeHoursEnd: z
      .number({ error: "filing.activeHoursEnd must be a number" })
      .int("filing.activeHoursEnd must be an integer")
      .min(0, "filing.activeHoursEnd must be >= 0")
      .max(23, "filing.activeHoursEnd must be <= 23")
      .nullable()
      .default(null)
      .describe(
        "Hour of the day (0-23) when filing runs stop, or null to disable active hours restriction",
      ),
  })
  .describe(
    "Periodic PKB (personal knowledge base) filing — processes the buffer into topic files and maintains knowledge organization",
  )
  .superRefine((config, ctx) => {
    const startNull = config.activeHoursStart == null;
    const endNull = config.activeHoursEnd == null;
    if (startNull !== endNull) {
      // Emit on both fields so validateWithSchema's delete-and-retry repair
      // can strip whichever side was set (and no-op the null side), letting
      // the config fall back to both-null defaults without a full reset.
      const message =
        "filing.activeHoursStart and filing.activeHoursEnd must both be set or both be null";
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["activeHoursStart"],
        message,
      });
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["activeHoursEnd"],
        message,
      });
      return;
    }
    if (
      config.activeHoursStart != null &&
      config.activeHoursEnd != null &&
      config.activeHoursStart === config.activeHoursEnd
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["activeHoursEnd"],
        message:
          "filing.activeHoursStart and filing.activeHoursEnd must not be equal (would create an empty window)",
      });
    }
  });

export type FilingConfig = z.infer<typeof FilingConfigSchema>;
