/**
 * Bundles `@vellumai/plugin-api` to a single self-contained ESM file at
 * `src/plugin-api/dist/index.js`. The bundle is what gets:
 *
 *   - embedded into the assistant binary via `with { type: "file" }`
 *     (see `src/embedded/plugin-api.ts`)
 *   - published to npm as `@vellumai/plugin-api/index.js` (future PR)
 *
 * Re-run this script after touching any source file under
 * `src/plugin-api/`. The committed `dist/index.js` is the canonical
 * artifact — a CI guard verifies it matches a fresh build.
 *
 * Today the plugin-api surface is types-only (`PluginInitContext` +
 * `PluginShutdownContext`), so the bundle is effectively empty. As
 * runtime exports migrate over in follow-up PRs, transitive deps inline
 * into the same artifact.
 */

import { dirname,join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSISTANT_DIR = join(HERE, "..");
const ENTRY = join(ASSISTANT_DIR, "src/plugin-api/index.ts");
const OUT_DIR = join(ASSISTANT_DIR, "src/plugin-api/dist");

const result = await Bun.build({
  entrypoints: [ENTRY],
  target: "bun",
  format: "esm",
  minify: false,
  outdir: OUT_DIR,
  naming: "index.js",
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

const [out] = result.outputs;
console.log(`built ${out.path} (${out.size ?? "?"} bytes)`);
