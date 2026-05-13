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

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import type { AssistantConfig } from "../config/schema.js";
import { registerDefaultPlugins } from "../plugins/defaults/index.js";
import { buildExternalPlugin } from "../plugins/external-plugin-loader.js";
import { isExternalPluginsEnabled } from "../plugins/feature-gate.js";
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
 * Module-scoped live list of plugins that have completed init + contribute
 * and are eligible for teardown by the single registered shutdown hook.
 * Boot-time plugins are appended here as the bootstrap loop walks the
 * registry; post-boot installs ({@link installPluginPostBoot}) append to
 * the same list. The shutdown hook closes over the live array (not a
 * snapshot) so late-arriving plugins still get an `onShutdown()` call when
 * the daemon stops.
 */
const activePluginsForShutdown: ActivePlugin[] = [];

/**
 * Shutdown context cached once at first bootstrap. Only depends on
 * `assistantVersion` which is constant for the process lifetime, so reusing
 * one object across boot-time and post-boot tear-downs is safe.
 *
 * `undefined` before {@link bootstrapPlugins} runs — {@link installPluginPostBoot}
 * checks this to refuse calls that arrive before the daemon has finished
 * starting up.
 */
let shutdownContextRef: PluginShutdownContext | undefined;

/**
 * Idempotency latch on the single shutdown hook registration. Hot-reload
 * scenarios that call {@link bootstrapPlugins} more than once should still
 * end up with exactly one hook walking the live list.
 */
let shutdownHookInstalled = false;

/**
 * Roll back exactly one plugin: tear down its contributions then drop it
 * from the registry. The two steps always move together — clearing the
 * tools/routes/skills surface keeps the model-visible state consistent,
 * dropping the registry entry keeps `getMiddlewaresFor` / `getInjectors`
 * from re-entering an uninitialized plugin on the next pipeline run.
 */
async function rollbackPlugin(
  active: ActivePlugin,
  reason: string,
  shutdownContext: PluginShutdownContext,
): Promise<void> {
  await teardownPlugin(active, reason, shutdownContext);
  unregisterPlugin(active.plugin.manifest.name);
}

/**
 * Initialise one plugin and wire in its tool/route/skill contributions.
 * Returns the resulting {@link ActivePlugin} on success, `"gated"` when
 * `manifest.requiresFlag` causes the plugin to be skipped (and dropped
 * from the registry), or throws a {@link PluginExecutionError} on
 * credential / init / contribution failure. The catch path rolls back
 * any state this plugin had already wired up so the registry and contribution
 * surfaces are clean before the error propagates — the caller does not need
 * to revisit `name` after the throw.
 *
 * Shared between the boot-time loop in {@link bootstrapPlugins} and the
 * post-boot install path in {@link installPluginPostBoot}. The two paths
 * differ only in what they do with the returned `ActivePlugin` (push to the
 * boot-time accumulator vs append to the live shutdown list) and what they
 * do on error (the boot path also tears down siblings; the post-boot path
 * only owns one plugin so there's nothing else to roll back).
 */
async function initializeAndContributePlugin(
  plugin: Plugin,
  ctx: DaemonContext,
  shutdownContext: PluginShutdownContext,
): Promise<ActivePlugin | "gated"> {
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
    return "gated";
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
    // Tool contributions (PR 31) register only after `init()` succeeds so a
    // plugin that fails mid-init never leaves partially-wired tools behind.
    // Tool registration failures are wrapped in a PluginExecutionError so
    // the offending plugin name surfaces in the abort — matching the
    // strict-fail semantics of `init()` errors.
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

    // Route contributions (PR 32) — registered after init() succeeds so a
    // plugin that fails to initialize never exposes a half-wired HTTP
    // surface. Mirrors the skill-route registry shape; see
    // {@link PluginRouteRegistration}. Retain every returned handle so the
    // teardown path unregisters by identity rather than pattern text — two
    // plugins (or a plugin and a skill) that happen to register the same
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

    // Skills register into the in-memory plugin-skill catalog so
    // `skill_load` / `skill_execute` can resolve them alongside filesystem
    // skills. A registration failure aborts bootstrap with the plugin named
    // — same strict-fail posture as init() throws.
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
    // Roll back the currently-failing plugin so the registry and contribution
    // surfaces don't leak partial state.
    //
    // Branching on `initCompleted` keeps the init/onShutdown pairing intact.
    // When init succeeded but a later contribution step (tools, routes,
    // skills) threw, the plugin has live init-side state that `onShutdown()`
    // is responsible for cleaning up, so the full `rollbackPlugin()` path
    // runs. When init itself failed (or a step before init — credential
    // resolution, config validation — threw), onShutdown must not run:
    // calling it would invoke the plugin's teardown against an uninitialized
    // self, violating the lifecycle contract documented on `Plugin.onShutdown`.
    // In the init-failed case there is also nothing to unregister — tools,
    // routes, and skills are all registered after init — so just drop the
    // plugin from the registry (idempotent if already removed).
    if (initCompleted) {
      await rollbackPlugin(
        { plugin, routeHandles },
        "init-failed",
        shutdownContext,
      );
    } else {
      unregisterPlugin(name);
    }
    throw err;
  }
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

  // Cache the shutdown context once. Only `assistantVersion` is exposed today
  // and it's constant for the process lifetime; the cache lets post-boot
  // installs share the exact same instance the bootstrap loop uses.
  const shutdownContext: PluginShutdownContext = {
    assistantVersion: ctx.assistantVersion,
  };
  shutdownContextRef = shutdownContext;

  const plugins = getRegisteredPlugins();
  if (plugins.length === 0) {
    // No-op fast path. The default injectors normally populate the registry,
    // so this branch is primarily for tests that call
    // `resetPluginRegistryForTests()` and stub the default registration.
    log.debug("bootstrapPlugins: registry empty — skipping");
    // Still install the shutdown hook so a post-boot plugin install that
    // succeeds against an otherwise-empty registry has a teardown owner.
    installSharedShutdownHook(shutdownContext);
    return;
  }

  log.info({ count: plugins.length }, "bootstrapPlugins: initializing plugins");

  // Tear down every plugin that already cleared init + contribute before this
  // boot failure. Without this, a mid-loop failure would leave earlier
  // plugins with live tools/routes/skills and no `onShutdown()` call — the
  // shutdown hook is only installed once the loop completes successfully.
  // Reverse order preserves the registration-order convention every plugin
  // author can rely on for teardown.
  async function teardownPartialInit(): Promise<void> {
    while (activePluginsForShutdown.length > 0) {
      const last = activePluginsForShutdown.pop()!;
      await rollbackPlugin(last, "bootstrap-failed", shutdownContext);
    }
  }

  for (const plugin of plugins) {
    let result: ActivePlugin | "gated";
    try {
      result = await initializeAndContributePlugin(
        plugin,
        ctx,
        shutdownContext,
      );
    } catch (err) {
      // The currently-failing plugin has already been rolled back by
      // initializeAndContributePlugin; tear down every sibling that
      // succeeded before re-throwing.
      await teardownPartialInit();
      throw err;
    }
    if (result !== "gated") {
      activePluginsForShutdown.push(result);
    }
  }

  installSharedShutdownHook(shutdownContext);
}

/**
 * Register the single named shutdown hook that walks the live
 * {@link activePluginsForShutdown} list in reverse order. Idempotent — only
 * the first call installs; subsequent calls (re-bootstrap during tests or
 * hot-reload) no-op so we never end up with duplicate hooks competing for
 * teardown.
 *
 * The hook closes over the live array (not a snapshot) so plugins added
 * post-boot via {@link installPluginPostBoot} get a teardown invocation when
 * the daemon stops.
 */
function installSharedShutdownHook(
  shutdownContext: PluginShutdownContext,
): void {
  if (shutdownHookInstalled) return;
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
  registerShutdownHook("plugins", async (reason) => {
    for (let i = activePluginsForShutdown.length - 1; i >= 0; i--) {
      await teardownPlugin(
        activePluginsForShutdown[i]!,
        reason,
        shutdownContext,
      );
    }
    // Drain the live list after the hook walks it. Without this, a test or
    // hot-reload flow that calls `bootstrapPlugins()` a second time after
    // a teardown would see stale entries from the previous boot still in
    // the list and try to tear them down again on the next stop.
    activePluginsForShutdown.length = 0;
  });
  shutdownHookInstalled = true;
}

/**
 * Initialise a plugin that was installed onto a running daemon (e.g. via
 * `assistant plugins install`) and wire it into the live plugin set
 * without requiring a daemon restart.
 *
 * The path mirrors {@link bootstrapPlugins} for one plugin: build the
 * {@link Plugin} object from disk via {@link buildExternalPlugin}, register
 * past the closed-registration latch with {@link registerPluginPostBoot},
 * then run the shared {@link initializeAndContributePlugin} so credential
 * resolution, config validation, `init()`, and tool/route/skill
 * contribution all use the same code path the boot-time loop uses.
 *
 * Returns a {@link PostBootInstallResult} discriminating between every
 * outcome the IPC route surfaces to the CLI. Never throws — every failure
 * is captured in the returned `status` so the IPC adapter doesn't have to
 * decide whether an unexpected throw is a build, init, or contribution
 * failure.
 *
 * Defense-in-depth checks here even though the CLI also gates on the
 * `external-plugins` feature flag: the daemon must not trust the CLI's
 * gate. The `shutdownContextRef` undefined check refuses calls that
 * somehow arrive before {@link bootstrapPlugins} has cached the
 * shutdown context — the CLI surfaces this as "Start the assistant to
 * load it." since the daemon isn't fully ready yet.
 *
 * Edge cases not handled here:
 *
 * - **`--force` reinstall against an already-loaded plugin** returns
 *   `already-registered` so the CLI can surface "files updated, restart
 *   to load the new version" — live re-load is a separate PR (would
 *   need to unregister tools/routes/skills and re-run init without
 *   leaving the model-visible surface ambiguous mid-flip).
 * - **Plugin uninstall** does NOT unregister the plugin from the live
 *   daemon today — same restart-required contract. Live unregister
 *   ships alongside `--force` re-register.
 */
export async function installPluginPostBoot(
  pluginName: string,
  ctx: DaemonContext,
): Promise<PostBootInstallResult> {
  // Feature-flag gate. Defense-in-depth — the CLI also gates this IPC
  // call. A daemon running with the flag disabled must refuse to extend
  // its plugin set even if a privileged CLI invocation slipped past the
  // CLI-side check (e.g. flag flipped between CLI start and daemon
  // contact, or a non-CLI caller hitting the route directly).
  if (!isExternalPluginsEnabled(ctx.config)) {
    return { status: "feature-disabled" };
  }

  const shutdownContext = shutdownContextRef;
  if (shutdownContext === undefined) {
    // Bootstrap hasn't completed (or the daemon is shutting down). The
    // CLI surfaces this as "Plugin installed. Start the assistant to
    // load it." — files are on disk, just nothing to load them into.
    return { status: "not-bootstrapped" };
  }

  // Duplicate-name pre-check so the failure surfaces before any expensive
  // filesystem work or hook execution. `registerPluginPostBoot` would
  // throw the same error later, but the discriminated status lets the
  // CLI print "files updated, restart to load the new version" without
  // parsing the error message.
  if (getRegisteredPlugin(pluginName) !== undefined) {
    return { status: "already-registered", name: pluginName };
  }

  const pluginDir = join(getWorkspaceDir(), "plugins", pluginName);

  let plugin: Plugin | undefined;
  try {
    plugin = await buildExternalPlugin(pluginDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(
      { err, pluginDir, plugin: pluginName },
      `post-boot plugin build failed: ${message}`,
    );
    return { status: "build-failed", error: message };
  }
  if (plugin === undefined) {
    // `buildExternalPlugin` returns undefined on import timeout.
    return { status: "build-failed", error: "build timed out" };
  }
  if (plugin.manifest.name !== pluginName) {
    // The CLI passes a name it sanitised at install time; if the
    // package.json on disk doesn't match, something tampered with the
    // directory between install and IPC call.
    return {
      status: "build-failed",
      error: `plugin directory ${pluginDir} resolved to "${plugin.manifest.name}" but install requested "${pluginName}"`,
    };
  }

  try {
    registerPluginPostBoot(plugin);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: "build-failed", error: message };
  }

  let result: ActivePlugin | "gated";
  try {
    result = await initializeAndContributePlugin(plugin, ctx, shutdownContext);
  } catch (err) {
    // `initializeAndContributePlugin` already rolled the plugin back: the
    // registry no longer contains it and any tools/routes/skills it
    // contributed have been torn down. We just attribute the failure.
    const message = err instanceof Error ? err.message : String(err);
    log.error(
      { err, plugin: pluginName },
      `post-boot plugin init failed: ${message}`,
    );
    return { status: "init-failed", name: pluginName, error: message };
  }

  if (result === "gated") {
    // The plugin opted itself out via `manifest.requiresFlag`. We did
    // not contribute any model-visible surface and the helper already
    // dropped the plugin from the registry. Surface as `gated` so the
    // CLI can explain why the install didn't take effect this boot.
    return { status: "gated", name: pluginName };
  }

  activePluginsForShutdown.push(result);

  // The bootstrap empty-fast-path also installs the shared hook so this
  // branch is a no-op in normal startup. Belt-and-braces guard for tests
  // that drive `installPluginPostBoot` without running `bootstrapPlugins`
  // first (those should fail the `shutdownContextRef` check above, but
  // the cost of a second `if` is zero).
  if (!shutdownHookInstalled) {
    installSharedShutdownHook(shutdownContext);
  }

  return { status: "loaded", name: pluginName };
}

/**
 * Reset module-scoped bootstrap state. Test-only — throws when invoked
 * outside a test environment so application code can never accidentally
 * wipe live plugin teardown bookkeeping at runtime. Pairs with
 * {@link resetPluginRegistryForTests} so tests that drive bootstrap can
 * fully isolate state between cases.
 */
export function resetBootstrapStateForTests(): void {
  const isTest =
    process.env.BUN_TEST === "1" || process.env.NODE_ENV === "test";
  if (!isTest) {
    throw new PluginExecutionError(
      "resetBootstrapStateForTests may only be called in test environments",
      undefined,
    );
  }
  activePluginsForShutdown.length = 0;
  shutdownContextRef = undefined;
  shutdownHookInstalled = false;
}

/**
 * Outcome of a post-boot install attempt. Discriminated union so the IPC
 * route can surface a precise reason to the CLI without forcing it to parse
 * error messages.
 */
export type PostBootInstallResult =
  | { status: "loaded"; name: string }
  | { status: "gated"; name: string; flag?: string }
  | { status: "already-registered"; name: string }
  | { status: "feature-disabled" }
  | { status: "not-bootstrapped" }
  | { status: "not-found"; pluginDir: string }
  | { status: "build-failed"; error: string }
  | { status: "init-failed"; name: string; error: string };

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
