/**
 * Whitelist of assistant dependencies surfaced to user plugins via on-disk
 * symlinks (see `plugins/ensure-shared-dep-links.ts`).
 *
 * The plugin installer never runs `bun install`, so an installed plugin is a
 * bare clone — its `dependencies` are unresolvable at import time. The
 * `@vellumai/plugin-api` bare specifier works because the daemon materializes
 * a workspace shim for it. This whitelist generalizes that support to other
 * packages the assistant already ships in its own `node_modules/`: at boot,
 * each entry is symlinked from `<assistant>/node_modules/<name>` into
 * `<workspace>/node_modules/<name>`, so a plugin's `import { z } from "zod"`
 * resolves via Node-style walk-up to the real package — the same copy the
 * assistant uses, no per-plugin installs, no re-exports.
 *
 * ## Whitelist policy
 *
 * Only deps that are (a) already direct dependencies of the assistant,
 * (b) pure-JS with no native bindings or lifecycle scripts, and (c) broadly
 * useful to plugins belong here. Each addition widens the de-facto plugin
 * SDK: plugins will pin to the assistant's copy and its version, so treat
 * the list like public API surface. `zod` is the founding member — the
 * plugin config-validation idiom depends on it, and the assistant pins an
 * exact version.
 */

/** Package names to symlink into the workspace for plugin resolution. */
export const SHARED_DEPS: readonly string[] = Object.freeze(["zod"]);
