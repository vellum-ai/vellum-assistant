import { homedir } from "os";
import { join } from "path";

import type { EnvironmentDefinition, PortMap } from "./types.js";

const PRODUCTION_ENVIRONMENT_NAME = "production";

/**
 * Production lockfile filenames in priority order. The current name is
 * `.vellum.lock.json`; `.vellum.lockfile.json` is the legacy name kept for
 * backward compatibility with installs that predate the rename.
 */
const PRODUCTION_LOCKFILE_NAMES = [
  ".vellum.lock.json",
  ".vellum.lockfile.json",
] as const;

const DEFAULT_PORTS: Readonly<PortMap> = {
  daemon: 7821,
  gateway: 7830,
  qdrant: 6333,
  ces: 8090,
  outboundProxy: 8080,
  tcp: 8765,
};

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
 * Lockfile candidate paths for an environment, in priority order.
 *
 * For production, returns both the current `.vellum.lock.json` and the
 * legacy `.vellum.lockfile.json` so read-side callers can fall back to the
 * legacy filename on installs that predate the rename. Non-production
 * environments are new and have a single canonical path under the env-scoped
 * XDG config directory.
 *
 * Read-side callers should iterate this array and use the first existing
 * file (matching `cli/src/lib/assistant-config.ts:readLockfile`). Write-side
 * callers should use {@link getLockfilePath}, which returns the first
 * (canonical) entry.
 *
 * `env.lockfileDirOverride` (populated by the resolver from
 * `VELLUM_LOCKFILE_DIR`) overrides the directory the lockfile lives in for
 * both production and non-production environments.
 */
export function getLockfilePaths(env: EnvironmentDefinition): string[] {
  if (env.name === PRODUCTION_ENVIRONMENT_NAME) {
    const dir = env.lockfileDirOverride ?? homedir();
    return PRODUCTION_LOCKFILE_NAMES.map((name) => join(dir, name));
  }
  const dir = env.lockfileDirOverride ?? getConfigDir(env);
  return [join(dir, "lockfile.json")];
}

/**
 * Canonical lockfile path for writes. For production this is the current
 * `.vellum.lock.json` (legacy reads handled by {@link getLockfilePaths}).
 */
export function getLockfilePath(env: EnvironmentDefinition): string {
  return getLockfilePaths(env)[0]!;
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
