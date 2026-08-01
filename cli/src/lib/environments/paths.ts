import { homedir } from "os";
import { join } from "path";

import type { EnvironmentDefinition, PortMap } from "@vellumai/environments";
import {
  resolveAssistantsDir,
  resolveConfigDirPaths,
  resolveLockfilePaths,
  resolveLogDir,
  resolveRuntimeDir,
  type LocalPathOptions,
} from "@vellumai/local-mode";

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
  return getConfigDirs(env)[0]!;
}

export function getConfigDirs(env: EnvironmentDefinition): string[] {
  return resolveConfigDirPaths(process.env, localPathOptions(env));
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
  return resolveLockfilePaths(process.env, localPathOptions(env));
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
  return resolveAssistantsDir(process.env, localPathOptions(env));
}

/**
 * Default port set for an environment.
 * Seed entries for non-prod environments come with separate port ranges
 * to avoid collisions in multi-env / multi-instance setups.
 * Longer term, consider allocating ports dynamically at hatch/wake time.
 */
export function getDefaultPorts(env: EnvironmentDefinition): PortMap {
  return {
    ...DEFAULT_PORTS,
    ...(env.portsOverride ?? {}),
  };
}

/**
 * Runtime state directory for an environment (upgrade logs, etc.).
 * Production uses `~/.local/share/vellum/`; non-production environments
 * use `~/.local/share/vellum-<env>/`.
 */
export function getStateDir(env: EnvironmentDefinition): string {
  return resolveRuntimeDir(process.env, localPathOptions(env));
}

export function getLogDir(env: EnvironmentDefinition): string {
  return resolveLogDir(process.env, localPathOptions(env));
}

/**
 * Path to the interactive CLI's input history file.
 *
 * Follows the XDG Base Directory spec: history files are state data
 * (persistent across runs but not portable / user-owned content), so they
 * belong under `$XDG_STATE_HOME`, mirroring `bash`, `zsh`, `psql`, and `gh`.
 * Defaults to `~/.local/state/vellum/input-history`.
 *
 * Not environment-scoped: terminal input history is per-user, not per-assistant,
 * so dev and prod CLIs share the same history file.
 */
export function getInputHistoryPath(): string {
  return join(xdgStateHome(), "vellum", "input-history");
}

/**
 * Named port constants derived from `DEFAULT_PORTS`.
 * These are the ports the assistant and gateway services bind to *inside*
 * their container (or process). They are stable across environments.
 */
export const ASSISTANT_INTERNAL_PORT = DEFAULT_PORTS.daemon;
export const GATEWAY_INTERNAL_PORT = DEFAULT_PORTS.gateway;

function xdgStateHome(): string {
  return (
    process.env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state")
  );
}

function localPathOptions(env: EnvironmentDefinition): LocalPathOptions {
  return {
    homeDir: homedir(),
    environmentName: env.name,
    configDirOverride: env.configDirOverride,
    lockfileDirOverride: env.lockfileDirOverride,
  };
}
