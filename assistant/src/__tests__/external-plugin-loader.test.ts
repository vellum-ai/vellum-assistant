/**
 * Tests for the external plugin loader.
 *
 * The loader now owns the timeout / try-catch / `registerPlugin` triple
 * directly, so tests exercise observable behavior: after
 * `await loadExternalPlugin(dir)`, what does the registry hold?
 *
 * Each test materializes a synthetic plugin directory under a per-file
 * tempdir. Surface files use plain TypeScript with default exports so
 * bun can dynamic-import them at runtime without a build step.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import { loadExternalPlugin } from "../plugins/external-plugin-loader.js";
import {
  getRegisteredPlugins,
  resetPluginRegistryForTests,
} from "../plugins/registry.js";

const ROOT = join(
  tmpdir(),
  `vellum-external-plugin-loader-test-${process.pid}-${Date.now()}`,
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
  const parts = relPath.split("/");
  parts.pop();
  if (parts.length > 0) {
    mkdirSync(join(dir, ...parts), { recursive: true });
  }
  writeFileSync(join(dir, relPath), body);
}

function registeredNames(): string[] {
  return getRegisteredPlugins().map((p) => p.manifest.name);
}

beforeEach(() => {
  resetPluginRegistryForTests();
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  resetPluginRegistryForTests();
});

describe("loadExternalPlugin — manifest", () => {
  test("uses package.json name and version", async () => {
    const dir = freshPluginDir("minimal");
    writePackageJson(dir, { name: "minimal-plugin", version: "1.2.3" });

    await loadExternalPlugin(dir);

    const registered = getRegisteredPlugins().find(
      (p) => p.manifest.name === "minimal-plugin",
    );
    expect(registered).toBeDefined();
    expect(registered?.manifest.version).toBe("1.2.3");
    // Defaults to pluginRuntime v1 when no `vellum.requires` is set.
    expect(registered?.manifest.requires).toEqual({ pluginRuntime: "v1" });
  });

  test("strips npm scope from name", async () => {
    const dir = freshPluginDir("scoped");
    writePackageJson(dir, {
      name: "@vellumai/simple-memory",
      version: "0.1.0",
    });

    await loadExternalPlugin(dir);

    expect(registeredNames()).toContain("simple-memory");
  });

  test("defaults version to 0.0.0 when package.json omits it", async () => {
    const dir = freshPluginDir("no-version");
    writePackageJson(dir, { name: "no-version-plugin" });

    await loadExternalPlugin(dir);

    const registered = getRegisteredPlugins().find(
      (p) => p.manifest.name === "no-version-plugin",
    );
    expect(registered?.manifest.version).toBe("0.0.0");
  });

  test("reads vellum.requires from package.json when present", async () => {
    // Future direction (out of scope this PR): `requires` may carry
    // `assistantVersion` alongside `pluginRuntime`. For today the registry
    // validates against `ASSISTANT_API_VERSIONS` and only `pluginRuntime`
    // is a known capability — so the loader's pass-through behavior is
    // exercised with the keys the registry already accepts. The loader is
    // opaque to the shape; additional keys propagate identically.
    const dir = freshPluginDir("custom-requires");
    writePackageJson(dir, {
      name: "custom-requires",
      version: "0.1.0",
      vellum: { requires: { pluginRuntime: "v1" } },
    });

    await loadExternalPlugin(dir);

    const registered = getRegisteredPlugins().find(
      (p) => p.manifest.name === "custom-requires",
    );
    expect(registered?.manifest.requires).toEqual({ pluginRuntime: "v1" });
  });

  test("vellum.requires overrides the default — empty requires fails registration", async () => {
    // Belt-and-suspenders proof that the loader reads `vellum.requires`
    // rather than always defaulting: an empty `vellum.requires` propagates
    // through, the registry rejects the plugin (missing pluginRuntime),
    // and the registry stays empty.
    const dir = freshPluginDir("empty-requires");
    writePackageJson(dir, {
      name: "empty-requires",
      version: "0.1.0",
      vellum: { requires: {} },
    });

    await loadExternalPlugin(dir);

    expect(registeredNames()).not.toContain("empty-requires");
  });

  test("does not synthesize a provides field", async () => {
    const dir = freshPluginDir("no-provides");
    writePackageJson(dir, { name: "no-provides", version: "0.1.0" });

    await loadExternalPlugin(dir);

    const registered = getRegisteredPlugins().find(
      (p) => p.manifest.name === "no-provides",
    );
    expect(registered?.manifest.provides).toBeUndefined();
  });

  test("malformed package.json is logged and skipped (registry untouched)", async () => {
    const dir = freshPluginDir("malformed-pkg");
    writeFileSync(join(dir, "package.json"), "{ this is not json");

    await loadExternalPlugin(dir);

    expect(registeredNames()).toHaveLength(0);
  });

  test("package.json missing name is logged and skipped", async () => {
    const dir = freshPluginDir("no-name");
    writePackageJson(dir, { version: "1.0.0" });

    await loadExternalPlugin(dir);

    expect(registeredNames()).toHaveLength(0);
  });

  test("empty string name is logged and skipped", async () => {
    const dir = freshPluginDir("empty-name");
    writePackageJson(dir, { name: "", version: "1.0.0" });

    await loadExternalPlugin(dir);

    expect(registeredNames()).toHaveLength(0);
  });
});

describe("loadExternalPlugin — hooks", () => {
  test("wires hooks/init.ts default export to plugin.hooks.init", async () => {
    const dir = freshPluginDir("with-init");
    writePackageJson(dir, { name: "with-init", version: "0.1.0" });
    writeSurfaceFile(
      dir,
      "hooks/init.ts",
      `export default async function init(_ctx: unknown): Promise<void> {
  (globalThis as Record<string, unknown>).__externalInitCalled = true;
}
`,
    );

    await loadExternalPlugin(dir);

    const registered = getRegisteredPlugins().find(
      (p) => p.manifest.name === "with-init",
    );
    expect(typeof registered?.hooks?.init).toBe("function");
    await registered?.hooks?.init?.({} as never);
    expect(
      (globalThis as Record<string, unknown>).__externalInitCalled,
    ).toBe(true);
    delete (globalThis as Record<string, unknown>).__externalInitCalled;
  });

  test("wires hooks/shutdown.ts default export to plugin.hooks.shutdown", async () => {
    const dir = freshPluginDir("with-shutdown");
    writePackageJson(dir, { name: "with-shutdown", version: "0.1.0" });
    writeSurfaceFile(
      dir,
      "hooks/shutdown.ts",
      `export default async function shutdown(ctx: { assistantVersion: string }): Promise<void> {
  (globalThis as Record<string, unknown>).__externalShutdownCalled = true;
  (globalThis as Record<string, unknown>).__externalShutdownVersion =
    ctx.assistantVersion;
}
`,
    );

    await loadExternalPlugin(dir);

    const registered = getRegisteredPlugins().find(
      (p) => p.manifest.name === "with-shutdown",
    );
    expect(typeof registered?.hooks?.shutdown).toBe("function");
    await registered?.hooks?.shutdown?.({ assistantVersion: "9.9.9-test" });
    expect(
      (globalThis as Record<string, unknown>).__externalShutdownCalled,
    ).toBe(true);
    expect(
      (globalThis as Record<string, unknown>).__externalShutdownVersion,
    ).toBe("9.9.9-test");
    delete (globalThis as Record<string, unknown>).__externalShutdownCalled;
    delete (globalThis as Record<string, unknown>).__externalShutdownVersion;
  });

  test("ignores hooks/*.d.ts declaration files alongside hooks/*.js", async () => {
    // Compiled plugins ship `init.js` + `init.d.ts` side-by-side. The walker
    // must filter the declaration files out — they have no default-exported
    // runtime function, and crashing `importDefault` would skip the plugin
    // wholesale. Regression guard for the .d.ts ingest bug fixed in this PR.
    const dir = freshPluginDir("with-dts");
    writePackageJson(dir, { name: "with-dts", version: "0.1.0" });
    writeSurfaceFile(
      dir,
      "hooks/init.js",
      `export default async function init(_ctx) {
  (globalThis).__externalDtsInitCalled = true;
}
`,
    );
    writeSurfaceFile(
      dir,
      "hooks/init.d.ts",
      `export default function init(ctx: unknown): Promise<void>;\n`,
    );

    await loadExternalPlugin(dir);

    const registered = getRegisteredPlugins().find(
      (p) => p.manifest.name === "with-dts",
    );
    expect(registered).toBeDefined();
    expect(Object.keys(registered?.hooks ?? {})).toEqual(["init"]);
    expect(typeof registered?.hooks?.init).toBe("function");
    await registered?.hooks?.init?.({} as never);
    expect((globalThis as Record<string, unknown>).__externalDtsInitCalled).toBe(
      true,
    );
    delete (globalThis as Record<string, unknown>).__externalDtsInitCalled;
  });

  test("plugin.hooks is undefined when neither hook file is present", async () => {
    const dir = freshPluginDir("no-hooks");
    writePackageJson(dir, { name: "no-hooks", version: "0.1.0" });

    await loadExternalPlugin(dir);

    const registered = getRegisteredPlugins().find(
      (p) => p.manifest.name === "no-hooks",
    );
    expect(registered?.hooks).toBeUndefined();
  });

  test("hooks/init.ts with no default export is logged and skipped", async () => {
    const dir = freshPluginDir("init-no-default");
    writePackageJson(dir, { name: "init-no-default", version: "0.1.0" });
    writeSurfaceFile(
      dir,
      "hooks/init.ts",
      `export const init = async () => undefined;\n`,
    );

    await loadExternalPlugin(dir);

    expect(registeredNames()).toHaveLength(0);
  });

  test("hooks/init.ts default export not a function is logged and skipped", async () => {
    const dir = freshPluginDir("init-not-fn");
    writePackageJson(dir, { name: "init-not-fn", version: "0.1.0" });
    writeSurfaceFile(
      dir,
      "hooks/init.ts",
      `export default { not: "a function" };\n`,
    );

    await loadExternalPlugin(dir);

    expect(registeredNames()).toHaveLength(0);
  });
});

describe("loadExternalPlugin — tools", () => {
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

    await loadExternalPlugin(dir);

    const registered = getRegisteredPlugins().find(
      (p) => p.manifest.name === "two-tools",
    );
    const names = (registered?.tools ?? []).map(
      (t) => (t as { name: string }).name,
    );
    expect(names).toEqual(["two_tools_alpha", "two_tools_beta"]);
  });

  test("plugin.tools is undefined when tools/ is absent", async () => {
    const dir = freshPluginDir("no-tools");
    writePackageJson(dir, { name: "no-tools", version: "0.1.0" });

    await loadExternalPlugin(dir);

    const registered = getRegisteredPlugins().find(
      (p) => p.manifest.name === "no-tools",
    );
    expect(registered?.tools).toBeUndefined();
  });

  test("a tool file with no default export is logged and skipped", async () => {
    const dir = freshPluginDir("tool-no-default");
    writePackageJson(dir, { name: "tool-no-default", version: "0.1.0" });
    writeSurfaceFile(
      dir,
      "tools/broken.ts",
      `export const broken = { name: "broken" };\n`,
    );

    await loadExternalPlugin(dir);

    expect(registeredNames()).toHaveLength(0);
  });

  test("a tool default export missing string name is logged and skipped", async () => {
    const dir = freshPluginDir("tool-no-name");
    writePackageJson(dir, { name: "tool-no-name", version: "0.1.0" });
    writeSurfaceFile(
      dir,
      "tools/nameless.ts",
      `export default { description: "missing name" };\n`,
    );

    await loadExternalPlugin(dir);

    expect(registeredNames()).toHaveLength(0);
  });
});

describe("loadExternalPlugin — isolation", () => {
  test("never throws when a load fails — error is logged and skipped", async () => {
    const dir = freshPluginDir("definitely-broken");
    writeFileSync(join(dir, "package.json"), "{ broken");

    await expect(loadExternalPlugin(dir)).resolves.toBeUndefined();
    expect(registeredNames()).toHaveLength(0);
  });

  test("times out and skips when build exceeds the timeout", async () => {
    // hooks/init.ts has a top-level await that never resolves. The build
    // hangs on dynamic-importing this surface file; the loader's timeout
    // must rescue the daemon boot.
    const dir = freshPluginDir("hanging-init");
    writePackageJson(dir, { name: "hanging-init", version: "0.1.0" });
    writeSurfaceFile(
      dir,
      "hooks/init.ts",
      `await new Promise(() => {});
export default async function init(_ctx: unknown): Promise<void> {}
`,
    );

    await loadExternalPlugin(dir, { importTimeoutMs: 50 });

    expect(registeredNames()).not.toContain("hanging-init");
  });
});

describe("loadExternalPlugin — end-to-end @vellumai/simple-memory", () => {
  test("loads the in-tree simple-memory plugin", async () => {
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

    await loadExternalPlugin(pluginDir);

    const registered = getRegisteredPlugins().find(
      (p) => p.manifest.name === "simple-memory",
    );
    expect(registered).toBeDefined();
    expect(typeof registered?.hooks?.init).toBe("function");
    expect(typeof registered?.hooks?.shutdown).toBe("function");
    const toolNames = (registered?.tools ?? [])
      .map((t) => (t as { name: string }).name)
      .sort();
    expect(toolNames).toEqual([
      "simple_memory_recall",
      "simple_memory_remember",
    ]);
  });
});
