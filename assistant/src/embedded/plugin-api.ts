/**
 * Embedded handle for `@vellumai/plugin-api`.
 *
 * Standard `import * as pluginApi from "../plugin-api/index.ts"` lets Bun's
 * normal bundler walk the plugin-api module graph at build time — relative
 * imports inside plugin-api (`./types.js`, future runtime siblings) are
 * inlined naturally, with no separate build step. In `bun --compile`, this
 * means plugin-api ships as part of the assistant binary's regular code
 * graph; in JIT/Docker, it loads from source.
 *
 * The loaded namespace is then installed on `globalThis` under a well-known
 * symbol. The boot-time shim writer (`ensurePluginApiShim`) enumerates
 * {@link PLUGIN_API_EXPORTS} and generates a tiny ESM module at
 * `<workspaceDir>/node_modules/@vellumai/plugin-api/index.js` that
 * re-binds each runtime export from `globalThis`. User plugins that
 * `import { ... } from "@vellumai/plugin-api"` walk up to that shim and
 * pick up the bindings.
 *
 * Type-only exports erase before this module loads, so `Object.keys`
 * sees only runtime exports. That's correct — types are a dev-time
 * concern, resolved against plugin-api source via tsconfig path-mapping
 * (or, post-PR-5, against a generated `.d.ts` next to the runtime
 * shim).
 */

import * as pluginApi from "../plugin-api/index.js";

/** Symbol key under which the plugin-api namespace is published on globalThis. */
export const PLUGIN_API_REGISTRY_KEY = Symbol.for("vellum.plugin-api");

// Install on globalThis once at module-load time. The shim writer reads
// `PLUGIN_API_EXPORTS` to know which bindings to re-export; the shim's
// generated body then reads `globalThis[PLUGIN_API_REGISTRY_KEY]` to grab
// the live module namespace.
(globalThis as Record<symbol, unknown>)[PLUGIN_API_REGISTRY_KEY] = pluginApi;

/** Names of the runtime exports the workspace shim should re-bind. */
export const PLUGIN_API_EXPORTS: readonly string[] = Object.freeze(
  Object.keys(pluginApi),
);
