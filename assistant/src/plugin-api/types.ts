/**
 * Public plugin-API types — the canonical contract for
 * `@vellumai/plugin-api`. Adding fields is non-breaking; renaming /
 * removing is breaking and gated on a major bump.
 *
 * The chain-hook context shapes (and the {@link BaseHookContext} they share)
 * are defined in `assistant/src/hooks/types.ts` and re-exported here, so
 * plugin authors keep importing everything from `@vellumai/plugin-api`.
 */

import type { PluginLogger } from "../hooks/types.js";

export type {
  AgentLoopExitReason,
  BaseHookContext,
  ConversationDeletedContext,
  HookBroadcast,
  PluginLogger,
  PostCompactContext,
  PostModelCallContext,
  PostModelCallDecision,
  PostToolUseContext,
  PreModelCallContext,
  StopContext,
  UserPromptSubmitContext,
} from "../hooks/types.js";
export type {
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "../tools/types.js";
export { RiskLevel } from "../tools/types.js";

// ─── Hook function ───────────────────────────────────────────────────────────

/**
 * A plugin lifecycle hook. Receives a per-lifecycle context shape and may
 * either mutate `ctx` in place (returning `void`) or return a *partial*
 * context whose fields are merged onto the threaded context — only the keys
 * it returns are overwritten, every other field is preserved. Returning a
 * partial lets a hook edit just the subset of fields it cares about without
 * having to re-specify the rest. The merged context is threaded to the next
 * hook in the chain (e.g. `user-prompt-submit`).
 *
 * Because an omitted key means "keep the existing value", every field on a
 * context shape is required (no `?`-optional or `| undefined` members): a
 * present key always carries a concrete value, so "absent from the returned
 * partial" is never ambiguous with "explicitly cleared". Fields that can be
 * empty model that with `| null`, not `| undefined`.
 *
 * Each known hook key has a documented context shape:
 *   - `init` — {@link InitContext}
 *   - `shutdown` — {@link ShutdownContext}
 *   - `user-prompt-submit` — {@link UserPromptSubmitContext}
 *   - `post-compact` — {@link PostCompactContext}
 *   - `pre-model-call` — {@link PreModelCallContext}
 *   - `post-tool-use` — {@link PostToolUseContext}
 *   - `stop` — {@link StopContext}
 *   - `post-model-call` — {@link PostModelCallContext}
 *   - `conversation-deleted` — {@link ConversationDeletedContext}
 */
export type HookFunction<TCtx = unknown> = (
  ctx: TCtx,
) => Promise<Partial<TCtx> | void>;

// ─── Init context ────────────────────────────────────────────────────────────

/**
 * Context passed to `Plugin.init()` during bootstrap. Carries the resolved
 * config, a pino-compatible logger scoped to the plugin, a per-plugin
 * writable data directory, and the assistant's version metadata.
 *
 * For user-installed plugins, config is read from `<pluginDir>/config.json`
 * and `pluginStorageDir` points at `<pluginDir>/data/`. For first-party
 * default plugins and standalone workspace hooks, config comes from the
 * global `config.plugins.<name>` block and `pluginStorageDir` points at
 * `<workspaceDir>/plugins-data/<name>/`.
 */
export interface InitContext {
  /** Parsed config for this plugin (may be `unknown` until the manifest validates). */
  config: unknown;
  /** Pino-compatible child logger bound to `{ plugin: <name> }`. */
  logger: PluginLogger;
  /**
   * Absolute path to the per-plugin writable data directory. For user plugins
   * this is `<pluginDir>/data/`; for defaults and workspace hooks it falls back
   * to `<workspaceDir>/plugins-data/<plugin>/`. Created by bootstrap.
   */
  pluginStorageDir: string;
  /**
   * Assistant semver. Plugins can compare against this for defensive
   * runtime checks — but the canonical compat contract is the host
   * version against the plugin's `peerDependencies["@vellumai/plugin-api"]`
   * semver range, enforced at load time by the external-plugin loader.
   */
  assistantVersion: string;
}

// ─── Model profiles ──────────────────────────────────────────────────────────

/**
 * A workspace inference profile a plugin can route to. Returned by
 * {@link getModelProfiles}; {@link key} is the value a `pre-model-call` hook
 * assigns to `PreModelCallContext.modelProfile` to route a call. A model router
 * reads this list (typically at `init`) to learn which profiles exist before
 * mapping a classified message onto one.
 */
export interface ModelProfileInfo {
  /** Profile key in `llm.profiles`; assignable to `PreModelCallContext.modelProfile`. */
  readonly key: string;
  /** Human-readable label, falling back to {@link key} when none is set. */
  readonly label: string;
  /** Author-supplied description, or `null` when none is set. */
  readonly description: string | null;
  /** Whether this is the workspace's active profile. */
  readonly isActive: boolean;
  /** Whether the profile is disabled; routing to it is rejected by the resolver. */
  readonly isDisabled: boolean;
  /**
   * Whether this is a weighted "mix" profile — an A/B blend that resolves to one
   * of its constituent profiles per conversation via a seeded weighted pick.
   * Routing to its {@link key} is valid; it directs the call into the blend
   * rather than at a single fixed model.
   */
  readonly isMix: boolean;
}

// ─── Shutdown context ────────────────────────────────────────────────────────

/**
 * Why a plugin's `shutdown` hook is firing.
 *
 * - `shutdown` — the daemon is tearing down (process exit).
 * - `uninstall` — the plugin's directory was removed at runtime.
 * - `disable` — the plugin was disabled at runtime (e.g. a `.disabled`
 *   sentinel was added, or a feature flag turned it off).
 * - `reload` — a source file inside the plugin directory changed and the
 *   plugin is being redeployed in place; the old version's `shutdown` runs
 *   before the new version is imported and its `init` fires.
 */
export type ShutdownReason = "shutdown" | "uninstall" | "disable" | "reload";

/**
 * Context passed to the `shutdown` hook. Kept intentionally narrower than
 * {@link InitContext} — teardown paths only need to know which assistant
 * version they're shutting down against (e.g. for version-conditional cleanup
 * of state files written by a previous boot) and {@link ShutdownReason why}
 * they're being torn down (so a plugin can, e.g., delete its state on
 * `uninstall` but preserve it across a plain `shutdown`).
 *
 * The `assistantVersion` field mirrors the init context's so plugins that stash
 * a version stamp at init can compare against the same name on tear-down
 * without keeping their own copy.
 */
export interface ShutdownContext {
  /** Assistant semver for compatibility checks inside the plugin. */
  assistantVersion: string;
  /** Why the plugin is shutting down. */
  reason: ShutdownReason;
}
