/**
 * Tests for per-chat plugin scope (`enabledPlugins`) filtering at the runtime
 * injector and lifecycle-hook gather sites.
 *
 * A conversation may restrict which plugins' capabilities it uses. That scope
 * is expressed as an effective-enabled-plugin Set (see
 * `getEffectiveEnabledPluginSet` in `daemon/conversation-tool-setup.ts`): a
 * non-null Set is an allowlist, `null` means no restriction. This suite locks
 * the contract that both gather sites honor it:
 *  - `getRegisteredInjectors(set)` excludes injectors from plugins outside the
 *    set, and is unchanged for `null`/omitted.
 *  - `getHooksFor(name, set)` excludes in-process default-plugin hooks outside
 *    the set, and is unchanged for `null`/omitted.
 *  - `collectUserHooks(name, dirs, set)` excludes user-land plugin hooks outside
 *    the set, while standalone workspace hooks (not owned by a plugin) still run.
 *
 * The per-chat scope layers on top of (does not replace) the global
 * `.disabled` sentinel check — a plugin excluded by either is excluded.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { collectUserHooks } from "../hooks/hook-loader.js";
import { getHooksFor } from "../hooks/registry.js";
import {
  clearInjectorRegistry,
  getRegisteredInjectors,
  registerPluginInjectors,
} from "../plugins/injector-registry.js";
import {
  registerPlugin,
  resetPluginRegistryForTests,
} from "../plugins/registry.js";
import type { HookFunction, Injector, Plugin } from "../plugins/types.js";

// Point the workspace at an empty temp dir so `getHooksFor` -> `getUserHooksFor`
// finds no user-land plugins; the in-process hook tests then observe only the
// hooks registered through `registerPlugin`.
const TEST_WORKSPACE_DIR = join(
  tmpdir(),
  `vellum-plugin-effective-set-${process.pid}-${Date.now()}`,
);
process.env.VELLUM_WORKSPACE_DIR = TEST_WORKSPACE_DIR;

function injector(name: string, order: number): Injector {
  return { name, order, produce: () => Promise.resolve(null) };
}

function buildPlugin(
  name: string,
  hooks: Record<string, HookFunction>,
): Plugin {
  return { manifest: { name, version: "1.0.0" }, hooks };
}

describe("getRegisteredInjectors per-chat plugin scope", () => {
  beforeEach(() => clearInjectorRegistry());
  afterEach(() => clearInjectorRegistry());

  test("null set runs every globally-enabled plugin's injectors (unchanged)", () => {
    registerPluginInjectors("plugin-a", [injector("inj-a", 1)]);
    registerPluginInjectors("plugin-b", [injector("inj-b", 2)]);

    const namesNull = getRegisteredInjectors(null).map((i) => i.name);
    const namesOmitted = getRegisteredInjectors().map((i) => i.name);

    expect(namesNull).toEqual(["inj-a", "inj-b"]);
    expect(namesOmitted).toEqual(["inj-a", "inj-b"]);
  });

  test("a set excluding plugin b drops b's injectors and keeps a's", () => {
    registerPluginInjectors("plugin-a", [injector("inj-a", 1)]);
    registerPluginInjectors("plugin-b", [injector("inj-b", 2)]);

    const names = getRegisteredInjectors(new Set(["plugin-a"])).map(
      (i) => i.name,
    );

    expect(names).toEqual(["inj-a"]);
  });

  test("an empty set excludes every plugin's injectors", () => {
    registerPluginInjectors("plugin-a", [injector("inj-a", 1)]);
    registerPluginInjectors("plugin-b", [injector("inj-b", 2)]);

    expect(getRegisteredInjectors(new Set<string>())).toEqual([]);
  });
});

describe("getHooksFor per-chat plugin scope (in-process default hooks)", () => {
  beforeEach(() => resetPluginRegistryForTests());
  afterEach(() => resetPluginRegistryForTests());

  test("null/omitted set runs both plugins' hooks (unchanged)", async () => {
    registerPlugin(
      buildPlugin("default-a", {
        "user-prompt-submit": () => Promise.resolve(),
      }),
    );
    registerPlugin(
      buildPlugin("default-b", {
        "user-prompt-submit": () => Promise.resolve(),
      }),
    );

    expect(await getHooksFor("user-prompt-submit")).toHaveLength(2);
    expect(await getHooksFor("user-prompt-submit", null)).toHaveLength(2);
  });

  test("a set excluding plugin b drops b's hooks and keeps a's", async () => {
    let aRan = 0;
    let bRan = 0;
    registerPlugin(
      buildPlugin("default-a", {
        "user-prompt-submit": () => {
          aRan++;
          return Promise.resolve();
        },
      }),
    );
    registerPlugin(
      buildPlugin("default-b", {
        "user-prompt-submit": () => {
          bRan++;
          return Promise.resolve();
        },
      }),
    );

    const hooks = await getHooksFor(
      "user-prompt-submit",
      new Set(["default-a"]),
    );
    expect(hooks).toHaveLength(1);

    // The surviving hook is a's, not b's.
    await hooks[0]!({});
    expect(aRan).toBe(1);
    expect(bRan).toBe(0);
  });

  test("an empty set excludes every plugin's hooks", async () => {
    registerPlugin(
      buildPlugin("default-a", {
        "user-prompt-submit": () => Promise.resolve(),
      }),
    );
    expect(
      await getHooksFor("user-prompt-submit", new Set<string>()),
    ).toHaveLength(0);
  });
});

describe("collectUserHooks per-chat plugin scope (user-land hooks)", () => {
  let root: string;
  let counter = 0;

  beforeEach(() => {
    root = join(
      tmpdir(),
      `vellum-userhooks-${process.pid}-${Date.now()}-${counter++}`,
    );
    mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function pluginDirWithHook(name: string): string {
    const dir = join(root, name);
    const hooksDir = join(dir, "hooks");
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(
      join(hooksDir, "user-prompt-submit.ts"),
      "export default () => ({});\n",
    );
    return dir;
  }

  test("null set runs both user plugins' hooks (unchanged)", async () => {
    const dirs: Array<readonly [string, string]> = [
      [pluginDirWithHook("uplug-a"), "uplug-a"],
      [pluginDirWithHook("uplug-b"), "uplug-b"],
    ];

    expect(await collectUserHooks("user-prompt-submit", dirs)).toHaveLength(2);
    expect(
      await collectUserHooks("user-prompt-submit", dirs, null),
    ).toHaveLength(2);
  });

  test("a set excluding plugin b drops b's user-land hook", async () => {
    const dirs: Array<readonly [string, string]> = [
      [pluginDirWithHook("uplug-a"), "uplug-a"],
      [pluginDirWithHook("uplug-b"), "uplug-b"],
    ];

    expect(
      await collectUserHooks("user-prompt-submit", dirs, new Set(["uplug-a"])),
    ).toHaveLength(1);
  });
});
