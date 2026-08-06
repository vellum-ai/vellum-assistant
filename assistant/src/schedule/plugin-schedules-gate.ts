import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import type { AssistantConfig } from "../config/schema.js";

const PLUGIN_SCHEDULES_FLAG_KEY = "plugin-schedules" as const;

/**
 * Whether plugins may declare schedules that register and run automatically.
 *
 * The flag is a kill switch, not just a launch gate. `reconcilePluginSchedules`
 * treats an off flag as an empty desired set and still runs its disarm branch,
 * so the next pass after turning the flag off disarms every declared row and
 * the next pass after turning it back on re-arms them. The fire-time guard in
 * `./scheduler.ts` and the run-now guard in
 * `../runtime/routes/schedule-routes.ts` close the window between the toggle
 * and that pass.
 *
 * The CLI's install-consent listing (`../cli/lib/plugin-surfaces.ts`) is not
 * gated: it only reports what a plugin's files declare, and the reconciler is
 * the point where a declaration becomes something that runs.
 */
export function isPluginSchedulesEnabled(config?: AssistantConfig): boolean {
  return isAssistantFeatureFlagEnabled(PLUGIN_SCHEDULES_FLAG_KEY, config);
}
