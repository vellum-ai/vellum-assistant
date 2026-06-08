/**
 * Smoke tests for the workspace-level `@vellumai/plugin-api` shim.
 *
 *   - shim files are materialized at `<workspaceDir>/node_modules/@vellumai/plugin-api/`
 *   - the shim's index.js re-binds each runtime export from globalThis
 *   - the shim is idempotent across re-runs
 *   - a fake plugin in `<workspaceDir>/plugins/<name>/` can resolve the
 *     bare `@vellumai/plugin-api` specifier via Node-style walk-up,
 *     proving the end-to-end import path works for real user plugins
 *
 * As plugin-api's runtime surface grows in follow-up PRs, the shim's
 * generated export list expands automatically — the test below covers
 * the generator (`buildShimSource`) directly so we don't need to
 * update assertions every time an export is added.
 */

import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  PLUGIN_API_EXPORTS,
  PLUGIN_API_REGISTRY_KEY,
} from "../embedded/plugin-api.js";
import {
  buildShimSource,
  ensurePluginApiShim,
} from "../plugins/ensure-plugin-api-shim.js";

const SHIM_REL_PATH = "node_modules/@vellumai/plugin-api";

describe("buildShimSource", () => {
  test("emits a globalThis trampoline + one binding per export", () => {
    const source = buildShimSource(
      ["foo", "bar"],
      Symbol.for("vellum.plugin-api"),
    );
    expect(source).toBe(
      `const api = globalThis[Symbol.for("vellum.plugin-api")];\n` +
        `export const foo = api.foo;\n` +
        `export const bar = api.bar;\n`,
    );
  });

  test("handles an empty export list (today's types-only surface)", () => {
    const source = buildShimSource([], Symbol.for("vellum.plugin-api"));
    expect(source).toBe(
      `const api = globalThis[Symbol.for("vellum.plugin-api")];\n`,
    );
  });
});

describe("ensurePluginApiShim", () => {
  test("creates a resolvable @vellumai/plugin-api package under workspaceDir", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "plugin-api-shim-"));
    await ensurePluginApiShim({ workspaceDir });

    const shimDir = join(workspaceDir, SHIM_REL_PATH);
    const indexJs = await readFile(join(shimDir, "index.js"), "utf8");
    expect(indexJs).toBe(buildShimSource());

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

  test("globalThis is populated with the plugin-api namespace", () => {
    // Importing the embed wrapper has the side effect of installing the
    // namespace on globalThis. By the time this test runs (any earlier
    // test in the file has already imported it), the registry must be
    // populated.
    const namespace = (globalThis as Record<symbol, unknown>)[
      PLUGIN_API_REGISTRY_KEY
    ];
    expect(namespace).toBeDefined();
    // Exports list is non-null but may be empty until runtime exports
    // migrate in later PRs.
    expect(Array.isArray(PLUGIN_API_EXPORTS)).toBe(true);
  });

  test("a fake user plugin can resolve @vellumai/plugin-api via Node-style walk-up", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "plugin-api-shim-"));
    await ensurePluginApiShim({ workspaceDir });

    const pluginDir = join(workspaceDir, "plugins", "fake-plugin");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, "probe.js"),
      `import * as api from "@vellumai/plugin-api";\nexport { api };\n`,
    );

    // Resolution walks up: plugins/fake-plugin → plugins → workspaceDir
    // → workspaceDir/node_modules/@vellumai/plugin-api → shim → globalThis
    // → plugin-api namespace. If any link in that chain is broken, this
    // import throws.
    const mod: { api: Record<string, unknown> } = await import(
      join(pluginDir, "probe.js")
    );
    expect(mod.api).toBeDefined();
  });
});
