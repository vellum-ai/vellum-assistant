import os from "node:os";

import { SEEDS } from "@vellumai/environments";

import { resolveEnvironmentName } from "./environment";
import {
  assertSafePathSegment,
  joinLocalPath,
  resolveConfigHome,
  resolveDataHome,
  type LocalPathOptions,
} from "./paths";

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
  options: LocalPathOptions = {},
): LocalEndpointConfig {
  const vellumEnv = resolveEnvironmentName(env, options);
  const seed = SEEDS[vellumEnv] ?? SEEDS[PRODUCTION_ENVIRONMENT_NAME]!;

  return {
    lockfilePaths: resolveLockfilePaths(env, options),
    configDir: resolveConfigDir(env, options),
    webUrl: env.VELLUM_WEB_URL || seed.webUrl,
    platformUrl: env.VELLUM_PLATFORM_URL || seed.platformUrl,
  };
}

export function resolveLockfilePaths(
  env: Record<string, string | undefined>,
  options: LocalPathOptions = {},
): string[] {
  const vellumEnv = resolveEnvironmentName(env, options);
  const lockfileDir = env.VELLUM_LOCKFILE_DIR;

  if ((options.platform ?? process.platform) === "win32") {
    const dir = lockfileDir ?? resolveConfigDir(env, options);
    return [joinLocalPath(options, dir, "lockfile.json")];
  }

  if (vellumEnv === PRODUCTION_ENVIRONMENT_NAME) {
    const dir = lockfileDir ?? options.homeDir ?? os.homedir();
    return [
      joinLocalPath(options, dir, ".vellum.lock.json"),
      joinLocalPath(options, dir, ".vellum.lockfile.json"),
    ];
  }

  const dir = lockfileDir ?? resolveConfigDir(env, options);
  return [joinLocalPath(options, dir, "lockfile.json")];
}

export function resolveConfigDir(
  env: Record<string, string | undefined>,
  options: LocalPathOptions = {},
): string {
  const vellumEnv = resolveEnvironmentName(env, options);
  return joinLocalPath(
    options,
    resolveConfigHome(env, options),
    environmentDirectoryName(vellumEnv, options),
  );
}

function environmentDirectoryName(
  vellumEnv: string,
  options: LocalPathOptions,
): string {
  assertSafePathSegment(vellumEnv, "environment name", options);
  return vellumEnv === PRODUCTION_ENVIRONMENT_NAME
    ? "vellum"
    : `vellum-${vellumEnv}`;
}

function resolveDataDir(
  env: Record<string, string | undefined>,
  options: LocalPathOptions,
): string {
  const vellumEnv = resolveEnvironmentName(env, options);
  return joinLocalPath(
    options,
    resolveDataHome(env, options),
    environmentDirectoryName(vellumEnv, options),
  );
}

export function resolveRuntimeDir(
  env: Record<string, string | undefined>,
  options: LocalPathOptions = {},
): string {
  return joinLocalPath(options, resolveDataDir(env, options), "runtime");
}

export function resolveLogDir(
  env: Record<string, string | undefined>,
  options: LocalPathOptions = {},
): string {
  return joinLocalPath(options, resolveDataDir(env, options), "logs");
}

export function resolveInstanceDir(
  env: Record<string, string | undefined>,
  assistantId: string,
  options: LocalPathOptions = {},
): string {
  assertSafePathSegment(assistantId, "assistant ID", options);
  return joinLocalPath(
    options,
    resolveDataDir(env, options),
    "assistants",
    assistantId,
  );
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
  options: LocalPathOptions = {},
): string {
  assertSafePathSegment(assistantId, "assistant ID", options);
  return joinLocalPath(
    options,
    configDir,
    "assistants",
    assistantId,
    "guardian-token.json",
  );
}
