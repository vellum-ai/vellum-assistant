import { z } from "zod";

import { SpeedSchema } from "./inference.js";

export const HeartbeatConfigSchema = z
  .object({
    enabled: z
      .boolean({ error: "heartbeat.enabled must be a boolean" })
      .default(false)
      .describe("Whether periodic heartbeat checks are enabled"),
    intervalMs: z
      .number({ error: "heartbeat.intervalMs must be a number" })
      .int("heartbeat.intervalMs must be an integer")
      .positive("heartbeat.intervalMs must be a positive integer")
      .default(3_600_000)
      .describe("Time between heartbeat checks in milliseconds"),
    speed: SpeedSchema.default("standard").describe(
      "Inference speed mode for heartbeat conversations — defaults to standard to avoid inheriting the global fast mode multiplier",
    ),
    activeHoursStart: z
      .number({ error: "heartbeat.activeHoursStart must be a number" })
      .int("heartbeat.activeHoursStart must be an integer")
      .min(0, "heartbeat.activeHoursStart must be >= 0")
      .max(23, "heartbeat.activeHoursStart must be <= 23")
      .optional()
      .describe(
        "Hour of the day (0-23) when heartbeat checks begin — must be set together with activeHoursEnd",
      ),
    activeHoursEnd: z
      .number({ error: "heartbeat.activeHoursEnd must be a number" })
      .int("heartbeat.activeHoursEnd must be an integer")
      .min(0, "heartbeat.activeHoursEnd must be >= 0")
      .max(23, "heartbeat.activeHoursEnd must be <= 23")
      .optional()
      .describe(
        "Hour of the day (0-23) when heartbeat checks stop — must be set together with activeHoursStart",
      ),
  })
  .describe("Periodic heartbeat configuration for health monitoring")
  .superRefine((config, ctx) => {
    const hasStart = config.activeHoursStart != null;
    const hasEnd = config.activeHoursEnd != null;
    if (hasStart !== hasEnd) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [hasStart ? "activeHoursEnd" : "activeHoursStart"],
        message:
          "heartbeat.activeHoursStart and heartbeat.activeHoursEnd must both be set or both be omitted",
      });
    }
    if (
      hasStart &&
      hasEnd &&
      config.activeHoursStart === config.activeHoursEnd
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["activeHoursEnd"],
        message:
          "heartbeat.activeHoursStart and heartbeat.activeHoursEnd must not be equal (would create an empty window)",
      });
    }
  });

export type HeartbeatConfig = z.infer<typeof HeartbeatConfigSchema>;
