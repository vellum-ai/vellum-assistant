/**
 * Tests for per-chat plugin scope (`enabledPlugins`) filtering at the
 * lifecycle-hook gather sites.
 *
 * A conversation may restrict which plugins' capabilities it uses. That scope
 * is expressed as an effective-enabled-plugin Set (see
 * `getEffectiveEnabledPluginSet` in `daemon/conversation-tool-setup.ts`): a
 * non-null Set is an allowlist, `null` means no restriction. This suite locks
 * the contract that the hook gather sites honor it:
 *  - `getHooksFor(name, { conversationId })` resolves the conversation's scope
 *    and excludes in-process default-plugin hooks outside it; omitting the
 *    conversationId imposes no restriction.
 *  - `collectUserHookEntries(name, dirs, set)` excludes user-land plugin hooks
 *    outside the set, while standalone workspace hooks (not owned by a plugin)
 *    still run.
 *
 * The per-chat scope layers on top of (does not replace) the global
 * `.disabled` sentinel check — a plugin excluded by either is excluded.
 * Injectors are intentionally NOT per-chat scoped (see
 * `getRegisteredInjectors`): they run inside already-scoped plugin hooks, and
 * every injector-contributing plugin is a first-party default.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// `getHooksFor` resolves the per-chat scope from a conversationId via this
// module; stub it so the hook tests can drive the effective set directly.
const resolveScopeMock = mock(
  (_conversationId: string): Set<string> | null => null,
);
mock.module("../daemon/conversation-plugin-scope.js", () => ({
  resolveConversationPluginScope: (id: string) => resolveScopeMock(id),
}));

import {
  collectUserHookEntries,
  resetHookCacheForTests,
} from "../hooks/hook-loader.js";
import { getHooksFor } from "../hooks/registry.js";
import {
  registerPlugin,
  resetPluginRegistryForTests,
} from "../plugins/registry.js";
import type { HookFunction, Plugin } from "../plugins/types.js";
import { getWorkspacePluginsDir } from "../util/platform.js";

// Point the workspace at an empty temp dir so `getHooksFor` -> `getUserHooksFor`
// finds no user-land plugins; the in-process hook tests then observe only the
// hooks registered through `registerPlugin`.
const TEST_WORKSPACE_DIR = join(
  tmpdir(),
  `vellum-plugin-effective-set-${process.pid}-${Date.now()}`,
);
process.env.VELLUM_WORKSPACE_DIR = TEST_WORKSPACE_DIR;

function buildPlugin(
  name: string,
  hooks: Record<string, HookFunction>,
): Plugin {
  return { manifest: { name, version: "1.0.0" }, hooks };
}

describe("getHooksFor per-chat plugin scope (in-process default hooks)", () => {
  beforeEach(() => {
    resetPluginRegistryForTests();
    resolveScopeMock.mockReset();
    resolveScopeMock.mockImplementation(() => null);
  });
  afterEach(() => resetPluginRegistryForTests());

  test("no conversationId (or an unrestricted one) runs both plugins' hooks", async () => {
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

    // No conversationId → the resolver is never consulted.
    expect(await getHooksFor("user-prompt-submit")).toHaveLength(2);
    expect(resolveScopeMock).not.toHaveBeenCalled();
    // A conversationId whose scope resolves to null (no restriction).
    expect(
      await getHooksFor("user-prompt-submit", { conversationId: "c1" }),
    ).toHaveLength(2);
  });

  test("a scope excluding plugin b drops b's hooks and keeps a's", async () => {
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
    resolveScopeMock.mockImplementation(() => new Set(["default-a"]));

    const hooks = await getHooksFor("user-prompt-submit", {
      conversationId: "c1",
    });
    expect(hooks).toHaveLength(1);
    expect(resolveScopeMock).toHaveBeenCalledWith("c1");

    // The surviving hook is a's, not b's.
    await hooks[0]!({});
    expect(aRan).toBe(1);
    expect(bRan).toBe(0);
  });

  test("an empty scope excludes every plugin's hooks", async () => {
    registerPlugin(
      buildPlugin("default-a", {
        "user-prompt-submit": () => Promise.resolve(),
      }),
    );
    resolveScopeMock.mockImplementation(() => new Set<string>());
    expect(
      await getHooksFor("user-prompt-submit", { conversationId: "c1" }),
    ).toHaveLength(0);
  });
});

describe("collectUserHookEntries per-chat plugin scope (user-land hooks)", () => {
  const pluginsDir = getWorkspacePluginsDir();

  beforeEach(() => {
    resetHookCacheForTests();
    rmSync(pluginsDir, { recursive: true, force: true });
    mkdirSync(pluginsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(pluginsDir, { recursive: true, force: true });
  });

  // `collectUserHookEntries` takes plugin *names* and derives each owner's
  // hooks directory as `<workspace>/plugins/<name>/hooks` — the same layout the
  // installer enforces — so the fixture lays files down there and returns the
  // name. Each hook resolves lazily on its first read, so the fixture only has
  // to write the file; the read fills the cache.
  function pluginWithHook(name: string): string {
    const hooksDir = join(pluginsDir, name, "hooks");
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(
      join(hooksDir, "user-prompt-submit.ts"),
      "export default () => ({});\n",
    );
    return name;
  }

  test("null set runs both user plugins' hooks (unchanged)", async () => {
    const names = [pluginWithHook("uplug-a"), pluginWithHook("uplug-b")];

    expect(
      await collectUserHookEntries("user-prompt-submit", names),
    ).toHaveLength(2);
    expect(
      await collectUserHookEntries("user-prompt-submit", names, null),
    ).toHaveLength(2);
  });

  test("a set excluding plugin b drops b's user-land hook", async () => {
    const names = [pluginWithHook("uplug-a"), pluginWithHook("uplug-b")];

    expect(
      await collectUserHookEntries(
        "user-prompt-submit",
        names,
        new Set(["uplug-a"]),
      ),
    ).toHaveLength(1);
  });
});
