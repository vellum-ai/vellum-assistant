import os from "node:os";

import { SEEDS } from "@vellumai/environments";

import { resolveEnvironmentName } from "./environment";
import {
  assertSafePathSegment,
  joinLocalPath,
  resolveConfigHomes,
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
  const lockfileDir = Object.hasOwn(options, "lockfileDirOverride")
    ? options.lockfileDirOverride
    : env.VELLUM_LOCKFILE_DIR?.trim();

  if ((options.platform ?? process.platform) === "win32") {
    const canonicalDir = lockfileDir ?? resolveConfigDir(env, options);
    const canonical = joinLocalPath(options, canonicalDir, "lockfile.json");
    const legacyDir = lockfileDir ?? options.homeDir ?? os.homedir();
    const legacy =
      vellumEnv === PRODUCTION_ENVIRONMENT_NAME
        ? [".vellum.lock.json", ".vellum.lockfile.json"].map((name) =>
            joinLocalPath(options, legacyDir, name),
          )
        : [
            joinLocalPath(
              options,
              lockfileDir ?? resolveConfigDirPaths(env, options).at(-1)!,
              "lockfile.json",
            ),
          ];
    return [
      canonical,
      ...legacy.filter((candidate) => candidate !== canonical),
    ];
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
  return resolveConfigDirPaths(env, options)[0]!;
}

export function resolveConfigDirPaths(
  env: Record<string, string | undefined>,
  options: LocalPathOptions = {},
): string[] {
  if (options.configDirOverride) {
    return [options.configDirOverride];
  }
  const vellumEnv = resolveEnvironmentName(env, options);
  return resolveConfigHomes(env, options).map((home) =>
    joinLocalPath(options, home, environmentDirectoryName(vellumEnv, options)),
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
  return resolveDataDir(env, options);
}

export function resolveLogDir(
  env: Record<string, string | undefined>,
  options: LocalPathOptions = {},
): string {
  const root =
    (options.platform ?? process.platform) === "win32"
      ? resolveDataDir(env, options)
      : resolveConfigDir(env, options);
  return joinLocalPath(options, root, "logs");
}

export function resolveAssistantsDir(
  env: Record<string, string | undefined>,
  options: LocalPathOptions = {},
): string {
  return joinLocalPath(options, resolveDataDir(env, options), "assistants");
}

export function resolveInstanceDir(
  env: Record<string, string | undefined>,
  assistantId: string,
  options: LocalPathOptions = {},
): string {
  assertSafePathSegment(assistantId, "assistant ID", options);
  return joinLocalPath(
    options,
    resolveAssistantsDir(env, options),
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
