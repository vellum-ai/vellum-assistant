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
  test("identity is the directory name; version comes from package.json", async () => {
    // The install directory name is the plugin's identity — not the authored
    // `package.json` `name`, which routinely differs from the install slug.
    const dir = freshPluginDir("minimal");
    writePackageJson(dir, { name: "minimal-plugin", version: "1.2.3" });

    await loadExternalPlugin(dir);

    const registered = getRegisteredPlugins().find(
      (p) => p.manifest.name === "minimal",
    );
    expect(registered).toBeDefined();
    expect(registered?.manifest.version).toBe("1.2.3");
    // The authored package.json name is not used as the identity.
    expect(registeredNames()).not.toContain("minimal-plugin");
  });

  test("identity is the directory name even when package.json name is scoped", async () => {
    const dir = freshPluginDir("scoped");
    writePackageJson(dir, {
      name: "@vellumai/simple-memory",
      version: "0.1.0",
    });

    await loadExternalPlugin(dir);

    expect(registeredNames()).toContain("scoped");
    expect(registeredNames()).not.toContain("simple-memory");
  });

  test("defaults version to 0.0.0 when package.json omits it", async () => {
    const dir = freshPluginDir("no-version");
    writePackageJson(dir, { name: "no-version-plugin" });

    await loadExternalPlugin(dir);

    const registered = getRegisteredPlugins().find(
      (p) => p.manifest.name === "no-version",
    );
    expect(registered).toBeDefined();
    expect(registered?.manifest.version).toBe("0.0.0");
  });
});

describe("loadExternalPlugin — plugin-api peerDependency", () => {
  // Tests anchor against assistantPkg.version (read from the assistant's
  // own package.json) so the matrix below stays correct across version
  // bumps. Constructing a range from the live version + nudging up/down
  // by one keeps the satisfy/un-satisfy cases honest.
  test("loads when peerDependency range satisfies assistant version", async () => {
    const dir = freshPluginDir("compat-ok");
    writePackageJson(dir, {
      name: "compat-ok",
      version: "0.1.0",
      peerDependencies: { "@vellumai/plugin-api": "*" },
    });

    await loadExternalPlugin(dir);

    expect(registeredNames()).toContain("compat-ok");
  });

  test("loads plugin whose peerDependency range excludes assistant version (logs error)", async () => {
    // The host-compat gate is soft while the installation flow is in
    // flux — an unsatisfied range produces a `log.error` but the
    // plugin still loads. Once installation settles, this case should
    // harden back into a hard reject.
    const dir = freshPluginDir("compat-bad");
    writePackageJson(dir, {
      name: "compat-bad",
      version: "0.1.0",
      // A range that no real assistant version will satisfy.
      peerDependencies: { "@vellumai/plugin-api": ">=999.0.0" },
    });

    await loadExternalPlugin(dir);

    expect(registeredNames()).toContain("compat-bad");
  });

  test("loads plugin whose peerDependency range is unparseable (logs error)", async () => {
    // Same soft-gate rationale as the excluded-range case above.
    const dir = freshPluginDir("compat-bogus");
    writePackageJson(dir, {
      name: "compat-bogus",
      version: "0.1.0",
      peerDependencies: { "@vellumai/plugin-api": "not-a-real-range" },
    });

    await loadExternalPlugin(dir);

    expect(registeredNames()).toContain("compat-bogus");
  });

  test("loads with warning when no peerDependency on plugin-api is declared", async () => {
    // Absent peerDep is non-fatal — the loader logs a warn and proceeds
    // with no host-compat claim. The convention is opt-in while the
    // plugin-api framework is experimental.
    const dir = freshPluginDir("compat-absent");
    writePackageJson(dir, {
      name: "compat-absent",
      version: "0.1.0",
    });

    await loadExternalPlugin(dir);

    expect(registeredNames()).toContain("compat-absent");
  });

  test("loads with warning when peerDependencies is present but lacks plugin-api key", async () => {
    const dir = freshPluginDir("compat-other-peer");
    writePackageJson(dir, {
      name: "compat-other-peer",
      version: "0.1.0",
      peerDependencies: { react: "^18.0.0" },
    });

    await loadExternalPlugin(dir);

    expect(registeredNames()).toContain("compat-other-peer");
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
    expect((globalThis as Record<string, unknown>).__externalInitCalled).toBe(
      true,
    );
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
    expect(
      (globalThis as Record<string, unknown>).__externalDtsInitCalled,
    ).toBe(true);
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
  description: "alpha",
  defaultRiskLevel: "low" as const,
  input_schema: { type: "object", properties: {}, required: [] },
  async execute() { return { content: "a", isError: false }; },
};
`,
    );
    writeSurfaceFile(
      dir,
      "tools/beta.ts",
      `export default {
  description: "beta",
  defaultRiskLevel: "low" as const,
  input_schema: { type: "object", properties: {}, required: [] },
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
    expect(names).toEqual(["alpha", "beta"]);
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

  test("a tool default export with missing fields loads with documented defaults", async () => {
    const dir = freshPluginDir("tool-with-defaults");
    writePackageJson(dir, { name: "tool-with-defaults", version: "0.1.0" });
    // The default export is a bare empty object — no description,
    // defaultRiskLevel, input_schema, or execute. The loader must fill
    // each slot with its documented default and still register the plugin.
    writeSurfaceFile(dir, "tools/empty.ts", `export default {};\n`);

    await loadExternalPlugin(dir);

    const registered = getRegisteredPlugins().find(
      (p) => p.manifest.name === "tool-with-defaults",
    );
    expect(registered).toBeDefined();
    const tools = (registered?.tools ?? []) as Array<{
      name: string;
      description: string;
      defaultRiskLevel: string;
      input_schema: Record<string, unknown>;
      execute: (
        input: Record<string, unknown>,
        context: unknown,
      ) => Promise<{ content: string; isError: boolean }>;
    }>;
    expect(tools).toHaveLength(1);
    const empty = tools[0]!;
    expect(empty.name).toBe("empty");
    expect(empty.description).toBe("");
    expect(empty.defaultRiskLevel).toBe("medium");
    expect(empty.input_schema).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    expect(typeof empty.execute).toBe("function");

    const result = await empty.execute({}, {} as unknown);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("empty");
    expect(result.content).toContain("no execute implementation");
  });

  test("a partial tool default export merges author fields with defaults", async () => {
    const dir = freshPluginDir("tool-partial-defaults");
    writePackageJson(dir, {
      name: "tool-partial-defaults",
      version: "0.1.0",
    });
    // Author supplies only description + execute; the loader must default
    // defaultRiskLevel and input_schema while keeping the author's fields.
    writeSurfaceFile(
      dir,
      "tools/partial.ts",
      `export default {
  description: "custom description",
  async execute() {
    return { content: "ran", isError: false };
  },
};
`,
    );

    await loadExternalPlugin(dir);

    const registered = getRegisteredPlugins().find(
      (p) => p.manifest.name === "tool-partial-defaults",
    );
    const tool = (registered?.tools ?? [])[0] as
      | {
          description: string;
          defaultRiskLevel: string;
          input_schema: object;
          execute: (
            input: Record<string, unknown>,
            context: unknown,
          ) => Promise<{ content: string; isError: boolean }>;
        }
      | undefined;
    expect(tool).toBeDefined();
    expect(tool?.description).toBe("custom description");
    expect(tool?.defaultRiskLevel).toBe("medium");
    expect(tool?.input_schema).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    const result = await tool!.execute({}, {} as unknown);
    expect(result.isError).toBe(false);
    expect(result.content).toBe("ran");
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
