/**
 * Tests for the experimental plugin loader.
 *
 * Each test materializes a synthetic plugin directory under a per-file
 * tempdir, then asks `loadExperimentalPlugin()` to walk it. Surface files
 * use plain TypeScript with default exports so bun can dynamic-import
 * them at runtime without a build step — same as the legacy
 * user-loader tests.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import { loadExperimentalPlugin } from "../plugins/experimental-plugin-loader.js";

const ROOT = join(
  tmpdir(),
  `vellum-experimental-plugin-loader-test-${process.pid}-${Date.now()}`,
);

function freshPluginDir(name: string): string {
  const dir = join(ROOT, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writePackageJson(dir: string, pkg: Record<string, unknown>): void {
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
}

function writeSurfaceFile(dir: string, relPath: string, body: string): void {
  const full = join(dir, relPath);
  mkdirSync(join(dir, relPath, "..").replace(/[\\/]\.\.$/, ""), {
    recursive: true,
  });
  // The path-join hack above is ugly; do the dirname explicitly to be safe.
  const parts = relPath.split("/");
  parts.pop();
  if (parts.length > 0) {
    mkdirSync(join(dir, ...parts), { recursive: true });
  }
  writeFileSync(full, body);
}

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("loadExperimentalPlugin", () => {
  describe("manifest", () => {
    test("uses package.json name and version", async () => {
      const dir = freshPluginDir("minimal");
      writePackageJson(dir, { name: "minimal-plugin", version: "1.2.3" });

      const plugin = await loadExperimentalPlugin(dir);

      expect(plugin.manifest.name).toBe("minimal-plugin");
      expect(plugin.manifest.version).toBe("1.2.3");
      expect(plugin.manifest.requires).toEqual({ pluginRuntime: "v1" });
    });

    test("strips npm scope from name", async () => {
      const dir = freshPluginDir("scoped");
      writePackageJson(dir, {
        name: "@vellumai/simple-memory",
        version: "0.1.0",
      });

      const plugin = await loadExperimentalPlugin(dir);

      expect(plugin.manifest.name).toBe("simple-memory");
    });

    test("defaults version to 0.0.0 when package.json omits it", async () => {
      const dir = freshPluginDir("no-version");
      writePackageJson(dir, { name: "no-version-plugin" });

      const plugin = await loadExperimentalPlugin(dir);

      expect(plugin.manifest.version).toBe("0.0.0");
    });

    test("throws when package.json is malformed", async () => {
      const dir = freshPluginDir("malformed-pkg");
      writeFileSync(join(dir, "package.json"), "{ this is not json");

      await expect(loadExperimentalPlugin(dir)).rejects.toThrow(
        /could not be read or parsed/,
      );
    });

    test("throws when package.json is missing name", async () => {
      const dir = freshPluginDir("no-name");
      writePackageJson(dir, { version: "1.0.0" });

      await expect(loadExperimentalPlugin(dir)).rejects.toThrow(
        /missing a non-empty "name"/,
      );
    });

    test('throws when name is empty string', async () => {
      const dir = freshPluginDir("empty-name");
      writePackageJson(dir, { name: "", version: "1.0.0" });

      await expect(loadExperimentalPlugin(dir)).rejects.toThrow(
        /missing a non-empty "name"/,
      );
    });
  });

  describe("hooks", () => {
    test("wires hooks/init.ts default export to plugin.init", async () => {
      const dir = freshPluginDir("with-init");
      writePackageJson(dir, { name: "with-init", version: "0.1.0" });
      writeSurfaceFile(
        dir,
        "hooks/init.ts",
        `export default async function init(_ctx: unknown): Promise<void> {
  (globalThis as Record<string, unknown>).__experimentalInitCalled = true;
}
`,
      );

      const plugin = await loadExperimentalPlugin(dir);

      expect(typeof plugin.init).toBe("function");
      // Sanity: the function is actually callable as a hook.
      await plugin.init?.({} as never);
      expect(
        (globalThis as Record<string, unknown>).__experimentalInitCalled,
      ).toBe(true);
      delete (globalThis as Record<string, unknown>).__experimentalInitCalled;
    });

    test("wires hooks/shutdown.ts default export to plugin.onShutdown", async () => {
      const dir = freshPluginDir("with-shutdown");
      writePackageJson(dir, { name: "with-shutdown", version: "0.1.0" });
      writeSurfaceFile(
        dir,
        "hooks/shutdown.ts",
        `export default async function onShutdown(): Promise<void> {
  (globalThis as Record<string, unknown>).__experimentalShutdownCalled = true;
}
`,
      );

      const plugin = await loadExperimentalPlugin(dir);

      expect(typeof plugin.onShutdown).toBe("function");
      await plugin.onShutdown?.();
      expect(
        (globalThis as Record<string, unknown>).__experimentalShutdownCalled,
      ).toBe(true);
      delete (globalThis as Record<string, unknown>)
        .__experimentalShutdownCalled;
    });

    test("plugin.init is undefined when hooks/init.ts is absent", async () => {
      const dir = freshPluginDir("no-init");
      writePackageJson(dir, { name: "no-init", version: "0.1.0" });

      const plugin = await loadExperimentalPlugin(dir);

      expect(plugin.init).toBeUndefined();
      expect(plugin.onShutdown).toBeUndefined();
    });

    test("throws when hooks/init.ts has no default export", async () => {
      const dir = freshPluginDir("init-no-default");
      writePackageJson(dir, { name: "init-no-default", version: "0.1.0" });
      writeSurfaceFile(
        dir,
        "hooks/init.ts",
        `export const init = async () => undefined;\n`,
      );

      await expect(loadExperimentalPlugin(dir)).rejects.toThrow(
        /no default export/,
      );
    });

    test("throws when hooks/init.ts default export is not a function", async () => {
      const dir = freshPluginDir("init-not-fn");
      writePackageJson(dir, { name: "init-not-fn", version: "0.1.0" });
      writeSurfaceFile(
        dir,
        "hooks/init.ts",
        `export default { not: "a function" };\n`,
      );

      await expect(loadExperimentalPlugin(dir)).rejects.toThrow(
        /init default export must be a function/,
      );
    });
  });

  describe("tools", () => {
    test("collects every default-exported tool under tools/", async () => {
      const dir = freshPluginDir("two-tools");
      writePackageJson(dir, { name: "two-tools", version: "0.1.0" });
      writeSurfaceFile(
        dir,
        "tools/alpha.ts",
        `export default {
  name: "two_tools_alpha",
  description: "alpha",
  category: "plugin",
  defaultRiskLevel: "low" as const,
  getDefinition() { return { name: "two_tools_alpha", description: "alpha", input_schema: { type: "object", properties: {}, required: [] } }; },
  async execute() { return { content: "a", isError: false }; },
};
`,
      );
      writeSurfaceFile(
        dir,
        "tools/beta.ts",
        `export default {
  name: "two_tools_beta",
  description: "beta",
  category: "plugin",
  defaultRiskLevel: "low" as const,
  getDefinition() { return { name: "two_tools_beta", description: "beta", input_schema: { type: "object", properties: {}, required: [] } }; },
  async execute() { return { content: "b", isError: false }; },
};
`,
      );

      const plugin = await loadExperimentalPlugin(dir);

      expect(plugin.tools).toBeDefined();
      const names = (plugin.tools ?? []).map(
        (t) => (t as { name: string }).name,
      );
      expect(names).toEqual(["two_tools_alpha", "two_tools_beta"]);
    });

    test("plugin.tools is undefined when tools/ is absent", async () => {
      const dir = freshPluginDir("no-tools");
      writePackageJson(dir, { name: "no-tools", version: "0.1.0" });

      const plugin = await loadExperimentalPlugin(dir);

      expect(plugin.tools).toBeUndefined();
    });

    test("throws when a tool file has no default export", async () => {
      const dir = freshPluginDir("tool-no-default");
      writePackageJson(dir, {
        name: "tool-no-default",
        version: "0.1.0",
      });
      writeSurfaceFile(
        dir,
        "tools/broken.ts",
        `export const broken = { name: "broken" };\n`,
      );

      await expect(loadExperimentalPlugin(dir)).rejects.toThrow(
        /no default export/,
      );
    });

    test("throws when a tool default export lacks a string name", async () => {
      const dir = freshPluginDir("tool-no-name");
      writePackageJson(dir, { name: "tool-no-name", version: "0.1.0" });
      writeSurfaceFile(
        dir,
        "tools/nameless.ts",
        `export default { description: "missing name" };\n`,
      );

      await expect(loadExperimentalPlugin(dir)).rejects.toThrow(
        /must be a Tool object with a string "name"/,
      );
    });
  });

  describe("end-to-end @vellumai/simple-memory", () => {
    test("loads the in-tree simple-memory plugin off origin/main", async () => {
      // Resolve the real on-disk plugin from the worktree. This double-acts
      // as the loader's contract test against the canonical Phase 0 plugin
      // and exercises the relative `../src/state.js` imports inside the
      // plugin's surface files.
      const pluginDir = join(
        import.meta.dir,
        "..",
        "..",
        "..",
        "experimental",
        "plugins",
        "simple-memory",
      );

      const plugin = await loadExperimentalPlugin(pluginDir);

      expect(plugin.manifest.name).toBe("simple-memory");
      expect(typeof plugin.init).toBe("function");
      expect(typeof plugin.onShutdown).toBe("function");
      const toolNames = (plugin.tools ?? []).map(
        (t) => (t as { name: string }).name,
      );
      expect(toolNames.sort()).toEqual([
        "simple_memory_recall",
        "simple_memory_remember",
      ]);
    });
  });
});

describe("loadExperimentalPlugin — coexistence with legacy loader", () => {
  beforeEach(() => {
    // No registry state to reset for these — we only exercise the
    // directory-walker.
  });

  test("a directory without package.json is the legacy loader's problem", async () => {
    // The experimental loader is intentionally not defensive here: its
    // package.json gate is enforced by `loadUserPlugins`. This test
    // documents the contract — if a caller does invoke us on a directory
    // without package.json, we surface the same malformed-pkg error so the
    // mistake is loud rather than silent.
    const dir = freshPluginDir("no-package-json");

    await expect(loadExperimentalPlugin(dir)).rejects.toThrow(
      /package.json could not be read or parsed/,
    );
  });
});
