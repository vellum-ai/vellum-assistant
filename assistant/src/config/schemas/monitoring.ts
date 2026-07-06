import { z } from "zod";

/**
 * Resource monitor configuration.
 *
 * The resource monitor runs as a separate OS process (a child of the assistant)
 * that samples the container's own cgroup memory + workspace disk off the main
 * event loop, so it keeps recording during a main-thread freeze and its samples
 * survive an OOM SIGKILL. The assistant spawns it at every startup — it is
 * platform infrastructure, not an opt-in feature, and there is deliberately no
 * config switch to turn it off. `assistant monitoring start`/`stop` control the
 * process at runtime only; a stopped monitor respawns on the next boot.
 */
export const MonitoringConfigSchema = z
  .object({
    sampleIntervalMs: z
      .number({ error: "monitoring.sampleIntervalMs must be a number" })
      .int("monitoring.sampleIntervalMs must be an integer")
      .min(50, "monitoring.sampleIntervalMs must be at least 50ms")
      .max(10_000, "monitoring.sampleIntervalMs must be <= 10000ms")
      .default(250)
      .describe(
        "How often the monitor samples memory + disk, in milliseconds. Fast (default 250ms) so vertical memory spikes are caught before an OOM kill.",
      ),
    ringBufferSize: z
      .number({ error: "monitoring.ringBufferSize must be a number" })
      .int("monitoring.ringBufferSize must be an integer")
      .min(100, "monitoring.ringBufferSize must be at least 100")
      .max(100_000, "monitoring.ringBufferSize must be <= 100000")
      .default(4000)
      .describe(
        "How many recent samples the on-disk ring buffer retains. At the default 250ms interval, 4000 samples is ~16 minutes of history preserved across a crash.",
      ),
    highMemThresholdRatio: z
      .number({
        error: "monitoring.highMemThresholdRatio must be a number",
      })
      .min(0.1, "monitoring.highMemThresholdRatio must be >= 0.1")
      .max(1, "monitoring.highMemThresholdRatio must be <= 1")
      .default(0.75)
      .describe(
        "Fraction of the container memory limit at which a high-memory snapshot (cgroup stats + process tree) is captured to the workspace volume. Default 0.75 (e.g. ~6 GiB of an 8 GiB limit).",
      ),
    snapshotCooldownMs: z
      .number({ error: "monitoring.snapshotCooldownMs must be a number" })
      .int("monitoring.snapshotCooldownMs must be an integer")
      .min(0, "monitoring.snapshotCooldownMs must be non-negative")
      .default(30_000)
      .describe(
        "Minimum interval between high-memory snapshots, in milliseconds, so a sustained spike does not write a snapshot on every sample.",
      ),
    baselineSnapshotIntervalMs: z
      .number({
        error: "monitoring.baselineSnapshotIntervalMs must be a number",
      })
      .int("monitoring.baselineSnapshotIntervalMs must be an integer")
      .min(60_000, "monitoring.baselineSnapshotIntervalMs must be >= 60000ms")
      .default(600_000)
      .describe(
        "Interval between periodic baseline snapshots, in milliseconds (default 10 minutes). Baselines capture the same forensics as high-memory snapshots but on a steady cadence, so a spike can be diffed against a healthy reference instead of only against other over-threshold captures. Retained separately from high-memory snapshots.",
      ),
  })
  .describe("Resource monitor process configuration");

export type MonitoringConfig = z.infer<typeof MonitoringConfigSchema>;
