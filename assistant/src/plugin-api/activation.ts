import type { PluginLogger } from "./types.js";

/** Host-owned identity and lifecycle values for an active plugin surface. */
export interface PluginActivationContext {
  /** Install-directory slug assigned by the host. */
  readonly pluginId: string;
  /** Writable directory reserved for this plugin's durable state. */
  readonly pluginStorageDir: string;
  /** Assistant semver for compatibility checks. */
  readonly assistantVersion: string;
  /** Aborted when this plugin activation is stopped. */
  readonly signal: AbortSignal;
  /** Logger bound to this plugin surface. */
  readonly logger: PluginLogger;
}
