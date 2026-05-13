/**
 * Public entry point for the `@vellumai/plugin-api` package.
 *
 * Plugin authors import from `"@vellumai/plugin-api"`; this file is what
 * their import lands on (directly via the published npm package, or via a
 * boot-time shim that re-exports from the assistant binary's embedded
 * bundle).
 *
 * Keep this file's surface stable across minor/patch releases. Anything
 * exported here is part of the public contract.
 *
 * ## Surface today
 *
 * The public package is intentionally **declarative**: a plugin is a
 * directory whose `package.json` is the manifest and whose `hooks/` /
 * `tools/` / `skills/` / `routes/` subdirectories are the contributions.
 * The host introspects the directory at load time and wires it into the
 * runtime — plugin authors never call a runtime registration function.
 *
 * What this module exposes is therefore types-only: the context shapes
 * the host hands to plugin hooks, and the logger shape they include.
 *
 * - {@link PluginInitContext} — passed to `init` hook at bootstrap
 * - {@link PluginShutdownContext} — passed to `shutdown` hook at teardown
 * - {@link PluginLogger} — pino-compatible logger shape on the contexts
 * - {@link ToolContext} — passed to a plugin tool's `execute` method
 * - {@link ToolExecutionResult} — return shape of a plugin tool's `execute`
 *
 * Pipeline-argument types (`LLMCallArgs`, `MemoryArgs`, etc.) currently
 * live in `assistant/src/plugins/types.ts` and have not yet migrated into
 * this package. A follow-up PR will move them into this surface as the
 * per-pipeline schemas stabilize.
 */

export type {
  PluginInitContext,
  PluginLogger,
  PluginShutdownContext,
  ToolContext,
  ToolExecutionResult,
} from "./types.js";
