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
 * 3. Validates the config block under `plugins.<name>` against
 *    `manifest.config` if the manifest supplies a parser-like validator
 *    (Zod schemas with `.parse()` are supported; anything else is passed
 *    through untouched).
 * 4. Creates a per-plugin writable data directory on demand and exposes it via
 *    {@link InitContext.pluginStorageDir}. For user plugins this is
 *    `<pluginDir>/data/`; for default plugins it is
 *    `<workspaceDir>/plugins-data/<plugin>/`.
 * 5. For each surviving plugin, registers its contributed tools and routes
 *    into their global registries via {@link registerPluginTools} and
 *    {@link registerSkillRoute}. Contributions land BEFORE `init()` so
 *    the plugin's hook can observe a registry where its own model-visible
 *    surface is already wired — useful for plugins that want to attach
 *    metadata, warm caches, or otherwise interact with their own
 *    contributions during initialization.
 * 6. Awaits `plugin.init(ctx)` sequentially. An init failure is contained to
 *    the offending plugin: its already-registered tools and routes are rolled
 *    back, it is dropped from the registry, the failure is logged, and
 *    bootstrap continues with the remaining plugins. A single plugin's failure
 *    never deregisters plugins that already initialized — in particular the
 *    first-party defaults, which carry core turn behavior (memory retrieval,
 *    history repair, title generation) — so the daemon comes up with the
 *    failing plugin absent rather than blacking out the whole plugin layer.
 *
 * Plugin `shutdown` hooks fire through the unified `runHook(HOOKS.SHUTDOWN, …)`
 * pipeline that the daemon shutdown handler runs — the same path every other
 * lifecycle hook uses; this module does not register a shutdown hook of its own.
 * Surfaces (tools/routes/injectors) are not unregistered at daemon shutdown:
 * the process is exiting, so that in-memory registry state is discarded anyway.
 * Surfaces are only torn down when a single plugin is rolled back after a failed
 * bring-up, via {@link teardownPlugin}.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { getConfig } from "../config/loader.js";
import type { AssistantConfig } from "../config/schema.js";
import { HOOKS } from "../plugin-api/constants.js";
import {
  getAllDefaultPlugins,
  registerDefaultPluginInjectors,
  registerDefaultPlugins,
} from "../plugins/defaults/index.js";
import { registerMemoryPersistenceHooks } from "../plugins/defaults/memory/persistence-lifecycle-seam.js";
import {
  registerPluginInjectors,
  unregisterPluginInjectors,
} from "../plugins/injector-registry.js";
import { getRegisteredPlugins, unregisterPlugin } from "../plugins/registry.js";
import {
  type Plugin,
  PluginExecutionError,
  type ShutdownContext,
} from "../plugins/types.js";
import { loadUserPlugins } from "../plugins/user-loader.js";
import {
  registerSkillRoute,
  type SkillRouteHandle,
  unregisterSkillRoute,
} from "../runtime/skill-route-registry.js";
import {
  registerPluginTools,
  unregisterPluginTools,
} from "../tools/registry.js";
import { getLogger } from "../util/logger.js";
import { getWorkspaceDir, getWorkspacePluginsDir } from "../util/platform.js";
import { APP_VERSION } from "../version.js";

const log = getLogger("plugins-bootstrap");

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
 * Run every registered plugin's `init()` hook sequentially. See the module
 * docstring for full lifecycle semantics (including how `shutdown` hooks fire).
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

  // Register the default plugins' runtime injectors up front — independent of
  // each plugin's disabled-state, exactly as `registerDefaultPlugins` does for
  // their hooks. The per-turn walker filters the injector union by
  // `isPluginDisabled` at read time, so a default plugin that is disabled at
  // boot (its init is skipped below by the `.disabled` sentinel `continue`)
  // still has its injectors in the registry and reappears on the next turn
  // after `assistant plugins enable <name>` — no restart required. Injector-only
  // defaults have no init/hooks, so without this their injectors would never
  // register while disabled.
  registerDefaultPluginInjectors();

  // Install the memory feature's persistence-lifecycle handlers into the
  // persistence seam up front, so the layer below memory can drive memory
  // side effects (message indexing) without importing memory internals.
  // Symmetric with the injector registration above. (Background-job handlers
  // are not registered here: the memory plugin registers its own directly in
  // its `init` hook, and the daemon registers the host's non-plugin handlers in
  // `lifecycle.ts`.)
  registerMemoryPersistenceHooks();

  // Combine the canonical default plugins with any plugins registered via
  // `registerPlugin` (test fixtures). In production, `getRegisteredPlugins`
  // returns empty — all user plugins go through the mtime cache. Defaults come
  // first so their hooks compose innermost.
  const defaultPlugins = getAllDefaultPlugins();
  const testPlugins = getRegisteredPlugins().filter(
    (p) => !defaultPlugins.some((d) => d.manifest.name === p.manifest.name),
  );
  const plugins = [...defaultPlugins, ...testPlugins];
  if (plugins.length === 0) {
    log.debug("bootstrapPlugins: no plugins — skipping");
    return;
  }

  log.info({ count: plugins.length }, "bootstrapPlugins: initializing plugins");

  const assistantConfig = getConfig();

  for (const plugin of plugins) {
    const name = plugin.manifest.name;

    // Check for the .disabled sentinel. Both default and user plugins
    // can be disabled by creating a `.disabled` file at
    // <workspace>/plugins/<manifest-name>/.disabled. For user plugins
    // this is the plugin's own directory; for default plugins (which
    // live in the source tree) the workspace directory acts as an
    // out-of-band kill switch — the operator creates a directory named
    // after the plugin's manifest name (e.g. `plugins/default-advisor/`)
    // and drops a `.disabled` file inside it. Runs before init so no
    // tools or routes from the disabled plugin are ever wired.
    //
    // We do NOT call `unregisterPlugin(name)` here. The plugin's hooks
    // stay in the hook registry and are filtered at read time by
    // `isPluginDisabled` in `getHooksFor`. This means `assistant plugins
    // enable <name>` takes effect on the next turn without a restart —
    // the hooks are already registered, they just need the sentinel
    // removed to be included.
    const disabledSentinelPath = join(
      getWorkspacePluginsDir(),
      name,
      ".disabled",
    );
    if (existsSync(disabledSentinelPath)) {
      log.info(
        { plugin: name, sentinel: disabledSentinelPath },
        `skipping plugin ${name}: disabled via .disabled sentinel`,
      );
      continue;
    }

    try {
      await initializePlugin(plugin, assistantConfig);
    } catch (err) {
      // Contain the failure to this plugin. `initializePlugin` already rolled
      // back its own partial tool/route contributions, so we just drop
      // its hooks from the hook registry and move on. A single plugin's init
      // failure must never deregister the plugins that already came up —
      // above all the first-party defaults, which carry core turn behavior.
      // The daemon stays reachable with the failing plugin absent rather than
      // losing the whole plugin layer.
      unregisterPlugin(name);
      log.warn(
        { err, plugin: name },
        `plugin ${name} failed to initialize — skipping (continuing with remaining plugins)`,
      );
    }
  }
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
    const config = validatePluginConfig(
      name,
      plugin.manifest.config,
      getPluginConfigRaw(assistantConfig, name),
    );

    const initContext = {
      config,
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

    if (plugin.injectors && plugin.injectors.length > 0) {
      registerPluginInjectors(name, plugin.injectors);
      log.info(
        { plugin: name, count: plugin.injectors.length },
        "plugin injectors registered",
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
      await teardownPlugin(
        { plugin, routeHandles },
        { assistantVersion: APP_VERSION, reason: "disable" },
      );
    } else {
      for (const handle of routeHandles) {
        unregisterSkillRoute(handle);
      }
      unregisterPluginTools(name);
      unregisterPluginInjectors(name);
    }
    throw err;
  }
}

/**
 * Unregister every initialized plugin's contributed routes and tools in reverse
 * registration order, clearing the model-visible surface before the shutdown
 * handler dispatches `shutdown` hooks via `runHook(HOOKS.SHUTDOWN, …)`. Reads
 * the snapshot captured by the most recent {@link bootstrapPlugins} run; a
 * no-op when no plugins initialized. Called by the daemon shutdown handler.
 */
/**
 * Tear down a single fully-initialized plugin: unregister its model-visible
 * surfaces (contributed HTTP routes — keyed by the opaque handles retained at
 * registration time, since pattern text is not a stable key when two owners
 * register the same regex — plus its tools and runtime injectors), then invoke
 * its optional `shutdown` hook with the tools/routes already gone. Every step
 * swallows errors and logs with plugin attribution so one bad plugin can't
 * block teardown.
 *
 * Used by the bootstrap-failure rollback path. The normal daemon shutdown path
 * does not unregister surfaces (the process is exiting, so that in-memory state
 * is discarded anyway); it only fires `shutdown` hooks through the unified
 * `runHook(HOOKS.SHUTDOWN, …)` pipeline.
 */
async function teardownPlugin(
  active: ActivePlugin,
  shutdownContext: ShutdownContext,
): Promise<void> {
  const { plugin, routeHandles } = active;
  const name = plugin.manifest.name;
  const { reason } = shutdownContext;

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

  unregisterPluginInjectors(name);

  if (plugin.hooks?.[HOOKS.SHUTDOWN]) {
    try {
      await plugin.hooks[HOOKS.SHUTDOWN](shutdownContext);
    } catch (err) {
      log.warn(
        { err, plugin: name, reason },
        "plugin shutdown hook failed (continuing with remaining plugins)",
      );
    }
  }
}
