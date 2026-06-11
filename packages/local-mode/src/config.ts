import os from "node:os";
import path from "node:path";

import { SEEDS } from "@vellumai/environments";

import { resolveEnvironmentName } from "./environment";

const PRODUCTION_ENVIRONMENT_NAME = "production";

export interface LocalEndpointConfig {
  lockfilePaths: string[];
  configDir: string;
  webUrl: string;
  platformUrl: string;
}

/**
 * Resolve config from environment variables. Accepts any environment-shaped
 * map, including `process.env` (whose values are `string | undefined`) and the
 * Vite plugin's `loadEnv` result.
 */
export function resolveLocalConfigFromEnv(
  env: Record<string, string | undefined>,
): LocalEndpointConfig {
  const vellumEnv = resolveEnvironmentName(env);
  const seed = SEEDS[vellumEnv] ?? SEEDS[PRODUCTION_ENVIRONMENT_NAME]!;

  return {
    lockfilePaths: resolveLockfilePaths(env),
    configDir: resolveConfigDir(env),
    webUrl: env.VELLUM_WEB_URL || seed.webUrl,
    platformUrl: env.VELLUM_PLATFORM_URL || seed.platformUrl,
  };
}

export function resolveLockfilePaths(
  env: Record<string, string | undefined>,
): string[] {
  const vellumEnv = resolveEnvironmentName(env);
  const lockfileDir = env.VELLUM_LOCKFILE_DIR;

  if (vellumEnv === PRODUCTION_ENVIRONMENT_NAME) {
    const dir = lockfileDir ?? os.homedir();
    return [
      path.join(dir, ".vellum.lock.json"),
      path.join(dir, ".vellum.lockfile.json"),
    ];
  }

  const xdgConfigHome =
    env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  const dir = lockfileDir ?? path.join(xdgConfigHome, `vellum-${vellumEnv}`);
  return [path.join(dir, "lockfile.json")];
}

export function resolveConfigDir(
  env: Record<string, string | undefined>,
): string {
  const vellumEnv = resolveEnvironmentName(env);
  const xdgConfigHome =
    env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  if (vellumEnv === PRODUCTION_ENVIRONMENT_NAME) {
    return path.join(xdgConfigHome, "vellum");
  }
  return path.join(xdgConfigHome, `vellum-${vellumEnv}`);
}

/**
 * The on-disk location of an assistant's guardian token, given an already
 * resolved config dir. The single source of truth for this path so the CLI
 * writer and every host-seam reader agree — a divergence here is what leaves a
 * freshly leased token unreadable and bricks the connect.
 */
export function guardianTokenPath(
  configDir: string,
  assistantId: string,
): string {
  return path.join(configDir, "assistants", assistantId, "guardian-token.json");
}
