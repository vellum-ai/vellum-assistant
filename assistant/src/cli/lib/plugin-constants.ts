/**
 * Plugin constants shared by CLI registration (option descriptions, defaults)
 * and the implementation modules. Dependency-free so registration never loads
 * the implementations.
 */

/** Default git ref for marketplace plugin installs. */
export const DEFAULT_PLUGIN_REF = "main";

/** Default number of pins shown by `assistant plugins pins`. */
export const DEFAULT_PIN_HISTORY_LIMIT = 5;

export type PluginUpgradeStrategy =
  | "ours"
  | "theirs"
  | "overwrite"
  | "assistant";

export const PLUGIN_UPGRADE_STRATEGIES: readonly PluginUpgradeStrategy[] = [
  "ours",
  "theirs",
  "overwrite",
  "assistant",
];

export const DEFAULT_PLUGIN_UPGRADE_STRATEGY: PluginUpgradeStrategy =
  "overwrite";
