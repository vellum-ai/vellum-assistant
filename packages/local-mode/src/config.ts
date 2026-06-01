import os from "node:os";
import path from "node:path";

import { SEEDS } from "@vellumai/environments";

const PRODUCTION_ENVIRONMENT_NAME = "production";

export interface LocalEndpointConfig {
  lockfilePaths: string[];
  configDir: string;
  webUrl: string;
  platformUrl: string;
}

/**
 * Resolve config from environment variables (Vite plugin context, where
 * `env` comes from `loadEnv` and process.env).
 */
export function resolveLocalConfigFromEnv(
  env: Record<string, string>,
): LocalEndpointConfig {
  const vellumEnv = env.VELLUM_ENVIRONMENT || PRODUCTION_ENVIRONMENT_NAME;
  const seed = SEEDS[vellumEnv] ?? SEEDS[PRODUCTION_ENVIRONMENT_NAME]!;

  return {
    lockfilePaths: resolveLockfilePaths(env),
    configDir: resolveConfigDir(env),
    webUrl: env.VELLUM_WEB_URL || seed.webUrl,
    platformUrl: env.VELLUM_PLATFORM_URL || seed.platformUrl,
  };
}

export function resolveLockfilePaths(env: Record<string, string>): string[] {
  const vellumEnv = env.VELLUM_ENVIRONMENT || PRODUCTION_ENVIRONMENT_NAME;
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

export function resolveConfigDir(env: Record<string, string>): string {
  const vellumEnv = env.VELLUM_ENVIRONMENT || PRODUCTION_ENVIRONMENT_NAME;
  const xdgConfigHome =
    env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  if (vellumEnv === PRODUCTION_ENVIRONMENT_NAME) {
    return path.join(xdgConfigHome, "vellum");
  }
  return path.join(xdgConfigHome, `vellum-${vellumEnv}`);
}
