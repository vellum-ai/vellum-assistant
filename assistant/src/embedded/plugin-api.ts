/**
 * Path to the bundled `@vellumai/plugin-api` artifact.
 *
 * The `with { type: "file" }` syntax embeds the referenced file into the
 * compiled assistant binary (under `/$bunfs/root/...`) while keeping it as
 * a regular FS path in JIT/Docker runs. The boot-time shim writer
 * (`ensurePluginApiShim`) re-exports from this path so user plugins can
 * `import "@vellumai/plugin-api"` against the host's embedded copy
 * without needing a duplicate `node_modules/@vellumai/plugin-api/` per
 * plugin.
 *
 * Build prerequisite: `bun run build:plugin-api` produces
 * `src/plugin-api/bundle/index.js`. The committed bundle file is the
 * canonical artifact; the same file is what gets published to npm in
 * a future PR.
 *
 * The directory is named `bundle/` (not `dist/`) to dodge the root
 * `.gitignore`'s `dist` pattern — see `scripts/build-plugin-api.ts`.
 */

import pluginApiPath from "../plugin-api/bundle/index.js" with { type: "file" };

export { pluginApiPath };
