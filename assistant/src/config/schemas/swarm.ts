import { z } from "zod";

export const SwarmConfigSchema = z.object({
  enabled: z
    .boolean({ error: "swarm.enabled must be a boolean" })
    .default(true),
  maxWorkers: z
    .number({ error: "swarm.maxWorkers must be a number" })
    .int("swarm.maxWorkers must be an integer")
    .positive("swarm.maxWorkers must be a positive integer")
    .max(6, "swarm.maxWorkers must be at most 6")
    .default(3),
  maxTasks: z
    .number({ error: "swarm.maxTasks must be a number" })
    .int("swarm.maxTasks must be an integer")
    .positive("swarm.maxTasks must be a positive integer")
    .max(20, "swarm.maxTasks must be at most 20")
    .default(8),
  maxRetriesPerTask: z
    .number({ error: "swarm.maxRetriesPerTask must be a number" })
    .int("swarm.maxRetriesPerTask must be an integer")
    .nonnegative("swarm.maxRetriesPerTask must be a non-negative integer")
    .max(3, "swarm.maxRetriesPerTask must be at most 3")
    .default(1),
  workerTimeoutSec: z
    .number({ error: "swarm.workerTimeoutSec must be a number" })
    .int("swarm.workerTimeoutSec must be an integer")
    .positive("swarm.workerTimeoutSec must be a positive integer")
    .default(900),
  roleTimeoutsSec: z
    .object({
      router: z.number().int().positive().optional(),
      researcher: z.number().int().positive().optional(),
      coder: z.number().int().positive().optional(),
      reviewer: z.number().int().positive().optional(),
    })
    .default({}),
  plannerModelIntent: z
    .enum(["latency-optimized", "quality-optimized", "vision-optimized"], {
      error: "swarm.plannerModelIntent must be a valid model intent",
    })
    .default("latency-optimized"),
  synthesizerModelIntent: z
    .enum(["latency-optimized", "quality-optimized", "vision-optimized"], {
      error: "swarm.synthesizerModelIntent must be a valid model intent",
    })
    .default("quality-optimized"),
});

export type SwarmConfig = z.infer<typeof SwarmConfigSchema>;
