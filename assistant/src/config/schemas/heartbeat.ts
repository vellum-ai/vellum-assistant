import { Cron } from "croner";
import { z } from "zod";

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
      .default(30 * 60_000)
      .describe("Time between heartbeat checks in milliseconds"),
    cronExpression: z
      .string()
      .nullable()
      .default(null)
      .describe(
        "Cron expression for heartbeat timing. When set, heartbeats fire at the specified clock times instead of using intervalMs.",
      ),
    timezone: z
      .string()
      .nullable()
      .default(null)
      .describe(
        "Timezone for cron expression evaluation, e.g. 'America/New_York'. Ignored when cronExpression is null.",
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

    // Validate cronExpression and timezone when cronExpression is set.
    // Separate the validations so timezone errors are attributed to the
    // timezone path — if both paths point at cronExpression, the config
    // loader's delete-and-retry would strip cronExpression but leave the
    // invalid timezone, cascading to a full defaults reset.
    if (config.cronExpression != null) {
      try {
        new Cron(config.cronExpression, { maxRuns: 0 });
      } catch (err) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cronExpression"],
          message: err instanceof Error ? err.message : String(err),
        });
      }
      if (config.timezone != null) {
        try {
          new Cron(config.cronExpression, {
            maxRuns: 0,
            timezone: config.timezone,
          });
        } catch {
          // The cron expression itself is valid (or already flagged above),
          // so a failure here is from the timezone.
          try {
            Intl.DateTimeFormat(undefined, { timeZone: config.timezone });
          } catch (tzErr) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["timezone"],
              message: tzErr instanceof Error ? tzErr.message : String(tzErr),
            });
          }
        }
      }
    } else if (config.timezone != null) {
      // cronExpression is null but timezone is set — validate timezone independently
      try {
        Intl.DateTimeFormat(undefined, { timeZone: config.timezone });
      } catch (err) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["timezone"],
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  });

export type HeartbeatConfig = z.infer<typeof HeartbeatConfigSchema>;
