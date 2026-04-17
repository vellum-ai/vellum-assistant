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
      // Emit only on the null side so validateWithSchema's delete-and-retry
      // preserves the explicit non-null value. Dual-emit would delete both
      // keys, losing valid explicit values for mixed-null configs like
      // { activeHoursStart: null, activeHoursEnd: 20 } → (8, 22) instead of
      // retaining the explicit 20.
      const message =
        "heartbeat.activeHoursStart and heartbeat.activeHoursEnd must both be set or both be null";
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [startNull ? "activeHoursStart" : "activeHoursEnd"],
        message,
      });
      return;
    }
    if (
      config.activeHoursStart != null &&
      config.activeHoursEnd != null &&
      config.activeHoursStart === config.activeHoursEnd
    ) {
      // Emit only on activeHoursEnd so the explicit start value is preserved.
      // Dual-emit would delete both keys, e.g. { start: 5, end: 5 } → (8, 22)
      // instead of preserving the explicit 5 as start → (5, 22).
      const message =
        "heartbeat.activeHoursStart and heartbeat.activeHoursEnd must not be equal (would create an empty window)";
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["activeHoursEnd"],
        message,
      });
    }
  });

export type HeartbeatConfig = z.infer<typeof HeartbeatConfigSchema>;
