/**
 * Plugin bootstrap — runs every registered plugin's `init()` hook once during
 * daemon startup.
 *
 * Plugins register themselves via side-effect imports elsewhere in the boot
 * sequence (first-party) or at runtime (hot-reload). By the time
 * {@link bootstrapPlugins} runs, the registry has been fully populated for
 * this boot cycle. This function:
 *
 * 1. Walks {@link getRegisteredPlugins} in registration order.
 * 2. For each plugin, resolves its `manifest.requiresCredential` entries via
 *    the credential store helper ({@link getSecureKeyAsync}). In Docker mode
 *    that helper goes through the CES HTTP API transparently; in local mode
 *    it hits the encrypted file store / CES RPC backend.
 * 3. Validates the config block under `plugins.<name>` against
 *    `manifest.config` if the manifest supplies a parser-like validator
 *    (Zod schemas with `.parse()` are supported; anything else is passed
 *    through untouched).
 * 4. Creates `~/.vellum/plugins-data/<plugin>/` on demand for per-plugin
 *    writable state and exposes it via {@link PluginInitContext.pluginStorageDir}.
 * 5. Awaits `plugin.init(ctx)` sequentially. One init failure surfaces as a
 *    {@link PluginExecutionError} naming the offending plugin and aborts
 *    bootstrap — later plugins' `init()` never runs and the daemon fails
 *    startup cleanly rather than coming up in a half-wired state.
 *
 * A single shutdown hook is registered via
 * {@link registerShutdownHook} that walks the plugin list in **reverse
 * registration order** and awaits each plugin's optional `onShutdown()`.
 * Per-plugin shutdown failures are logged and swallowed — the hook registry
 * already swallows hook-level throws, but we log at the plugin level so the
 * plugin name is attributed.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { AssistantConfig } from "../config/schema.js";
import { registerDefaultOverflowReducePlugin } from "../plugins/defaults/overflow-reduce.js";
import {
  ASSISTANT_API_VERSIONS,
  getRegisteredPlugins,
} from "../plugins/registry.js";
import {
  type Plugin,
  PluginExecutionError,
  type PluginInitContext,
} from "../plugins/types.js";
import { getSecureKeyAsync } from "../security/secure-keys.js";
import { getLogger } from "../util/logger.js";
import { vellumRoot } from "../util/platform.js";
import { registerShutdownHook } from "./shutdown-registry.js";

const log = getLogger("plugins-bootstrap");

/**
 * Minimal context required to bootstrap the plugin layer. Kept intentionally
 * small so the call site in `lifecycle.ts` can construct it from whatever
 * state is already available at that point in startup.
 */
export interface DaemonContext {
  config: AssistantConfig;
  assistantVersion: string;
}

/**
 * Resolve one credential value. Returns the raw secret string or throws a
 * {@link PluginExecutionError} tagged with the plugin name so the caller can
 * fail startup with clear attribution.
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
 * Validate a plugin config block. If the manifest supplies a parser-like
 * validator (Zod schemas expose `.parse()`), use it. Otherwise pass the
 * config through untouched.
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
 * Read `config.plugins.<name>` defensively. The AssistantConfig schema does
 * not (yet) declare a `plugins` block, so accessing it goes through
 * `unknown` casts rather than compile-time field access.
 */
function getPluginConfigRaw(
  config: AssistantConfig,
  pluginName: string,
): unknown {
  const plugins = (config as { plugins?: Record<string, unknown> }).plugins;
  if (plugins == null || typeof plugins !== "object") return undefined;
  return plugins[pluginName];
}

/**
 * Ensure `~/.vellum/plugins-data/<name>/` exists and return its absolute path.
 */
function ensurePluginStorageDir(pluginName: string): string {
  const dir = join(vellumRoot(), "plugins-data", pluginName);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Register every first-party default plugin in the canonical order the
 * registry should compose them. Call once at daemon startup immediately
 * before {@link bootstrapPlugins} so the registry is populated before
 * bootstrap walks it.
 *
 * Kept separate from `bootstrapPlugins` so the bootstrap-plumbing tests can
 * continue to assert against a clean, empty-registry baseline without being
 * coupled to the specific set of first-party plugins the daemon ships with
 * today. Middleware composition order follows registration order — defaults
 * register first so they run innermost and any externally-registered plugin
 * wrapping the same slot observes the historical behavior as the terminal
 * step.
 */
export function registerFirstPartyDefaults(): void {
  registerDefaultOverflowReducePlugin();
}

/**
 * Run every registered plugin's `init()` hook sequentially and install a
 * reverse-order shutdown hook. See the module docstring for full semantics.
 *
 * Returns once every plugin has finished initialising successfully. Throws a
 * {@link PluginExecutionError} on the first failure — the error message names
 * the offending plugin so operators see which `init()` bailed.
 *
 * Must be called after the registry is fully populated by this boot cycle
 * (i.e. after any static side-effect imports of first-party plugins have
 * run) and before the first conversation is served.
 */
export async function bootstrapPlugins(ctx: DaemonContext): Promise<void> {
  const plugins = getRegisteredPlugins();
  if (plugins.length === 0) {
    // No-op fast path — the registry is empty (no first-party plugins have
    // been wired yet in this PR). Emit a debug log so the call site is
    // observable in startup traces and return.
    log.debug("bootstrapPlugins: registry empty — skipping");
    return;
  }

  log.info({ count: plugins.length }, "bootstrapPlugins: initializing plugins");

  for (const plugin of plugins) {
    const name = plugin.manifest.name;

    // Credential resolution — gather every entry in `requiresCredential`
    // before calling `init()` so the plugin receives a fully-populated map.
    const credentials: Record<string, string> = {};
    const required = plugin.manifest.requiresCredential ?? [];
    for (const key of required) {
      credentials[key] = await resolveCredentialOrThrow(name, key);
    }

    // Per-plugin config block, validated against the manifest's parser-like
    // validator when one is declared.
    const rawConfig = getPluginConfigRaw(ctx.config, name);
    const config = validatePluginConfig(
      name,
      plugin.manifest.config,
      rawConfig,
    );

    // Per-plugin writable data directory. Created lazily during bootstrap
    // rather than at registration time so the side effect is isolated to
    // the boot path.
    const pluginStorageDir = ensurePluginStorageDir(name);

    const initContext: PluginInitContext = {
      config,
      credentials,
      logger: log.child({ plugin: name }),
      pluginStorageDir,
      assistantVersion: ctx.assistantVersion,
      apiVersions: ASSISTANT_API_VERSIONS,
    };

    if (plugin.init) {
      try {
        await plugin.init(initContext);
      } catch (err) {
        throw new PluginExecutionError(
          `plugin ${name} init() failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
          name,
          { cause: err },
        );
      }
    }

    log.info({ plugin: name }, "plugin initialized");
  }

  // Shutdown hook — walks plugins in REVERSE registration order. We snapshot
  // the current plugin list so later registrations (if any) don't end up
  // being torn down by this hook; subsequent bootstraps (hot-reload) would
  // register their own hook.
  const shutdownSnapshot: Plugin[] = [...plugins];
  registerShutdownHook("plugins", async (reason) => {
    for (let i = shutdownSnapshot.length - 1; i >= 0; i--) {
      const plugin = shutdownSnapshot[i]!;
      const name = plugin.manifest.name;
      if (!plugin.onShutdown) continue;
      try {
        await plugin.onShutdown();
      } catch (err) {
        // Swallow — we want every plugin's onShutdown to get a chance to
        // run even when an earlier one throws. The outer runShutdownHooks
        // already logs at hook level, but the plugin-name attribution here
        // is what operators read first.
        log.warn(
          { err, plugin: name, reason },
          "plugin onShutdown failed (continuing with remaining plugins)",
        );
      }
    }
  });
}
