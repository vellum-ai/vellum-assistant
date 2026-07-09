/**
 * Best-effort materialization of the `@vellumai/plugin-api` workspace shim for
 * standalone `assistant plugins` subcommands.
 *
 * The daemon writes this shim at boot (`loadUserPlugins`), but a `plugins`
 * subcommand can run in a fresh CLI process that never booted the daemon. When
 * such a subcommand resolves a plugin hook in-process — `uninstall` running a
 * plugin's `shutdown` that imports `@vellumai/plugin-api` — the package has to
 * be importable. This wraps the daemon materializer in a swallow-all guard so
 * the CLI command group can prepare it once: a failure just means such an
 * import may not resolve; it never blocks the command.
 *
 * Lives under `cli/lib` so the transport-tagged command file can reach the
 * daemon-internal materializer through the allowed `../lib/*` surface rather
 * than importing `../../plugins/*` directly (`cli/no-daemon-internals`).
 */

import { ensurePluginApiShim } from "../../plugins/ensure-plugin-api-shim.js";

/** Materialize the plugin-api shim, swallowing any failure. */
export async function ensureCliPluginApiShim(): Promise<void> {
  await ensurePluginApiShim().catch(() => {});
}
