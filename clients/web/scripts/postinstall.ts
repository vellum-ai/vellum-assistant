/**
 * clients/web postinstall.
 *
 * Generate the OpenAPI client (`src/generated`) if it isn't already on
 * disk, so first-install of a fresh checkout produces a buildable tree.
 * (Idempotent — subsequent installs are no-ops.)
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const webRoot = path.resolve(import.meta.dirname, "..");

if (!existsSync(path.join(webRoot, "src/generated"))) {
  const result = spawnSync("bun", ["run", "openapi-ts"], {
    cwd: webRoot,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
