/**
 * Plugin bootstrap — runs every registered plugin's `init()` hook once during
 * daemon startup.
 *
 * The registry is populated before this runs: first-party defaults are
 * registered explicitly (step 1 below), user plugins are registered by the
 * user-plugin loader from the workspace `plugins/` directory, and hot-reload
 * registers at runtime. By the time {@link bootstrapPlugins} runs, the
 * registry has been fully populated for this boot cycle. This function:
 *
 * 1. Registers the canonical first-party default plugins via
 *    {@link registerDefaultPlugins}. Registration is idempotent so repeat
 *    calls (e.g. during integration tests) do not throw.
 * 2. Walks {@link getRegisteredPlugins} in registration order.
 * 3. For each plugin, consults `manifest.requiresFlag` against
 *    {@link isAssistantFeatureFlagEnabled}. If any listed flag is disabled,
 *    the plugin is skipped wholesale — no `init()`, no tool/route
 *    contributions, no entry in the shutdown hook, and the plugin is also
 *    dropped from the registry via {@link unregisterPlugin} so none of its
 *    hooks participate in the turn lifecycle. This is the primary mechanism for
 *    shipping experimental plugins behind a feature flag.
 * 4. Resolves the plugin's `manifest.requiresCredential` entries via the
 *    credential store helper ({@link getSecureKeyAsync}). In Docker mode
 *    that helper goes through the CES HTTP API transparently; in local mode
 *    it hits the encrypted file store / CES RPC backend.
 * 5. Validates the config block under `plugins.<name>` against
 *    `manifest.config` if the manifest supplies a parser-like validator
 *    (Zod schemas with `.parse()` are supported; anything else is passed
 *    through untouched).
 * 6. Creates `<workspaceDir>/plugins-data/<plugin>/` on demand for per-plugin
 *    writable state and exposes it via {@link PluginInitContext.pluginStorageDir}.
 * 7. For each surviving plugin, registers its contributed tools and routes
 *    into their global registries via {@link registerPluginTools} and
 *    {@link registerSkillRoute}. Contributions land BEFORE `init()` so
 *    the plugin's hook can observe a registry where its own model-visible
 *    surface is already wired — useful for plugins that want to attach
 *    metadata, warm caches, or otherwise interact with their own
 *    contributions during initialization.
 * 8. Awaits `plugin.init(ctx)` sequentially. An init failure is contained to
 *    the offending plugin: its already-registered tools and routes are rolled
 *    back, it is dropped from the registry, the failure is logged, and
 *    bootstrap continues with the remaining plugins. A single plugin's failure
 *    never deregisters plugins that already initialized — in particular the
 *    first-party defaults, which carry core turn behavior (memory retrieval,
 *    history repair, title generation) — so the daemon comes up with the
 *    failing plugin absent rather than blacking out the whole plugin layer.
 *
 * A single shutdown hook is registered via
 * {@link registerShutdownHook} that walks the plugin list in **reverse
 * registration order**. Only plugins that actually initialized (i.e. were
 * not skipped by the feature-flag gate) appear in that walk. For each such
 * plugin it first unregisters the contributed tools (so `onShutdown()`
 * observes a clean model-visible surface) and then awaits the optional
 * `onShutdown()`. Per-plugin shutdown failures are logged and swallowed —
 * the hook registry already swallows hook-level throws, but we log at the
 * plugin level so the plugin name is attributed.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import { getConfig } from "../config/loader.js";
import type { AssistantConfig } from "../config/schema.js";
import { HOOKS } from "../plugin-api/constants.js";
import { registerDefaultPlugins } from "../plugins/defaults/index.js";
import { buildExternalPlugin } from "../plugins/external-plugin-loader.js";
import {
  getRegisteredPlugin,
  getRegisteredPlugins,
  setRegisteredPlugin,
  unregisterPlugin,
} from "../plugins/registry.js";
import {
  type Plugin,
  PluginExecutionError,
  type PluginShutdownContext,
} from "../plugins/types.js";
import { loadUserPlugins } from "../plugins/user-loader.js";
import {
  registerSkillRoute,
  type SkillRouteHandle,
  unregisterSkillRoute,
} from "../runtime/skill-route-registry.js";
import { getSecureKeyAsync } from "../security/secure-keys.js";
import {
  registerPluginTools,
  unregisterPluginTools,
} from "../tools/registry.js";
import { getLogger } from "../util/logger.js";
import { getWorkspaceDir } from "../util/platform.js";
import { APP_VERSION } from "../version.js";
import { registerShutdownHook } from "./shutdown-registry.js";

const log = getLogger("plugins-bootstrap");

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
 * Read `config.plugins.<name>`. `AssistantConfigSchema` declares `plugins` as
 * an optional `Record<string, unknown>`, so the field is type-safe at the
 * schema boundary; per-plugin validation happens downstream via
 * `plugin.manifest.config` in `validatePluginConfig`.
 */
function getPluginConfigRaw(
  config: AssistantConfig,
  pluginName: string,
): unknown {
  return config.plugins?.[pluginName];
}

/**
 * Ensure `<workspaceDir>/plugins-data/<name>/` exists and return its absolute path.
 */
function ensurePluginStorageDir(pluginName: string): string {
  const dir = join(getWorkspaceDir(), "plugins-data", pluginName);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function getDisabledPluginFlag(
  plugin: Plugin,
  config: AssistantConfig,
): string | undefined {
  for (const flagKey of plugin.manifest.requiresFlag ?? []) {
    if (!isAssistantFeatureFlagEnabled(flagKey, config)) return flagKey;
  }
  return undefined;
}

/**
 * Bring the plugin layer up during daemon startup. Runs the full sequence in
 * the one order the rest of the system depends on:
 *
 * 1. Register the first-party defaults so their middleware composes innermost,
 *    ahead of any user plugins.
 * 2. Load user plugins from `<workspaceDir>/plugins/*`. A failing user plugin is
 *    logged and skipped; `loadUserPlugins()` closes the registration window
 *    when it returns, so the defaults must already be registered by then.
 * 3. Run every registered plugin's `init()` via {@link bootstrapPlugins}.
 *
 * Plugin bootstrap is wrapped so a failing plugin cannot block daemon startup —
 * the daemon comes up with degraded plugin functionality instead.
 */
export async function initializePlugins(): Promise<void> {
  registerDefaultPlugins();
  await loadUserPlugins();
  try {
    await bootstrapPlugins();
  } catch (err) {
    log.warn(
      { err },
      "Plugin bootstrap failed — continuing startup with degraded plugin functionality",
    );
  }
}

/**
 * Run every registered plugin's `init()` hook sequentially and install a
 * reverse-order shutdown hook. See the module docstring for full semantics.
 *
 * Returns once every plugin has been processed. A plugin whose `init()` throws
 * is rolled back, dropped from the registry, and logged; bootstrap continues
 * with the rest, so one failing plugin never blocks the others — or the
 * first-party defaults — from coming up.
 *
 * Must be called after any custom/third-party plugin registrations have run
 * and before the first conversation is served. First-party defaults are
 * registered inline via {@link registerDefaultPlugins}.
 */
export async function bootstrapPlugins(): Promise<void> {
  // Register first-party default plugins. Each default wraps one of the
  // assistant's canonical pipelines (`compaction`, `persistence`, ...) with a
  // passthrough so the pipeline shape is explicit at boot even when no
  // third-party plugins are loaded. Registration is idempotent via the
  // already-registered guard so repeated calls (e.g. during integration
  // tests) do not throw.
  registerDefaultPlugins();

  const plugins = getRegisteredPlugins();
  if (plugins.length === 0) {
    // No-op fast path. The default plugins normally populate the registry, so
    // this branch is primarily for tests that call
    // `resetPluginRegistryForTests()` and stub the default registration.
    log.debug("bootstrapPlugins: registry empty — skipping");
    return;
  }

  log.info({ count: plugins.length }, "bootstrapPlugins: initializing plugins");

  const assistantConfig = getConfig();

  // Plugins that passed `requiresFlag` gating and therefore need the full
  // init → contribute → shutdown lifecycle. Plugins skipped by the flag gate
  // are omitted from this list so the shutdown hook below never tears down
  // capabilities that were never wired up in the first place. Each entry
  // carries the opaque route handles returned by `registerSkillRoute` so
  // teardown can key on identity rather than regex-pattern text — two plugins
  // registering the same pattern would otherwise step on each other's routes
  // during shutdown, violating the "no traffic hits a plugin handler during
  // onShutdown" invariant.
  const activePlugins: ActivePlugin[] = [];

  // Shutdown context is identical for every plugin in this boot — construct
  // once and reuse across the per-plugin teardown and the normal shutdown
  // hook below. Only `assistantVersion` is exposed today; future additions
  // live on {@link PluginShutdownContext}.
  const shutdownContext: PluginShutdownContext = {
    assistantVersion: APP_VERSION,
  };

  for (const plugin of plugins) {
    const name = plugin.manifest.name;
    const disabledFlag = getDisabledPluginFlag(plugin, assistantConfig);
    if (disabledFlag !== undefined) {
      log.info(
        { plugin: name, flag: disabledFlag },
        `skipping plugin ${name}: feature flag ${disabledFlag} is disabled`,
      );
      unregisterPlugin(name);
      continue;
    }

    try {
      activePlugins.push(await initializePlugin(plugin, assistantConfig));
    } catch (err) {
      // Contain the failure to this plugin. `initializePlugin` already rolled
      // back its own partial tool/route contributions, so we just drop
      // it from the registry and move on. A single plugin's init failure must
      // never deregister the plugins that already came up — above all the
      // first-party defaults, which carry core turn behavior. The daemon stays
      // reachable with the failing plugin absent rather than losing the whole
      // plugin layer.
      unregisterPlugin(name);
      log.warn(
        { err, plugin: name },
        `plugin ${name} failed to initialize — skipping (continuing with remaining plugins)`,
      );
    }
  }

  // Shutdown hook — walks plugins in REVERSE registration order. We snapshot
  // only the plugins that actually initialized so later registrations (if
  // any) don't end up being torn down by this hook, and plugins skipped by
  // `requiresFlag` gating do not appear in the tear-down list. Subsequent
  // bootstraps (hot-reload) would register their own hook.
  //
  // For each plugin we:
  //   1. Unregister contributed HTTP routes so incoming requests stop hitting
  //      the plugin's handlers before its state is torn down.
  //   2. Unregister contributed tools so the model-visible tool surface is
  //      cleared before `onShutdown()` runs.
  //   3. Call `onShutdown()` (if defined) so the plugin can release resources
  //      (background tasks, timers, connections) with its tools and routes
  //      already removed.
  const shutdownSnapshot: ActivePlugin[] = [...activePlugins];
  registerShutdownHook("plugins", async (reason) => {
    for (let i = shutdownSnapshot.length - 1; i >= 0; i--) {
      await teardownPlugin(shutdownSnapshot[i]!, reason, shutdownContext);
    }
  });
}

/**
 * One plugin that made it through the full init + contribution phase. Holds
 * every opaque {@link SkillRouteHandle} issued by `registerSkillRoute` so
 * teardown can revoke exactly the routes this plugin contributed, even when
 * the regex pattern text collides with another owner's registration.
 */
interface ActivePlugin {
  readonly plugin: Plugin;
  readonly routeHandles: readonly SkillRouteHandle[];
}

async function initializePlugin(
  plugin: Plugin,
  assistantConfig: AssistantConfig,
): Promise<ActivePlugin> {
  const name = plugin.manifest.name;
  const routeHandles: SkillRouteHandle[] = [];
  let initCompleted = false;

  try {
    const credentials: Record<string, string> = {};
    for (const key of plugin.manifest.requiresCredential ?? []) {
      credentials[key] = await resolveCredentialOrThrow(name, key);
    }

    const config = validatePluginConfig(
      name,
      plugin.manifest.config,
      getPluginConfigRaw(assistantConfig, name),
    );

    const initContext = {
      config,
      credentials,
      logger: log.child({ plugin: name }),
      pluginStorageDir: ensurePluginStorageDir(name),
      assistantVersion: APP_VERSION,
    };

    if (plugin.tools && plugin.tools.length > 0) {
      try {
        const accepted = registerPluginTools(name, plugin.tools);
        log.info(
          { plugin: name, count: accepted.length },
          "plugin tools registered",
        );
      } catch (err) {
        throw new PluginExecutionError(
          `plugin ${name} tool registration failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
          name,
          { cause: err },
        );
      }
    }

    if (plugin.routes && plugin.routes.length > 0) {
      for (const route of plugin.routes) {
        routeHandles.push(registerSkillRoute(route));
      }
      log.info(
        { plugin: name, count: plugin.routes.length },
        "plugin routes registered",
      );
    }

    if (plugin.hooks?.[HOOKS.INIT]) {
      try {
        await plugin.hooks[HOOKS.INIT](initContext);
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
    initCompleted = true;

    log.info({ plugin: name }, "plugin initialized");
    return { plugin, routeHandles };
  } catch (err) {
    if (initCompleted) {
      await teardownPlugin({ plugin, routeHandles }, "bootstrap-failed", {
        assistantVersion: APP_VERSION,
      });
    } else {
      for (const handle of routeHandles) {
        unregisterSkillRoute(handle);
      }
      unregisterPluginTools(name);
    }
    throw err;
  }
}

/**
 * Tear down a single fully-initialized plugin: unregister routes, unregister
 * tools, then invoke `onShutdown()` if present. Every step swallows errors and
 * logs with plugin attribution so one bad plugin can't block teardown of the
 * rest.
 *
 * Shared between the normal shutdown hook and the bootstrap error path; both
 * consume plugins that already cleared every contribution step.
 */
async function teardownPlugin(
  active: ActivePlugin,
  reason: string,
  shutdownContext: PluginShutdownContext,
): Promise<void> {
  const { plugin, routeHandles } = active;
  const name = plugin.manifest.name;

  // Unregister model-visible surfaces before invoking `onShutdown()` so the
  // plugin's onShutdown hook observes a registry state where its tools and
  // routes are already gone. `unregisterPluginTools` is a no-op when the
  // plugin never contributed tools, so we don't need to guard on
  // `plugin.tools` here. Route unregistration keys on the opaque handles
  // retained at registration time — pattern text is not a stable key because
  // two owners can legitimately register the same regex.
  for (const handle of routeHandles) {
    try {
      unregisterSkillRoute(handle);
    } catch (err) {
      log.warn(
        { err, plugin: name },
        "plugin route unregister failed (continuing)",
      );
    }
  }

  try {
    unregisterPluginTools(name);
  } catch (err) {
    log.warn(
      { err, plugin: name, reason },
      "plugin tool unregister failed (continuing with remaining plugins)",
    );
  }

  if (plugin.hooks?.[HOOKS.SHUTDOWN]) {
    try {
      await plugin.hooks[HOOKS.SHUTDOWN](shutdownContext);
    } catch (err) {
      // Swallow — we want every plugin's shutdown to get a chance to run
      // even when an earlier one throws. The outer runShutdownHooks already
      // logs at hook level, but the plugin-name attribution here is what
      // operators read first.
      log.warn(
        { err, plugin: name, reason },
        "plugin shutdown hook failed (continuing with remaining plugins)",
      );
    }
  }
}

/** Rebuild a changed external plugin and swap it into the live registry. */
export async function reregisterExternalPlugin(
  pluginName: string,
): Promise<void> {
  const pluginDir = join(getWorkspaceDir(), "plugins", pluginName);
  const plugin = await buildExternalPlugin(pluginDir);
  if (plugin === undefined) return;

  if (plugin.manifest.name !== pluginName) {
    log.warn(
      { plugin: pluginName, manifestName: plugin.manifest.name, pluginDir },
      `external plugin reload skipped: directory name "${pluginName}" does not match manifest.name "${plugin.manifest.name}"`,
    );
    return;
  }

  const assistantConfig = getConfig();
  const disabledFlag = getDisabledPluginFlag(plugin, assistantConfig);
  if (disabledFlag !== undefined) {
    log.info(
      { plugin: pluginName, flag: disabledFlag },
      `external plugin reload skipped: feature flag ${disabledFlag} is disabled`,
    );
    return;
  }

  const existing = getRegisteredPlugin(pluginName);
  if (existing === undefined) {
    try {
      await initializePlugin(plugin, assistantConfig);
      setRegisteredPlugin(plugin);
      log.info({ plugin: pluginName }, "external plugin registered post-boot");
    } catch (err) {
      log.error(
        { err, plugin: pluginName },
        "external plugin post-boot registration failed",
      );
    }
    return;
  }

  try {
    unregisterPluginTools(pluginName);
  } catch (err) {
    log.warn(
      { err, plugin: pluginName },
      "external plugin reload: tool unregister failed (continuing)",
    );
  }

  setRegisteredPlugin(plugin);

  if (plugin.tools && plugin.tools.length > 0) {
    try {
      const accepted = registerPluginTools(pluginName, plugin.tools);
      log.info(
        { plugin: pluginName, count: accepted.length },
        "external plugin reloaded",
      );
    } catch (err) {
      log.error(
        { err, plugin: pluginName },
        "external plugin reload: tool registration failed",
      );
    }
    return;
  }

  log.info({ plugin: pluginName }, "external plugin reloaded");
}
