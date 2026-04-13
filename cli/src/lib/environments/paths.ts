import { homedir } from "os";
import { join } from "path";

import type { EnvironmentDefinition, PortMap } from "./types.js";

const PRODUCTION_ENVIRONMENT_NAME = "production";

const DEFAULT_PORTS: Readonly<PortMap> = {
  daemon: 7821,
  gateway: 7830,
  qdrant: 6333,
  ces: 8090,
  outboundProxy: 8080,
  tcp: 8765,
};

/**
 * Root data directory for an environment.
 * Production is grandfathered at `~/.vellum/` to preserve backward compatibility;
 * non-production environments use `$XDG_DATA_HOME/vellum-<env>/`.
 */
export function getDataDir(env: EnvironmentDefinition): string {
  if (env.dataDirOverride) return env.dataDirOverride;
  // `production` is the legacy-compat alias; it keeps its pre-plan path.
  if (env.name === PRODUCTION_ENVIRONMENT_NAME) {
    return join(homedir(), ".vellum");
  }
  return join(xdgDataHome(), `vellum-${env.name}`);
}

/**
 * Config directory for an environment.
 * Production preserves the existing `~/.config/vellum/` location;
 * non-production environments use `$XDG_CONFIG_HOME/vellum-<env>/`.
 */
export function getConfigDir(env: EnvironmentDefinition): string {
  if (env.configDirOverride) return env.configDirOverride;
  if (env.name === PRODUCTION_ENVIRONMENT_NAME) {
    return join(xdgConfigHome(), "vellum");
  }
  return join(xdgConfigHome(), `vellum-${env.name}`);
}

/**
 * Lockfile path for an environment.
 * Production keeps the legacy `~/.vellum.lock.json` location;
 * non-production environments store the lockfile under the env-scoped config directory.
 */
export function getLockfilePath(env: EnvironmentDefinition): string {
  if (env.name === PRODUCTION_ENVIRONMENT_NAME) {
    return join(homedir(), ".vellum.lock.json");
  }
  return join(getConfigDir(env), "lockfile.json");
}

/**
 * Multi-instance root directory for an environment. Production uses
 * `~/.local/share/vellum/assistants/` — the convention already in
 * `cli/src/lib/assistant-config.ts`. Non-production environments use
 * `~/.local/share/vellum-<env>/assistants/`.
 */
export function getMultiInstanceDir(env: EnvironmentDefinition): string {
  if (env.name === PRODUCTION_ENVIRONMENT_NAME) {
    return join(xdgDataHome(), "vellum", "assistants");
  }
  return join(xdgDataHome(), `vellum-${env.name}`, "assistants");
}

/**
 * Default port set for an environment. Phase 5 (per-env port offsets) was
 * deferred from MVP — this currently returns the same ports for every
 * environment. Per-env specialization lands in a later phase without
 * changing the function signature or call sites. `env.portsOverride` is
 * merged on top of the defaults when set.
 */
export function getDefaultPorts(env: EnvironmentDefinition): PortMap {
  return {
    ...DEFAULT_PORTS,
    ...(env.portsOverride ?? {}),
  };
}

function xdgDataHome(): string {
  return (
    process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share")
  );
}

function xdgConfigHome(): string {
  return process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
}
