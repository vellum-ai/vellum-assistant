import { z } from "zod";

import { SpeedSchema } from "./inference.js";

export const HeartbeatConfigSchema = z
  .object({
    enabled: z
      .boolean({ error: "heartbeat.enabled must be a boolean" })
      .default(true)
      .describe("Whether periodic heartbeat checks are enabled"),
    intervalMs: z
      .number({ error: "heartbeat.intervalMs must be a number" })
      .int("heartbeat.intervalMs must be an integer")
      .positive("heartbeat.intervalMs must be a positive integer")
      .default(6 * 3_600_000)
      .describe("Time between heartbeat checks in milliseconds"),
    speed: SpeedSchema.default("standard").describe(
      "Inference speed mode for heartbeat conversations — defaults to standard to avoid inheriting the global fast mode multiplier",
    ),
    activeHoursStart: z
      .number({ error: "heartbeat.activeHoursStart must be a number" })
      .int("heartbeat.activeHoursStart must be an integer")
      .min(0, "heartbeat.activeHoursStart must be >= 0")
      .max(23, "heartbeat.activeHoursStart must be <= 23")
      .nullable()
      .default(8)
      .describe(
        "Hour of the day (0-23) when heartbeat checks begin, or null to disable active hours restriction",
      ),
    activeHoursEnd: z
      .number({ error: "heartbeat.activeHoursEnd must be a number" })
      .int("heartbeat.activeHoursEnd must be an integer")
      .min(0, "heartbeat.activeHoursEnd must be >= 0")
      .max(23, "heartbeat.activeHoursEnd must be <= 23")
      .nullable()
      .default(22)
      .describe(
        "Hour of the day (0-23) when heartbeat checks stop, or null to disable active hours restriction",
      ),
  })
  .describe("Periodic heartbeat configuration for health monitoring")
  .superRefine((config, ctx) => {
    const startNull = config.activeHoursStart == null;
    const endNull = config.activeHoursEnd == null;
    if (startNull !== endNull) {
      // Emit on both fields so validateWithSchema's delete-and-retry strips
      // both sides in one pass. Single-emit on the null side can cascade when
      // the explicit value happens to equal the opposite default (e.g.
      // { start: null, end: 8 } → strip start → default 8 → equal check fires
      // → loader falls back to full defaults, wiping unrelated keys like
      // maxTokens).
      const message =
        "heartbeat.activeHoursStart and heartbeat.activeHoursEnd must both be set or both be null";
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
      // Emit on both fields. Single-emit would strip one side and the default
      // for that side could recreate a new mismatch (e.g. { start: 22, end: 22 }
      // → strip end → default 22 → equal again), cascading to a full defaults
      // reset that wipes unrelated fields.
      const message =
        "heartbeat.activeHoursStart and heartbeat.activeHoursEnd must not be equal (would create an empty window)";
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
    }
  });

export type HeartbeatConfig = z.infer<typeof HeartbeatConfigSchema>;
