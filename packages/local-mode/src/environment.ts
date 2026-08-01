import { existsSync, readFileSync } from "node:fs";

import {
  joinLocalPath,
  resolveConfigHome,
  type LocalPathOptions,
} from "./paths";

const PRODUCTION_ENVIRONMENT_NAME = "production";

/**
 * Location of the persisted default-environment file, written by
 * `vellum env set`. It lives at a fixed, environment-agnostic path so it can
 * be read before the environment is known. Uses AppData on Windows and the
 * XDG config home on macOS and Linux.
 */
export function defaultEnvironmentFilePath(
  env: Record<string, string | undefined>,
  options: LocalPathOptions = {},
): string {
  return joinLocalPath(
    options,
    resolveConfigHome(env, options),
    "vellum",
    "environment",
  );
}

/**
 * Read the persisted default environment name, or `undefined` when no default
 * has been set (no file, empty file, or unreadable).
 */
export function readDefaultEnvironment(
  env: Record<string, string | undefined>,
  options: LocalPathOptions = {},
): string | undefined {
  const filePath = defaultEnvironmentFilePath(env, options);
  try {
    if (!existsSync(filePath)) return undefined;
    const content = readFileSync(filePath, "utf-8").trim();
    return content.length > 0 ? content : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the active environment name from a single source of truth so every
 * local-mode host — the CLI `client` server, the web app's Vite dev
 * middleware, and the Electron main process — reads and writes the same
 * lockfile and config directory.
 *
 * Resolution order matches the CLI's `resolveEnvironmentSource`:
 *   1. `VELLUM_ENVIRONMENT` (explicit override, also inherited by the
 *      hatch/retire child processes the CLI spawns)
 *   2. the persisted default written by `vellum env set`
 *   3. `production`
 *
 * Resolving the persisted default here — rather than only inspecting
 * `VELLUM_ENVIRONMENT` — is what keeps a host that did not go through the CLI's
 * resolver (the Electron main) pointed at the same environment the CLI uses.
 */
export function resolveEnvironmentName(
  env: Record<string, string | undefined>,
  options: LocalPathOptions = {},
): string {
  return (
    env.VELLUM_ENVIRONMENT?.trim() ||
    readDefaultEnvironment(env, options) ||
    PRODUCTION_ENVIRONMENT_NAME
  );
}
