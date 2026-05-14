/**
 * Construction of the {@link PluginInitContext} a plugin's `init()` hook
 * receives.
 *
 * Lives in the shared `plugins/` layer because both surfaces that invoke
 * `init()` need the same context shape:
 *
 *   - The daemon's boot-time pass in `external-plugins-bootstrap.ts`
 *     calls `init()` against the live `DaemonContext` once per registered
 *     plugin.
 *   - The CLI's `assistant plugins install` command runs `init()`
 *     in-process immediately after writing files to disk so plugin
 *     authors can ship one-time setup (DB migrations, key probing, etc.)
 *     without forcing users to restart the daemon.
 *
 * The four building blocks (credential resolution, config validation,
 * storage-dir ensure, raw-config extraction) stay private to this
 * module; consumers should call {@link buildPluginInitContext} and let
 * it orchestrate the four steps in the documented order. Keeping the
 * primitives private means a new caller cannot accidentally skip
 * credential resolution or config validation while still building a
 * structurally-correct context.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type pino from "pino";

import type { AssistantConfig } from "../config/schema.js";
import type { PluginInitContext } from "../plugin-api/types.js";
import { getSecureKeyAsync } from "../security/secure-keys.js";
import { getWorkspaceDir } from "../util/platform.js";
import { APP_VERSION } from "../version.js";
import { type Plugin, PluginExecutionError } from "./types.js";

/**
 * Resolve one credential value via the secure-key store. Throws a
 * {@link PluginExecutionError} tagged with the plugin name when the store
 * returns no value so the caller can attribute failures.
 */
async function resolveCredentialOrThrow(
  pluginName: string,
  credentialKey: string,
): Promise<string> {
  const value = await getSecureKeyAsync(credentialKey);
  if (value === undefined || value === "") {
    throw new PluginExecutionError(
      `plugin ${pluginName} requires credential "${credentialKey}" but the credential store returned no value`,
      pluginName,
    );
  }
  return value;
}

/**
 * Validate a plugin config block against the manifest's parser-like
 * validator (Zod schemas expose `.parse()`). Passes the raw config
 * through untouched when no validator is declared.
 */
function validatePluginConfig(
  pluginName: string,
  validator: unknown,
  raw: unknown,
): unknown {
  if (
    validator != null &&
    typeof validator === "object" &&
    "parse" in validator &&
    typeof (validator as { parse: unknown }).parse === "function"
  ) {
    try {
      return (validator as { parse: (input: unknown) => unknown }).parse(raw);
    } catch (err) {
      throw new PluginExecutionError(
        `plugin ${pluginName} config validation failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
        pluginName,
        { cause: err },
      );
    }
  }
  return raw;
}

/**
 * Read `config.plugins.<name>`. `AssistantConfigSchema` declares `plugins`
 * as an optional `Record<string, unknown>`, so the field is type-safe at
 * the schema boundary; per-plugin validation happens downstream via
 * `plugin.manifest.config` in {@link validatePluginConfig}.
 */
function getPluginConfigRaw(
  config: AssistantConfig,
  pluginName: string,
): unknown {
  return config.plugins?.[pluginName];
}

/**
 * Ensure `<workspaceDir>/plugins-data/<name>/` exists and return its
 * absolute path. Created lazily here (rather than at plugin registration
 * time) so the filesystem side effect is isolated to init-context
 * construction.
 */
function ensurePluginStorageDir(pluginName: string): string {
  const dir = join(getWorkspaceDir(), "plugins-data", pluginName);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Options for {@link buildPluginInitContext}.
 */
export interface BuildPluginInitContextOptions {
  /**
   * Overrides the `assistantVersion` field embedded in the returned
   * context. Production callers either pass nothing (defaulting to
   * {@link APP_VERSION}) or thread a daemon-context value through for
   * test reproducibility.
   */
  readonly assistantVersion?: string;
}

/**
 * Construct the {@link PluginInitContext} a plugin's `init()` hook
 * receives. Resolves required credentials, validates the per-plugin
 * config block, ensures the writable storage directory exists, and binds
 * a child logger scoped to `{ plugin: <name> }`.
 *
 * Used by both the daemon's boot-time plugin pass and the CLI install
 * action so plugin authors reason about one context shape regardless of
 * which surface invokes `init()`.
 *
 * @throws PluginExecutionError if any `manifest.requiresCredential` entry
 * is missing from the credential store, or if `manifest.config` rejects
 * the raw config block.
 */
export async function buildPluginInitContext(
  plugin: Plugin,
  config: AssistantConfig,
  parentLogger: pino.Logger,
  opts: BuildPluginInitContextOptions = {},
): Promise<PluginInitContext> {
  const name = plugin.manifest.name;

  // Credential resolution — gather every entry in `requiresCredential`
  // before calling `init()` so the plugin receives a fully-populated
  // map. A missing credential throws and prevents the partial context
  // from reaching `init()`.
  const credentials: Record<string, string> = {};
  for (const key of plugin.manifest.requiresCredential ?? []) {
    credentials[key] = await resolveCredentialOrThrow(name, key);
  }

  // Per-plugin config block, validated against the manifest's
  // parser-like validator when one is declared.
  const rawConfig = getPluginConfigRaw(config, name);
  const pluginConfig = validatePluginConfig(
    name,
    plugin.manifest.config,
    rawConfig,
  );

  // Per-plugin writable data directory. Lazy mkdir keeps the filesystem
  // side effect isolated to context construction.
  const pluginStorageDir = ensurePluginStorageDir(name);

  return {
    config: pluginConfig,
    credentials,
    logger: parentLogger.child({ plugin: name }),
    pluginStorageDir,
    assistantVersion: opts.assistantVersion ?? APP_VERSION,
  };
}
