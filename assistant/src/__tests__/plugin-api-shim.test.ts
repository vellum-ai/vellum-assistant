/**
 * Smoke tests for the workspace-level `@vellumai/plugin-api` shim.
 *
 * Covers the design verified during the PR-2 experiments:
 *   - shim files are materialized at `<workspaceDir>/node_modules/@vellumai/plugin-api/`
 *   - the index.js re-exports from the embedded artifact path
 *   - the shim is idempotent across re-runs
 *   - a fake plugin in `<workspaceDir>/plugins/<name>/` can resolve the
 *     bare `@vellumai/plugin-api` specifier via Node-style walk-up,
 *     proving the end-to-end import path works for real user plugins
 *
 * As the plugin-api surface grows (runtime exports migrate over in
 * follow-up PRs), the imported module's keys will expand. For now,
 * the surface is types-only so the bundled artifact is empty —
 * the test only asserts the shim is reachable, not its surface.
 */

import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { pluginApiPath } from "../embedded/plugin-api.js";
import { ensurePluginApiShim } from "../plugins/ensure-plugin-api-shim.js";

const SHIM_REL_PATH = "node_modules/@vellumai/plugin-api";

describe("ensurePluginApiShim", () => {
  test("creates a resolvable @vellumai/plugin-api package under workspaceDir", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "plugin-api-shim-"));
    await ensurePluginApiShim({ workspaceDir });

    const shimDir = join(workspaceDir, SHIM_REL_PATH);
    const indexJs = await readFile(join(shimDir, "index.js"), "utf8");
    expect(indexJs).toBe(`export * from ${JSON.stringify(pluginApiPath)};\n`);

    const pkg = JSON.parse(
      await readFile(join(shimDir, "package.json"), "utf8"),
    );
    expect(pkg.name).toBe("@vellumai/plugin-api");
    expect(pkg.type).toBe("module");
    expect(pkg.main).toBe("./index.js");
    expect(typeof pkg.version).toBe("string");
  });

  test("is idempotent — re-running yields the same shim contents", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "plugin-api-shim-"));
    await ensurePluginApiShim({ workspaceDir });
    const first = await readFile(
      join(workspaceDir, SHIM_REL_PATH, "index.js"),
      "utf8",
    );

    await ensurePluginApiShim({ workspaceDir });
    const second = await readFile(
      join(workspaceDir, SHIM_REL_PATH, "index.js"),
      "utf8",
    );
    expect(second).toBe(first);
  });

  test("a fake user plugin can resolve @vellumai/plugin-api via Node-style walk-up", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "plugin-api-shim-"));
    await ensurePluginApiShim({ workspaceDir });

    const pluginDir = join(workspaceDir, "plugins", "fake-plugin");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, "register.js"),
      `import * as api from "@vellumai/plugin-api";\nexport { api };\n`,
    );

    // Resolution walks up: plugins/fake-plugin → plugins → workspaceDir
    // → workspaceDir/node_modules/@vellumai/plugin-api → shim → embedded
    // artifact. If any link in that chain is broken, this import throws.
    const mod: { api: Record<string, unknown> } = await import(
      join(pluginDir, "register.js")
    );
    expect(mod.api).toBeDefined();
  });
});
