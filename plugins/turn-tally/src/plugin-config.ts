/**
 * Typed view over the plugin's `config.json` (`InitContext.config`).
 * Unknown or malformed input falls back to defaults so a bad user edit
 * degrades the plugin instead of aborting its load.
 */

export interface TurnTallyConfig {
  /** When true, `post-tool-use` also keeps per-tool-name counts. */
  trackToolNames: boolean;
}

export const DEFAULT_CONFIG: TurnTallyConfig = { trackToolNames: true };

let activeConfig: TurnTallyConfig = DEFAULT_CONFIG;

export function parseConfig(raw: unknown): TurnTallyConfig {
  if (typeof raw !== "object" || raw === null) {
    return DEFAULT_CONFIG;
  }
  const candidate = (raw as { trackToolNames?: unknown }).trackToolNames;
  return {
    trackToolNames:
      typeof candidate === "boolean"
        ? candidate
        : DEFAULT_CONFIG.trackToolNames,
  };
}

/** Set by `init` so per-turn hooks read the parsed config without re-parsing. */
export function setActiveConfig(config: TurnTallyConfig): void {
  activeConfig = config;
}

export function getActiveConfig(): TurnTallyConfig {
  return activeConfig;
}
