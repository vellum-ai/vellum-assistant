import { z } from "zod";

/**
 * Schedule worker process configuration.
 *
 * The schedule worker runs scheduled jobs as a separate OS process — a child
 * of the assistant — so expensive scheduled work executes off the assistant's
 * main event loop and keeps running during a main-thread freeze. The
 * assistant's scheduler re-reads the flag on every tick: while it is set, the
 * in-process scheduler leaves schedule execution to the worker (spawned at
 * startup when set); while it is unset, the in-process scheduler runs
 * schedules itself. `assistant schedules worker start`/`stop` flip the flag
 * (and spawn/stop the worker process) to switch modes at runtime without a
 * restart.
 */
export const ScheduleWorkerConfigSchema = z
  .object({
    enabled: z
      .boolean({ error: "schedules.worker.enabled must be a boolean" })
      .default(false)
      .describe(
        "Whether scheduled jobs run in a separate schedule worker OS process instead of the assistant's in-process scheduler. When set, the assistant spawns the worker at startup and its own scheduler stands down from executing schedules. `assistant schedules worker start`/`stop` flip this flag at runtime.",
      ),
  })
  .describe("Schedule worker process configuration");

export const SchedulesConfigSchema = z
  .object({
    worker: ScheduleWorkerConfigSchema.default(
      ScheduleWorkerConfigSchema.parse({}),
    ),
  })
  .describe("Scheduler configuration");

export type SchedulesConfig = z.infer<typeof SchedulesConfigSchema>;
