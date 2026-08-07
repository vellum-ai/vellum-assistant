import { z } from "zod";

/**
 * Unattended plugin upgrade configuration.
 *
 * The resource monitor process runs a periodic sweep (see
 * `monitoring/plugin-auto-update.ts`) that moves every installed, enabled
 * marketplace plugin to the catalog's current pin. The sweep is off by default:
 * `mode: "manual"` means nothing upgrades unless a human runs
 * `assistant plugins upgrade <name>` (or the equivalent route), which is the
 * behavior every workspace had before this block existed. Setting
 * `mode: "auto"` opts the workspace into the hourly sweep.
 *
 * Opting in never covers plugins installed straight from a GitHub URL. Those
 * track a mutable ref rather than a reviewed pin, so the sweep leaves them to
 * an explicit `assistant plugins upgrade`.
 */
export const PluginUpdatesConfigSchema = z
  .object({
    mode: z
      .enum(["manual", "auto"], {
        error: 'pluginUpdates.mode must be "manual" or "auto"',
      })
      .default("manual")
      .describe(
        'How installed plugins move to newer revisions. "manual" (default) never upgrades on its own: upgrades happen only when a human asks for one. "auto" lets the resource monitor upgrade every installed, enabled marketplace plugin on the `checkIntervalMs` cadence. Plugins installed directly from a GitHub URL are never upgraded automatically, since they track a mutable ref instead of a reviewed pin.',
      ),
    strategy: z
      // Deliberately narrower than the full `PluginUpgradeStrategy` union: the
      // `assistant` strategy resolves conflicts by writing git conflict
      // markers into the plugin's files and expecting someone to resolve
      // them. Unattended, that would leave a syntactically broken plugin on
      // disk with nobody in the loop, so it is not selectable here. It stays
      // available for interactive `assistant plugins upgrade --strategy
      // assistant`.
      .enum(["theirs", "ours", "overwrite"], {
        error:
          'pluginUpdates.strategy must be "theirs", "ours", or "overwrite"',
      })
      .default("theirs")
      .describe(
        'How an automatic upgrade reconciles local edits to a plugin with the incoming revision. "theirs" (default) three-way merges and resolves conflicting hunks toward the incoming revision, keeping non-conflicting local edits; "ours" merges the same way but resolves conflicts toward the local edit; "overwrite" discards local edits and re-installs the revision wholesale. Only consulted when `mode` is "auto".',
      ),
    checkIntervalMs: z
      .number({ error: "pluginUpdates.checkIntervalMs must be a number" })
      .int("pluginUpdates.checkIntervalMs must be an integer")
      .min(300_000, "pluginUpdates.checkIntervalMs must be at least 300000ms")
      .max(
        604_800_000,
        "pluginUpdates.checkIntervalMs must be <= 604800000ms (7 days)",
      )
      .default(3_600_000)
      .describe(
        'Minimum interval between automatic upgrade sweeps, in milliseconds (default 1 hour). The last sweep is stamped on disk, so restarting the daemon does not re-run a sweep that already ran within the interval. Only consulted when `mode` is "auto".',
      ),
  })
  .describe("Unattended plugin upgrade configuration");

export type PluginUpdatesConfig = z.infer<typeof PluginUpdatesConfigSchema>;
