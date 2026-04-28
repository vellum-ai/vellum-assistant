import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

import { SEEDS } from "./seeds.js";
import type { EnvironmentDefinition } from "./types.js";

const DEFAULT_ENVIRONMENT_NAME = "production";

/**
 * Path to the user's persisted default environment file.
 * Lives at `~/.config/vellum/environment` — a fixed, environment-agnostic
 * location so it can be read before the environment is resolved.
 */
function getDefaultEnvironmentPath(): string {
  const xdgConfig =
    process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(xdgConfig, "vellum", "environment");
}

/**
 * Read the persisted default environment name, if any.
 * Returns `undefined` if no file exists or the file is empty.
 */
export function readDefaultEnvironment(): string | undefined {
  const filePath = getDefaultEnvironmentPath();
  try {
    if (!existsSync(filePath)) return undefined;
    const content = readFileSync(filePath, "utf-8").trim();
    return content.length > 0 ? content : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Persist a default environment name to the user config file.
 */
export function writeDefaultEnvironment(name: string): void {
  const filePath = getDefaultEnvironmentPath();
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, name + "\n", "utf-8");
}

/**
 * Remove the persisted default environment file, falling back to production.
 */
export function clearDefaultEnvironment(): void {
  const filePath = getDefaultEnvironmentPath();
  try {
    unlinkSync(filePath);
  } catch {
    // Already absent — nothing to do.
  }
}

/**
 * Look up a seed entry by name. Returns `undefined` if no seed matches.
 * Callers that need the full resolution stack (env-var overrides, default
 * fallback, error on unknown) should use {@link getCurrentEnvironment}
 * instead. The returned definition is a shallow copy so mutations by the
 * caller don't leak back into the seed table.
 */
export function getSeed(name: string): EnvironmentDefinition | undefined {
  const seed = SEEDS[name];
  if (!seed) return undefined;
  return { ...seed };
}

/**
 * Resolve the current environment definition.
 *
 * Priority:
 *   1. `override` argument (from a `--environment` CLI flag, when wired)
 *   2. `VELLUM_ENVIRONMENT` env var
 *   3. User config file (`~/.config/vellum/environment`, set via `vellum env set`)
 *   4. Default: `production`
 *
 * Per-field env-var overrides are honored on the resolved definition as
 * ad-hoc escape hatches (they do not materialize new environments):
 *   - `VELLUM_PLATFORM_URL` overrides `platformUrl`
 *   - `VELLUM_WEB_URL` overrides `webUrl`
 *   - `VELLUM_ASSISTANT_PLATFORM_URL` overrides `assistantPlatformUrl`
 *   - `VELLUM_LOCKFILE_DIR` overrides `lockfileDirOverride` (legacy e2e
 *     test hook)
 *
 * This function should be the single entrypoint for environment resolution.
 * No other code should drive off `VELLUM_ENVIRONMENT` directly.
 */
export function getCurrentEnvironment(
  override?: string,
): EnvironmentDefinition {
  const { name, source } = resolveEnvironmentSource(override);

  // When the environment was resolved from the config file, propagate it
  // into process.env so child processes (daemon, gateway) inherit the same
  // environment without needing to read the config file themselves.
  if (source === "config" && !process.env.VELLUM_ENVIRONMENT) {
    process.env.VELLUM_ENVIRONMENT = name;
  }

  const seed = SEEDS[name];
  if (!seed) {
    if (name !== DEFAULT_ENVIRONMENT_NAME) {
      // Warn on stderr instead of throwing, to match the silent-fallback
      // behavior in assistant/src/util/platform.ts:getXdgVellumConfigDirName
      // and clients/shared/App/VellumEnvironment.swift:current. Those two
      // silently fall back to production; the CLI should agree so all three
      // writers don't end up in disjoint states on a typo.
      process.stderr.write(
        `warning: unknown environment "${name}"; falling back to "${DEFAULT_ENVIRONMENT_NAME}". ` +
          `Add it to cli/src/lib/environments/seeds.ts and rebuild if this was intentional.\n`,
      );
    }
    const fallback = SEEDS[DEFAULT_ENVIRONMENT_NAME];
    if (!fallback) {
      throw new Error(
        `fatal: default environment "${DEFAULT_ENVIRONMENT_NAME}" missing from seed table — this is a build error`,
      );
    }
    return { ...fallback };
  }

  const resolved: EnvironmentDefinition = { ...seed };

  const platformUrlOverride = process.env.VELLUM_PLATFORM_URL?.trim();
  if (platformUrlOverride) {
    resolved.platformUrl = platformUrlOverride;
  }

  const webUrlOverride = process.env.VELLUM_WEB_URL?.trim();
  if (webUrlOverride) {
    resolved.webUrl = webUrlOverride;
  }

  const assistantPlatformUrlOverride =
    process.env.VELLUM_ASSISTANT_PLATFORM_URL?.trim();
  if (assistantPlatformUrlOverride) {
    resolved.assistantPlatformUrl = assistantPlatformUrlOverride;
  }

  const lockfileDirOverride = process.env.VELLUM_LOCKFILE_DIR?.trim();
  if (lockfileDirOverride) {
    resolved.lockfileDirOverride = lockfileDirOverride;
  }

  return resolved;
}

/**
 * Resolve the environment name and its source for diagnostics.
 */
export function resolveEnvironmentSource(override?: string): {
  name: string;
  source: "flag" | "env" | "config" | "default";
} {
  const trimmedOverride = override?.trim();
  if (trimmedOverride && trimmedOverride.length > 0) {
    return { name: trimmedOverride, source: "flag" };
  }
  const envVar = process.env.VELLUM_ENVIRONMENT?.trim();
  if (envVar && envVar.length > 0) {
    return { name: envVar, source: "env" };
  }
  const configDefault = readDefaultEnvironment();
  if (configDefault) {
    return { name: configDefault, source: "config" };
  }
  return { name: DEFAULT_ENVIRONMENT_NAME, source: "default" };
}


