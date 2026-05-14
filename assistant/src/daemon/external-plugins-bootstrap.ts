/**
 * Plugin bootstrap — runs every registered plugin's `init()` hook once during
 * daemon startup.
 *
 * Plugins register themselves via side-effect imports elsewhere in the boot
 * sequence (first-party) or at runtime (hot-reload). By the time
 * {@link bootstrapPlugins} runs, the registry has been fully populated for
 * this boot cycle. This function:
 *
 * 1. Registers the canonical first-party default plugins via
 *    {@link registerDefaultPlugins} (one per pipeline). Registration is
 *    idempotent so repeat calls (e.g. during integration tests) do not throw.
 * 2. Walks {@link getRegisteredPlugins} in registration order.
 * 3. For each plugin, consults `manifest.requiresFlag` against
 *    {@link isAssistantFeatureFlagEnabled}. If any listed flag is disabled,
 *    the plugin is skipped wholesale — no `init()`, no tool/route/skill
 *    contributions, no entry in the shutdown hook, and the plugin is also
 *    dropped from the registry via {@link unregisterPlugin} so its middleware
 *    and injectors stop participating in pipeline runs and system-prompt
 *    assembly. This is the primary mechanism for shipping experimental
 *    plugins behind a feature flag.
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
 * 7. Awaits `plugin.init(ctx)` sequentially. One init failure surfaces as a
 *    {@link PluginExecutionError} naming the offending plugin and aborts
 *    bootstrap — later plugins' `init()` never runs and the daemon fails
 *    startup cleanly rather than coming up in a half-wired state.
 * 8. After a plugin's `init()` succeeds, registers any tools declared on
 *    `plugin.tools` with the global tool registry via
 *    {@link registerPluginTools}. Tool contributions land after `init()` so
 *    a plugin that fails mid-init never leaves partial tool registrations
 *    behind.
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

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import type { AssistantConfig } from "../config/schema.js";
import { registerDefaultPlugins } from "../plugins/defaults/index.js";
import { loadExternalPlugin } from "../plugins/external-plugin-loader.js";
import {
  registerPluginSkills,
  unregisterPluginSkills,
} from "../plugins/plugin-skill-contributions.js";
import {
  getRegisteredPlugins,
  unregisterPlugin,
} from "../plugins/registry.js";
import {
  type Plugin,
  PluginExecutionError,
  type PluginInitContext,
  type PluginShutdownContext,
  type PluginSkillRegistration,
} from "../plugins/types.js";
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
import {
  getWorkspaceDir,
  getWorkspacePluginsDir,
} from "../util/platform.js";
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
 * Run every registered plugin's `init()` hook sequentially and install a
 * reverse-order shutdown hook. See the module docstring for full semantics.
 *
 * Returns once every plugin has finished initialising successfully. Throws a
 * {@link PluginExecutionError} on the first failure — the error message names
 * the offending plugin so operators see which `init()` bailed.
 *
 * Must be called after any custom/third-party plugin registrations have run
 * and before the first conversation is served. First-party defaults are
 * registered inline via {@link registerDefaultPlugins}.
 */
export async function bootstrapPlugins(ctx: DaemonContext): Promise<void> {
  // Register first-party default plugins. Each default wraps one of the
  // assistant's canonical pipelines (`toolExecute`, `llmCall`, ...) with a
  // passthrough so the pipeline shape is explicit at boot even when no
  // third-party plugins are loaded. Registration is idempotent via the
  // already-registered guard so repeated calls (e.g. during integration
  // tests) do not throw.
  registerDefaultPlugins();

  const plugins = getRegisteredPlugins();
  if (plugins.length === 0) {
    // No-op fast path. The default injectors normally populate the registry,
    // so this branch is primarily for tests that call
    // `resetPluginRegistryForTests()` and stub the default registration.
    log.debug("bootstrapPlugins: registry empty — skipping");
    return;
  }

  log.info({ count: plugins.length }, "bootstrapPlugins: initializing plugins");

  // Plugins that passed `requiresFlag` gating and therefore need the full
  // init → contribute → shutdown lifecycle. Local to this function: the
  // post-boot watcher path (installPluginPostBoot) does NOT add to this list,
  // so post-boot installs are deliberately excluded from the boot shutdown
  // hook. Plugins that need teardown when the daemon shuts down should
  // register their own hook via `registerShutdownHook` from inside `init()`.
  const activePlugins: ActivePlugin[] = [];

  // Shutdown context is identical for every plugin in this boot — construct
  // once and reuse across the bootstrap-failure rollback path AND the
  // shutdown hook registered below. Only `assistantVersion` is exposed today;
  // future additions live on {@link PluginShutdownContext}.
  const shutdownContext: PluginShutdownContext = {
    assistantVersion: ctx.assistantVersion,
  };

  // If one plugin's init or contribution phase throws, tear down every
  // previously-initialized plugin (in reverse registration order) before
  // re-throwing. Without this, a mid-loop failure would leave earlier plugins
  // with live tools/routes/skills and no `onShutdown()` call — the shutdown
  // hook is only registered once the loop completes successfully.
  async function teardownPartialInit(): Promise<void> {
    for (let i = activePlugins.length - 1; i >= 0; i--) {
      const active = activePlugins[i]!;
      await teardownPlugin(active, "bootstrap-failed", shutdownContext);
      unregisterPlugin(active.plugin.manifest.name);
    }
  }

  for (const plugin of plugins) {
    let active: ActivePlugin | null;
    try {
      active = await installPluginInner(plugin, ctx, shutdownContext);
    } catch (err) {
      await teardownPartialInit();
      throw err;
    }
    if (active) activePlugins.push(active);
  }

  registerShutdownHook("plugins", async (reason) => {
    for (let i = activePlugins.length - 1; i >= 0; i--) {
      await teardownPlugin(activePlugins[i]!, reason, shutdownContext);
    }
  });
}

/**
 * Install a plugin discovered AFTER bootstrap — driven by the
 * {@link PluginSourceWatcher} when a user runs `assistant plugins install
 * <name>` against a running daemon. Same install pipeline as the boot path
 * (load → feature-flag gate → credentials → config → init → tool/route/skill
 * registration), just triggered by an fs event instead of the static boot
 * loop.
 *
 * Idempotent — no-op if the plugin is already in the in-memory registry.
 * Failures are caught and logged here rather than propagated, because the
 * watcher's debounce callback has no meaningful place to surface errors:
 * the user installed via CLI and is not awaiting daemon-side completion. A
 * failed install leaves the plugin out of the registry; the user can fix
 * the plugin and retry via the same CLI command.
 *
 * Post-boot installs are NOT registered with the boot shutdown hook. A
 * plugin installed at runtime that needs teardown when the daemon shuts
 * down should call {@link registerShutdownHook} from within its `init()`.
 * Keeping the boot hook closed over a snapshot list (not a live list) keeps
 * the shutdown ordering invariants of the boot path simple and avoids a
 * post-boot install racing with shutdown.
 *
 * NOTE: handles ONLY the external-plugin framework path (a directory with
 * `package.json` and no `register.{ts,js}`). Legacy `register.{ts,js}`
 * plugins still require daemon restart — they self-register via side-effect
 * import at module-evaluation time, which is incompatible with the
 * "register-via-load, then init" sequence used here. The watcher skips
 * legacy plugin directories with an info-level log.
 */
export async function installPluginPostBoot(
  pluginName: string,
  ctx: DaemonContext,
): Promise<void> {
  // Idempotency guard — the watcher debouncer suppresses repeat events
  // within a 500ms window, but does NOT serialize across the load+init
  // window. A second event arriving during a long `loadExternalPlugin`
  // (slow `import()`) must not re-enter.
  if (
    getRegisteredPlugins().some((p) => p.manifest.name === pluginName)
  ) {
    return;
  }

  const pluginDir = join(getWorkspacePluginsDir(), pluginName);

  // Branch detection mirrors `user-loader.ts`: legacy `register.{ts,js}`
  // plugins register themselves at import time and cannot be loaded by the
  // external loader here. Surface the limitation explicitly so users
  // updating a legacy plugin know they need to restart the daemon.
  if (
    existsSync(join(pluginDir, "register.ts")) ||
    existsSync(join(pluginDir, "register.js"))
  ) {
    log.info(
      { plugin: pluginName },
      "post-boot install skipped: legacy `register.{ts,js}` plugin — daemon restart required",
    );
    return;
  }
  if (!existsSync(join(pluginDir, "package.json"))) {
    // Watcher fires for partial writes too (CLI may still be writing files).
    // The next debounced fire will catch the complete state.
    log.debug(
      { plugin: pluginName },
      "post-boot install skipped: package.json missing (partial write?)",
    );
    return;
  }

  try {
    // `loadExternalPlugin` handles import timeout, surface validation, and
    // registry insertion. On success, the plugin is in the registry with
    // its hooks/tools/routes/skills attached but `init()` has NOT been
    // called — that's what installPluginInner does below.
    await loadExternalPlugin(pluginDir);
  } catch (err) {
    log.warn(
      { err, plugin: pluginName, pluginDir },
      "post-boot plugin load failed",
    );
    return;
  }

  // The plugin's `manifest.name` may differ from the directory name. We key
  // the watcher by dir name; `loadExternalPlugin` keys the registry by
  // `manifest.name`. A mismatch is not necessarily an error (just a debug
  // log), but it does mean we can't safely init from here — the dir name
  // is the only handle we have through the watcher boundary.
  const plugin = getRegisteredPlugins().find(
    (p) => p.manifest.name === pluginName,
  );
  if (!plugin) {
    log.debug(
      { plugin: pluginName, pluginDir },
      "post-boot load completed but no registered plugin matches the directory name — init skipped",
    );
    return;
  }

  const shutdownContext: PluginShutdownContext = {
    assistantVersion: ctx.assistantVersion,
  };

  try {
    const active = await installPluginInner(plugin, ctx, shutdownContext);
    if (active) {
      log.info({ plugin: pluginName }, "post-boot plugin installed");
    }
  } catch (err) {
    // `installPluginInner` already unregistered the plugin on failure. We
    // catch here so the watcher debouncer's promise does not surface as an
    // unhandled rejection at the runtime boundary.
    log.warn(
      { err, plugin: pluginName },
      "post-boot plugin install failed",
    );
  }
}

/**
 * Per-plugin install body: feature-flag gate, credential resolution, config
 * validation, init(), then tool/route/skill registration. Returns the
 * resulting {@link ActivePlugin} entry on success, null if the plugin was
 * skipped by the feature-flag gate (and unregistered as a side effect), or
 * throws if any step fails. Callers decide rollback policy:
 *
 * - Boot path: a throw triggers `teardownPartialInit()` which tears down
 *   every previously-installed plugin in this boot.
 * - Post-boot path: a throw is caught and logged — the failed plugin is
 *   already unregistered, and previously-installed plugins keep running.
 *
 * On failure, this function ALWAYS unregisters the failing plugin (whether
 * init completed or not), so callers do not need to do that cleanup.
 */
async function installPluginInner(
  plugin: Plugin,
  ctx: DaemonContext,
  shutdownContext: PluginShutdownContext,
): Promise<ActivePlugin | null> {
  const name = plugin.manifest.name;

  // Feature-flag gating — if any key in `manifest.requiresFlag` is
  // disabled, skip this plugin entirely. Skipping means: no `init()`, no
  // tool / route / skill contributions, and no entry in `activePlugins`. A
  // later boot with the flag flipped ON picks up the plugin cleanly.
  const requiredFlags = plugin.manifest.requiresFlag ?? [];
  for (const flagKey of requiredFlags) {
    if (!isAssistantFeatureFlagEnabled(flagKey, ctx.config)) {
      log.info(
        { plugin: name, flag: flagKey },
        `skipping plugin ${name}: feature flag ${flagKey} is disabled`,
      );
      // Drop the plugin from the registry too. `registerPlugin()` added it at
      // import time, and `getMiddlewaresFor()` / `getInjectors()` iterate over
      // every registered entry — without this call, the gated plugin's
      // middleware and injectors would still participate in every pipeline
      // run and system-prompt assembly despite `init()` never firing.
      unregisterPlugin(name);
      return null;
    }
  }

  // Collected as routes are accepted so the catch block can revoke exactly
  // the routes this plugin contributed if a later contribution step throws.
  const routeHandles: SkillRouteHandle[] = [];

  // Tracks whether `plugin.init()` ran to completion (or the plugin has no
  // init at all). The catch block consults this to decide whether the
  // currently-failing plugin's `onShutdown()` may run: onShutdown is paired
  // with init, so a plugin that never completed init never set up the state
  // onShutdown is meant to tear down. Calling onShutdown in that case would
  // surprise plugin authors (their teardown runs against an uninitialized
  // self) and breaks the documented lifecycle contract.
  let initCompleted = false;

  try {
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

    // Per-plugin writable data directory. Created lazily during install
    // rather than at registration time so the side effect is isolated to
    // the install path.
    const pluginStorageDir = ensurePluginStorageDir(name);

    const initContext: PluginInitContext = {
      config,
      credentials,
      logger: log.child({ plugin: name }),
      pluginStorageDir,
      assistantVersion: ctx.assistantVersion,
    };

    if (plugin.hooks?.init) {
      try {
        await plugin.hooks.init(initContext);
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
    // Reached when init() succeeded or the plugin has no init hook. The
    // catch block reads this to decide whether onShutdown may run.
    initCompleted = true;

    // After init succeeds, wire in the plugin's model-visible capabilities.
    // Tool contributions register only after `init()` succeeds so a plugin
    // that fails mid-init never leaves partially-wired tools behind. Tool
    // registration failures are wrapped in a PluginExecutionError so the
    // offending plugin name surfaces in the abort — matching the strict-fail
    // semantics of `init()` errors.
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

    // Route contributions — registered after init() succeeds so a plugin
    // that fails to initialize never exposes a half-wired HTTP surface.
    // Mirrors the skill-route registry shape. Retain every returned handle
    // so the teardown path unregisters by identity rather than pattern text —
    // two plugins (or a plugin and a skill) that happen to register the same
    // regex must not evict each other's routes during shutdown.
    if (plugin.routes && plugin.routes.length > 0) {
      for (const route of plugin.routes) {
        routeHandles.push(registerSkillRoute(route));
      }
      log.info(
        { plugin: name, count: plugin.routes.length },
        "plugin routes registered",
      );
    }

    // Skills register into the in-memory plugin-skill catalog so `skill_load`
    // / `skill_execute` can resolve them alongside filesystem skills. A
    // registration failure aborts the install with the plugin named — same
    // strict-fail posture as init() throws.
    if (plugin.skills && plugin.skills.length > 0) {
      try {
        // `plugin.skills` is typed as `PluginSkillRegistration[]` at the
        // Plugin interface — the type assertion here is a narrowing from
        // that generic slot into the concrete shape the registry expects.
        registerPluginSkills(
          name,
          plugin.skills as readonly PluginSkillRegistration[],
        );
      } catch (err) {
        throw new PluginExecutionError(
          `plugin ${name} skill registration failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
          name,
          { cause: err },
        );
      }
    }

    log.info({ plugin: name }, "plugin initialized");
    return { plugin, routeHandles };
  } catch (err) {
    // Branching on `initCompleted` keeps the init/onShutdown pairing intact.
    // When init succeeded but a later contribution step (tools, routes,
    // skills) threw, the plugin has live init-side state that `onShutdown()`
    // is responsible for cleaning up, so the full teardownPlugin path runs.
    // When init itself failed (or a step before init — credential resolution,
    // config validation — threw), onShutdown must not run: calling it would
    // invoke the plugin's teardown against an uninitialized self, violating
    // the lifecycle contract documented on `Plugin.onShutdown`. In the
    // init-failed case there is also nothing to unregister — tools, routes,
    // and skills are all registered after init — so just drop the plugin
    // from the registry (idempotent if already removed).
    if (initCompleted) {
      await teardownPlugin(
        { plugin, routeHandles },
        "install-failed",
        shutdownContext,
      );
    }
    unregisterPlugin(name);
    throw err;
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

/**
 * Tear down a single fully-initialized plugin: unregister routes, unregister
 * tools, invoke `onShutdown()` if present, then unregister skills. Every step
 * swallows errors and logs with plugin attribution so one bad plugin can't
 * block teardown of the rest.
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

  if (plugin.hooks?.shutdown) {
    try {
      await plugin.hooks.shutdown(shutdownContext);
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

  if (plugin.skills && plugin.skills.length > 0) {
    try {
      unregisterPluginSkills(name);
    } catch (err) {
      log.warn(
        { err, plugin: name, reason },
        "plugin skill unregistration failed (continuing with remaining plugins)",
      );
    }
  }
}
