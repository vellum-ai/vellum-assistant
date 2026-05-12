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
 * Runtime values:
 * - {@link registerPlugin} — register a plugin with the assistant's runtime
 *
 * Public types:
 * - {@link Plugin} — the manifest + hook + tool + skill + route bundle the
 *   runtime accepts
 * - {@link PluginManifest} — static metadata describing a plugin
 * - {@link PluginInitContext} — passed to `Plugin.hooks.init()` at bootstrap
 * - {@link PluginShutdownContext} — passed to `Plugin.hooks.shutdown()` at
 *   teardown
 *
 * Pipeline-argument types (`LLMCallArgs`, `MemoryArgs`, etc.) currently
 * live in `assistant/src/plugins/types.ts` and have not yet migrated into
 * this package. Plugin authors writing middleware for those pipelines can
 * either rely on TypeScript's structural typing without naming the args
 * type, or vendor the type definitions directly. A follow-up PR will move
 * them into this surface as the per-pipeline schemas stabilize.
 */

// Runtime: register a plugin with the host's registry. Plugin authors call
// this from their module body as a side effect; the host walks the registry
// post-load and wires each plugin into its lifecycle.
export { registerPlugin } from "../plugins/registry.js";

// Public types: defined inside this package's own module so the surface is
// self-contained, plus a curated re-export of the higher-level Plugin /
// PluginManifest shapes from the internal types module. The Plugin /
// PluginManifest re-export is type-only — plugins consume the names, but
// none of the transitive internal type machinery gets dragged through to
// the runtime layer.
export type { Plugin, PluginManifest } from "../plugins/types.js";
export type { PluginInitContext, PluginShutdownContext } from "./types.js";
