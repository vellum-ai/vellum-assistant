/**
 * Tests for {@link ensureCliPluginApiShim} — the CLI-side best-effort wrapper
 * the `plugins` command group runs at init so a fresh CLI process can import
 * `@vellumai/plugin-api` when a subcommand resolves a plugin hook (e.g.
 * `uninstall` running a `shutdown`).
 *
 * The underlying materializer (`ensurePluginApiShim`) and its idempotency are
 * covered by `src/__tests__/plugin-api-shim.test.ts`; here we pin the wrapper's
 * own contract: it materializes the shim under the workspace and resolves.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { getWorkspaceDir } from "../../../util/platform.js";
import { ensureCliPluginApiShim } from "../ensure-cli-plugin-api-shim.js";

const SHIM_REL_PATH = "node_modules/@vellumai/plugin-api";

describe("ensureCliPluginApiShim", () => {
  test("materializes the @vellumai/plugin-api shim under the workspace", async () => {
    await ensureCliPluginApiShim();

    const shimDir = join(getWorkspaceDir(), SHIM_REL_PATH);
    expect(existsSync(join(shimDir, "index.js"))).toBe(true);

    const pkg = JSON.parse(readFileSync(join(shimDir, "package.json"), "utf8"));
    expect(pkg.name).toBe("@vellumai/plugin-api");
  });

  test("resolves (never rejects) so it can't block the command", async () => {
    await expect(ensureCliPluginApiShim()).resolves.toBeUndefined();
  });
});
