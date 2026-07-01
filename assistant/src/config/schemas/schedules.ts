import { z } from "zod";

/**
 * Schedule worker process configuration.
 *
 * The schedule worker runs script-mode schedules (shell commands, no LLM) as a
 * separate OS process — a child of the assistant — so expensive scheduled
 * scripts execute off the assistant's main event loop and keep running during
 * a main-thread freeze. The assistant's scheduler re-reads the flag on every
 * tick: while it is set, the in-process scheduler leaves script-mode schedules
 * to the worker (spawned at startup when set); while it is unset, the
 * in-process scheduler runs every mode itself. Non-script modes (execute,
 * notify, wake, workflow) always run in the assistant, whose agent pipeline
 * they depend on. `assistant schedules worker start`/`stop` flip the flag (and
 * spawn/stop the worker process) to switch modes at runtime without a restart.
 */
export const ScheduleWorkerConfigSchema = z
  .object({
    enabled: z
      .boolean({ error: "schedules.worker.enabled must be a boolean" })
      .default(false)
      .describe(
        "Whether script-mode schedules run in a separate schedule worker OS process instead of the assistant's in-process scheduler. When set, the assistant spawns the worker at startup and its own scheduler skips script-mode schedules. `assistant schedules worker start`/`stop` flip this flag at runtime.",
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
