import { z } from "zod";

/**
 * Resource monitor configuration.
 *
 * The resource monitor runs as a separate OS process (a child of the assistant)
 * that samples the container's own cgroup memory + workspace disk off the main
 * event loop, so it keeps recording during a main-thread freeze and its samples
 * survive an OOM SIGKILL. `assistant resource-monitor start`/`stop` flip
 * `enabled` (and spawn/stop the process) to switch it on or off at runtime
 * without a restart; when `enabled` is set the assistant also spawns it at
 * startup.
 */
export const ResourceMonitorConfigSchema = z
  .object({
    enabled: z
      .boolean({ error: "resourceMonitor.enabled must be a boolean" })
      .default(false)
      .describe(
        "Whether the resource monitor process runs. When set, the assistant spawns it at startup and it samples cgroup memory + workspace disk into a ring buffer on the workspace volume. `assistant resource-monitor start`/`stop` flip this flag at runtime.",
      ),
    sampleIntervalMs: z
      .number({ error: "resourceMonitor.sampleIntervalMs must be a number" })
      .int("resourceMonitor.sampleIntervalMs must be an integer")
      .min(50, "resourceMonitor.sampleIntervalMs must be at least 50ms")
      .max(10_000, "resourceMonitor.sampleIntervalMs must be <= 10000ms")
      .default(250)
      .describe(
        "How often the monitor samples memory + disk, in milliseconds. Fast (default 250ms) so vertical memory spikes are caught before an OOM kill.",
      ),
    ringBufferSize: z
      .number({ error: "resourceMonitor.ringBufferSize must be a number" })
      .int("resourceMonitor.ringBufferSize must be an integer")
      .min(100, "resourceMonitor.ringBufferSize must be at least 100")
      .max(100_000, "resourceMonitor.ringBufferSize must be <= 100000")
      .default(4000)
      .describe(
        "How many recent samples the on-disk ring buffer retains. At the default 250ms interval, 4000 samples is ~16 minutes of history preserved across a crash.",
      ),
    highMemThresholdRatio: z
      .number({
        error: "resourceMonitor.highMemThresholdRatio must be a number",
      })
      .min(0.1, "resourceMonitor.highMemThresholdRatio must be >= 0.1")
      .max(1, "resourceMonitor.highMemThresholdRatio must be <= 1")
      .default(0.75)
      .describe(
        "Fraction of the container memory limit at which a high-memory snapshot (cgroup stats + process tree) is captured to the workspace volume. Default 0.75 (e.g. ~6 GiB of an 8 GiB limit).",
      ),
    snapshotCooldownMs: z
      .number({ error: "resourceMonitor.snapshotCooldownMs must be a number" })
      .int("resourceMonitor.snapshotCooldownMs must be an integer")
      .min(0, "resourceMonitor.snapshotCooldownMs must be non-negative")
      .default(30_000)
      .describe(
        "Minimum interval between high-memory snapshots, in milliseconds, so a sustained spike does not write a snapshot on every sample.",
      ),
  })
  .describe("Resource monitor process configuration");

export type ResourceMonitorConfig = z.infer<typeof ResourceMonitorConfigSchema>;
