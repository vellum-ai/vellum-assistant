import { z } from "zod";

export const SwarmConfigSchema = z
  .object({
    enabled: z
      .boolean({ error: "swarm.enabled must be a boolean" })
      .default(true)
      .describe("Whether swarm (parallel multi-agent) execution is enabled"),
    maxWorkers: z
      .number({ error: "swarm.maxWorkers must be a number" })
      .int("swarm.maxWorkers must be an integer")
      .positive("swarm.maxWorkers must be a positive integer")
      .max(6, "swarm.maxWorkers must be at most 6")
      .default(3)
      .describe("Maximum number of concurrent swarm workers"),
    maxTasks: z
      .number({ error: "swarm.maxTasks must be a number" })
      .int("swarm.maxTasks must be an integer")
      .positive("swarm.maxTasks must be a positive integer")
      .max(20, "swarm.maxTasks must be at most 20")
      .default(8)
      .describe("Maximum number of tasks a single swarm can execute"),
    maxRetriesPerTask: z
      .number({ error: "swarm.maxRetriesPerTask must be a number" })
      .int("swarm.maxRetriesPerTask must be an integer")
      .nonnegative("swarm.maxRetriesPerTask must be a non-negative integer")
      .max(3, "swarm.maxRetriesPerTask must be at most 3")
      .default(1)
      .describe("Maximum number of retries for a failed swarm task"),
    workerTimeoutSec: z
      .number({ error: "swarm.workerTimeoutSec must be a number" })
      .int("swarm.workerTimeoutSec must be an integer")
      .positive("swarm.workerTimeoutSec must be a positive integer")
      .default(900)
      .describe("Timeout for a single swarm worker in seconds"),
    roleTimeoutsSec: z
      .object({
        router: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Timeout override for router workers (seconds)"),
        researcher: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Timeout override for researcher workers (seconds)"),
        coder: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Timeout override for coder workers (seconds)"),
        reviewer: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Timeout override for reviewer workers (seconds)"),
      })
      .default({})
      .describe("Per-role timeout overrides for swarm workers"),
    plannerModelIntent: z
      .enum(["latency-optimized", "quality-optimized", "vision-optimized"], {
        error: "swarm.plannerModelIntent must be a valid model intent",
      })
      .default("latency-optimized")
      .describe("Model selection strategy for the swarm planning phase"),
    synthesizerModelIntent: z
      .enum(["latency-optimized", "quality-optimized", "vision-optimized"], {
        error: "swarm.synthesizerModelIntent must be a valid model intent",
      })
      .default("quality-optimized")
      .describe(
        "Model selection strategy for the swarm synthesis (result-combining) phase",
      ),
  })
  .describe("Swarm configuration — parallel multi-agent task execution");

export type SwarmConfig = z.infer<typeof SwarmConfigSchema>;
