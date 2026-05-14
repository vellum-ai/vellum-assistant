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
 * 7. For each surviving plugin, registers its contributed tools, routes,
 *    and skills into their global registries via
 *    {@link registerPluginTools}, {@link registerSkillRoute}, and
 *    {@link registerPluginSkills}. Contributions land BEFORE `init()` so
 *    the plugin's hook can observe a registry where its own model-visible
 *    surface is already wired — useful for plugins that want to attach
 *    metadata, warm caches, or otherwise interact with their own
 *    contributions during initialization.
 * 8. Awaits `plugin.init(ctx)` sequentially. An init failure surfaces as a
 *    {@link PluginExecutionError} naming the offending plugin and aborts
 *    bootstrap — later plugins' `init()` never runs and the daemon fails
 *    startup cleanly rather than coming up in a half-wired state. The
 *    failing plugin's already-registered tools, routes, and skills are
 *    rolled back before the error propagates so the registry never
 *    carries state contributed by a plugin that never finished
 *    initializing.
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
import type { AssistantConfig } from "../config/schema.js";
import { HOOKS } from "../plugin-api/constants.js";
import { registerDefaultPlugins } from "../plugins/defaults/index.js";
import { buildExternalPlugin } from "../plugins/external-plugin-loader.js";
import {
  registerPluginSkills,
  unregisterPluginSkills,
} from "../plugins/plugin-skill-contributions.js";
import {
  getRegisteredPlugin,
  getRegisteredPlugins,
  registerPluginPostBoot,
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
import { getWorkspaceDir } from "../util/platform.js";
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
  // init → contribute → shutdown lifecycle. Plugins skipped by the flag gate
  // are omitted from this list so the shutdown hook below never tears down
  // capabilities that were never wired up in the first place. Each entry
  // carries the opaque route handles returned by `registerSkillRoute` so
  // teardown can key on identity rather than regex-pattern text — two plugins
  // registering the same pattern would otherwise step on each other's routes
  // during shutdown, violating the "no traffic hits a plugin handler during
  // onShutdown" invariant.
  const activePlugins: ActivePlugin[] = [];

  // Tear down a plugin's contributions AND remove it from the registry. The
  // two steps always move together on the bootstrap failure path: the former
  // clears tools/routes/skills (so they stop appearing to the model/HTTP
  // server), the latter drops the plugin's entry from the Map (so
  // `getMiddlewaresFor` / `getInjectors` don't re-enter an uninitialized
  // plugin on the next pipeline invocation).
  // Shutdown context is identical for every plugin in this boot — construct
  // once and reuse across the bootstrap-failure rollback and the normal
  // shutdown hook below. Only `assistantVersion` is exposed today; future
  // additions live on {@link PluginShutdownContext}.
  const shutdownContext: PluginShutdownContext = {
    assistantVersion: ctx.assistantVersion,
  };

  async function rollbackPlugin(active: ActivePlugin): Promise<void> {
    await teardownPlugin(active, "bootstrap-failed", shutdownContext);
    unregisterPlugin(active.plugin.manifest.name);
  }

  // If one plugin's init or contribution phase throws, tear down any plugins
  // that already fully initialized (in reverse registration order) before
  // re-throwing. Without this, a mid-loop failure would leave earlier plugins
  // with live tools/routes/skills and no `onShutdown()` call — the shutdown
  // hook is only registered once the loop completes successfully.
  async function teardownPartialInit(): Promise<void> {
    for (let i = activePlugins.length - 1; i >= 0; i--) {
      await rollbackPlugin(activePlugins[i]!);
    }
  }

  for (const plugin of plugins) {
    const name = plugin.manifest.name;

    // Feature-flag gating — if any key in `manifest.requiresFlag` is
    // disabled, skip this plugin entirely. Skipping means: no `init()`, no
    // tool / route / skill contributions, and no shutdown hook entry. A
    // later boot with the flag flipped ON picks up the plugin cleanly.
    const requiredFlags = plugin.manifest.requiresFlag ?? [];
    let disabledFlag: string | undefined;
    for (const flagKey of requiredFlags) {
      if (!isAssistantFeatureFlagEnabled(flagKey, ctx.config)) {
        disabledFlag = flagKey;
        break;
      }
    }
    if (disabledFlag !== undefined) {
      log.info(
        { plugin: name, flag: disabledFlag },
        `skipping plugin ${name}: feature flag ${disabledFlag} is disabled`,
      );
      // Drop the plugin from the registry too. `registerPlugin()` added it at
      // import time, and `getMiddlewaresFor()` / `getInjectors()` iterate over
      // every registered entry — without this call, the gated plugin's
      // middleware and injectors would still participate in every pipeline
      // run and system-prompt assembly despite `init()` never firing.
      unregisterPlugin(name);
      continue;
    }

    // Collected as routes are accepted so the catch block can revoke exactly
    // the routes this plugin contributed if a later contribution step throws.
    // Hoisted above the try so it's in scope for the error path.
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
      };

      // Wire the plugin's contributions into their registries BEFORE
      // `init()` runs so the hook can observe its own tools / routes /
      // skills already live. Each contribution step is strict-fail: any
      // failure aborts bootstrap with a {@link PluginExecutionError}
      // naming the offending plugin and triggers the rollback path below.
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

      // Route contributions mirror the skill-route registry shape; see
      // {@link PluginRouteRegistration}. Retain every returned handle so
      // the teardown path unregisters by identity rather than pattern text
      // — two plugins (or a plugin and a skill) that happen to register
      // the same regex must not evict each other's routes during shutdown.
      if (plugin.routes && plugin.routes.length > 0) {
        for (const route of plugin.routes) {
          routeHandles.push(registerSkillRoute(route));
        }
        log.info(
          { plugin: name, count: plugin.routes.length },
          "plugin routes registered",
        );
      }

      // Skills register into the in-memory plugin-skill catalog so
      // `skill_load` / `skill_execute` can resolve them alongside
      // filesystem skills. A registration failure aborts bootstrap with
      // the plugin named — same strict-fail posture as init() throws.
      if (plugin.skills && plugin.skills.length > 0) {
        try {
          // `plugin.skills` is typed as `PluginSkillRegistration[]` at
          // the Plugin interface — the type assertion here is a narrowing
          // from that generic slot into the concrete shape the registry
          // expects.
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

      // Init runs LAST so the plugin's hook can observe its own tools /
      // routes / skills already wired into the registries. A throw here
      // rolls back every contribution above before bootstrap re-throws.
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
      // Init succeeded (or no init hook). The catch block reads this to
      // decide whether `onShutdown` runs during rollback — it should fire
      // only when there is matching init-side state to tear down, which
      // first exists between this point and the `activePlugins.push`
      // below.
      initCompleted = true;

      activePlugins.push({ plugin, routeHandles });

      log.info({ plugin: name }, "plugin initialized");
    } catch (err) {
      // Roll back the currently-failing plugin before unwinding earlier
      // plugins via `teardownPartialInit`. It is not in `activePlugins`
      // yet (that push happens only after init() succeeds), so the
      // partial-init walk alone would leave its already-registered
      // tools/routes/skills live.
      //
      // The `initCompleted` branch covers the narrow window where init
      // succeeded but a step between init's success and
      // `activePlugins.push` throws — there the plugin has live init-side
      // state that `onShutdown` is responsible for cleaning up, so the
      // full rollbackPlugin path (with onShutdown) runs.
      //
      // The else branch is the dominant failure mode now that init runs
      // LAST: contributions may have registered partially but init never
      // ran, so `onShutdown` must NOT fire (calling it would invoke the
      // plugin's teardown against an uninitialized self, violating the
      // lifecycle contract documented on `Plugin.onShutdown`). Tools,
      // routes, and skills are still unregistered in the order
      // `teardownPlugin` uses, and the plugin is dropped from the
      // registry.
      if (initCompleted) {
        await rollbackPlugin({ plugin, routeHandles });
      } else {
        for (const handle of routeHandles) {
          unregisterSkillRoute(handle);
        }
        unregisterPluginTools(name);
        if (plugin.skills && plugin.skills.length > 0) {
          unregisterPluginSkills(name);
        }
        unregisterPlugin(name);
      }
      await teardownPartialInit();
      throw err;
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
  //   4. Unregister contributed skills via the ref-counted helper. Skills tear
  //      down last so `onShutdown()` can still invoke skill-resolving code
  //      (e.g. to flush pending skill work) before the catalog is emptied.
  //      This mirrors the symmetry of registerPluginSkills() — every
  //      successful registration must get a matching unregister call,
  //      regardless of whether onShutdown throws.
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

/**
 * Post-boot install / hot-reload entry point invoked by the plugin source
 * watcher when a directory under `<workspaceDir>/plugins/<name>/` is
 * created or modified.
 *
 * **First fire for a plugin name** (not in the registry):
 *   build → feature-flag gate → resolve credentials + validate config →
 *   `init()` → register in registry + register tools. The plugin's
 *   `init()` hook runs exactly once for the lifetime of the daemon.
 *
 * **Subsequent fires for the same name** (already in the registry):
 *   build → feature-flag gate → REPLACE the registry entry → re-register
 *   tools. `init()` is NOT called — init is a one-shot lifecycle event.
 *   Hooks, middleware, and injectors update transparently because they
 *   live on the Plugin object itself; consumers iterate the registry Map
 *   and the slot's value is swapped atomically, so subsequent reads see
 *   the new functions.
 *
 * Per-plugin isolation: any error inside this function is logged with
 * plugin attribution and swallowed. One bad fire must not stall the
 * watcher or crash the daemon. The watcher debounces per plugin name, so
 * a partial-write fire (package.json missing, surface file mid-save)
 * self-heals when the next debounced fire sees a complete state.
 *
 * Limitations (v1):
 *   - {@link buildExternalPlugin} reads `tools` and `hooks` from disk
 *     only; the loader does not currently read `skills`, `routes`, or
 *     `injectors`. Hot-reload therefore swaps tools and the Plugin
 *     object itself (which carries hooks, middleware, and injectors).
 *     Skills and routes are not touched here.
 *   - Manifest changes between fires (`requiresFlag`,
 *     `requiresCredential`, `config` validator) retain the original
 *     init's resolved values — restart the daemon to pick up manifest
 *     changes that affect those gates.
 */
export async function installPluginPostBoot(
  pluginName: string,
  ctx: DaemonContext,
): Promise<void> {
  const pluginDir = join(getWorkspaceDir(), "plugins", pluginName);

  const plugin = await buildExternalPlugin(pluginDir);
  if (plugin === undefined) {
    // buildExternalPlugin already logged the failure with attribution.
    // The watcher will re-fire when the directory state settles, so a
    // transient missing-file case self-heals.
    return;
  }
  if (plugin.manifest.name !== pluginName) {
    log.warn(
      { plugin: pluginName, manifestName: plugin.manifest.name, pluginDir },
      `post-boot install: directory name "${pluginName}" does not match manifest.name "${plugin.manifest.name}" — skipping`,
    );
    return;
  }

  // Feature-flag gate on the plugin itself. If any required flag is
  // disabled, skip — the watcher will fire again on the next source
  // change, and a later boot with the flag enabled picks up the plugin
  // via the normal bootstrap path.
  for (const flagKey of plugin.manifest.requiresFlag ?? []) {
    if (!isAssistantFeatureFlagEnabled(flagKey, ctx.config)) {
      log.info(
        { plugin: pluginName, flag: flagKey },
        `post-boot install: gated by disabled feature flag ${flagKey} — skipping`,
      );
      return;
    }
  }

  const existing = getRegisteredPlugin(pluginName);

  if (existing !== undefined) {
    // ─── HOT-RELOAD PATH ─────────────────────────────────────────────
    //
    // Tear down the existing plugin's tool contributions, swap the
    // Plugin object in the registry, then re-register fresh tool
    // contributions. `init()` is NOT called — see the function-level
    // docstring for the lifecycle reasoning. Hooks, middleware, and
    // injectors update transparently when the registry's Map slot is
    // replaced; no explicit teardown is needed for those.
    try {
      unregisterPluginTools(pluginName);
    } catch (err) {
      log.warn(
        { err, plugin: pluginName },
        "post-boot hot-reload: tool unregister failed (continuing — re-register below may shadow stale entries)",
      );
    }
    try {
      registerPluginPostBoot(plugin);
    } catch (err) {
      log.error(
        { err, plugin: pluginName },
        "post-boot hot-reload: registry replace failed — old plugin entry remains live",
      );
      return;
    }
    if (plugin.tools && plugin.tools.length > 0) {
      try {
        const accepted = registerPluginTools(pluginName, plugin.tools);
        log.info(
          { plugin: pluginName, count: accepted.length },
          "post-boot plugin hot-reloaded (tools re-registered, init not called)",
        );
        return;
      } catch (err) {
        log.error(
          { err, plugin: pluginName },
          "post-boot hot-reload: tool re-register failed (plugin object replaced, tools missing)",
        );
        return;
      }
    }
    log.info(
      { plugin: pluginName },
      "post-boot plugin hot-reloaded (no tools, init not called)",
    );
    return;
  }

  // ─── FRESH-INSTALL PATH ────────────────────────────────────────────
  //
  // Resolve credentials → validate config → ensure storage dir → run
  // `init()` → register → register tools. Failures at any step are
  // logged and skipped: the watcher will re-fire on the next source
  // change, giving the plugin author a chance to correct the issue
  // without restarting the daemon.

  const credentials: Record<string, string> = {};
  try {
    for (const key of plugin.manifest.requiresCredential ?? []) {
      credentials[key] = await resolveCredentialOrThrow(pluginName, key);
    }
  } catch (err) {
    log.error(
      { err, plugin: pluginName },
      "post-boot install: credential resolution failed — skipping",
    );
    return;
  }

  const rawConfig = getPluginConfigRaw(ctx.config, pluginName);
  let config: unknown;
  try {
    config = validatePluginConfig(
      pluginName,
      plugin.manifest.config,
      rawConfig,
    );
  } catch (err) {
    log.error(
      { err, plugin: pluginName },
      "post-boot install: config validation failed — skipping",
    );
    return;
  }

  const pluginStorageDir = ensurePluginStorageDir(pluginName);

  const initContext: PluginInitContext = {
    config,
    credentials,
    logger: log.child({ plugin: pluginName }),
    pluginStorageDir,
    assistantVersion: ctx.assistantVersion,
  };

  if (plugin.hooks?.[HOOKS.INIT]) {
    try {
      await plugin.hooks[HOOKS.INIT](initContext);
    } catch (err) {
      log.error(
        { err, plugin: pluginName },
        "post-boot install: init() failed — plugin not registered, no tools contributed",
      );
      return;
    }
  }

  try {
    registerPluginPostBoot(plugin);
  } catch (err) {
    log.error(
      { err, plugin: pluginName },
      "post-boot install: registry write failed after successful init — plugin init ran but plugin is not live",
    );
    return;
  }

  if (plugin.tools && plugin.tools.length > 0) {
    try {
      const accepted = registerPluginTools(pluginName, plugin.tools);
      log.info(
        { plugin: pluginName, count: accepted.length },
        "post-boot plugin installed",
      );
      return;
    } catch (err) {
      log.error(
        { err, plugin: pluginName },
        "post-boot install: tool registration failed after init + registry write — plugin is live but contributes no tools",
      );
      return;
    }
  }

  log.info({ plugin: pluginName }, "post-boot plugin installed (no tools)");
}
