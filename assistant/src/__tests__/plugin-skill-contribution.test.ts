/**
 * Tests for plugin-contributed skills (PR 33).
 *
 * Covers:
 * - A plugin declaring `skills: [...]` has its entries registered after
 *   bootstrap's `init()` succeeds.
 * - The registered skill is discoverable via `loadSkillCatalog` and
 *   resolvable via `loadSkillBySelector` (the exact entry points the model's
 *   `skill_load` / `skill_execute` flow use).
 * - Shutdown (runShutdownHooks) unregisters the plugin's skills so repeated
 *   bootstraps don't leak catalog entries.
 * - Ref-counted register/unregister semantics match the tool registry's
 *   per-skill-id semantics (PR 13 precedent).
 *
 * Strategy mirrors `plugin-bootstrap.test.ts`: stub the credential store so
 * bootstrap doesn't hit real backends, and `resetPluginRegistryForTests` /
 * `resetPluginSkillContributionsForTests` between cases for isolation.
 */

import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

// Stub credential store before importing bootstrap so the module captures
// the fake binding.
const getSecureKeyAsyncMock = mock(
  async (_account: string): Promise<string | undefined> => undefined,
);
mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: getSecureKeyAsyncMock,
}));

import type { AssistantConfig } from "../config/schema.js";
import { loadSkillBySelector, loadSkillCatalog } from "../config/skills.js";
import {
  bootstrapPlugins,
  type DaemonContext,
} from "../daemon/external-plugins-bootstrap.js";
import { runShutdownHooks } from "../daemon/shutdown-registry.js";
import {
  getPluginContributedSkillDefinition,
  getPluginContributedSkillSummaries,
  getPluginSkillRefCount,
  registerPluginSkills,
  resetPluginSkillContributionsForTests,
  unregisterPluginSkills,
} from "../plugins/plugin-skill-contributions.js";
import {
  registerPlugin,
  resetPluginRegistryForTests,
} from "../plugins/registry.js";
import {
  type Plugin,
  PluginExecutionError,
  type PluginSkillRegistration,
} from "../plugins/types.js";

// Per-process temp tree so bootstrap's plugin-storage directory creation
// doesn't touch the developer's real ~/.vellum.
const TEST_INSTANCE_DIR = join(
  tmpdir(),
  `vellum-plugin-skill-test-${process.pid}`,
);
process.env.BASE_DATA_DIR = TEST_INSTANCE_DIR;

const fakeConfig = {} as unknown as AssistantConfig;
const fakeCtx: DaemonContext = {
  config: fakeConfig,
  assistantVersion: "9.9.9-test",
};

/** Build a plugin that contributes one or more skills. */
function buildSkillPlugin(
  name: string,
  skills: PluginSkillRegistration[],
  extras: Partial<Omit<Plugin, "manifest" | "skills">> = {},
): Plugin {
  return {
    manifest: {
      name,
      version: "0.0.1",
      requires: { pluginRuntime: "v1" },
    },
    skills,
    ...extras,
  };
}

describe("plugin skill contributions", () => {
  beforeEach(async () => {
    resetPluginRegistryForTests();
    resetPluginSkillContributionsForTests();
    getSecureKeyAsyncMock.mockReset();
    getSecureKeyAsyncMock.mockImplementation(async () => undefined);
    await rm(TEST_INSTANCE_DIR, { recursive: true, force: true });
  });

  test("plugin skills are registered after bootstrap and exposed by the catalog", async () => {
    const skill: PluginSkillRegistration = {
      id: "plugin-demo-skill",
      name: "plugin-demo",
      displayName: "Plugin Demo",
      description: "A skill contributed by a plugin",
      body: "# Plugin Demo\n\nThis is the plugin-provided body.",
      activationHints: ["demo", "plugin"],
    };

    registerPlugin(buildSkillPlugin("demo-plugin", [skill]));
    await bootstrapPlugins(fakeCtx);

    // Ref count bumped to exactly 1 so we can tell register and unregister
    // are balanced downstream.
    expect(getPluginSkillRefCount("demo-plugin")).toBe(1);

    // In-memory registry query surfaces the summary form.
    const summaries = getPluginContributedSkillSummaries();
    const registered = summaries.find((s) => s.id === "plugin-demo-skill");
    expect(registered).toBeDefined();
    expect(registered?.source).toBe("plugin");
    expect(registered?.name).toBe("plugin-demo");
    expect(registered?.displayName).toBe("Plugin Demo");
    expect(registered?.activationHints).toEqual(["demo", "plugin"]);
    // Summary must not carry the body — bodies are definition-only.
    expect((registered as unknown as { body?: unknown }).body).toBeUndefined();

    // The full definition is retrievable by id.
    const def = getPluginContributedSkillDefinition("plugin-demo-skill");
    expect(def).toBeDefined();
    expect(def?.body).toContain("This is the plugin-provided body");
  });

  test("catalog and loadSkillBySelector discover plugin-contributed skills (skill_load pathway)", async () => {
    const skill: PluginSkillRegistration = {
      id: "catalog-visible-skill",
      name: "catalog-visible",
      description: "A plugin skill expected to surface in loadSkillCatalog",
      body: "# Catalog-Visible Skill\n\nBody content for skill_load.",
    };

    registerPlugin(buildSkillPlugin("catalog-plugin", [skill]));
    await bootstrapPlugins(fakeCtx);

    // loadSkillCatalog is the exact entry point `skill_load` consults via
    // `loadSkillBySelector` -> `resolveSkillSelector`.
    const catalog = loadSkillCatalog();
    const found = catalog.find((s) => s.id === "catalog-visible-skill");
    expect(found).toBeDefined();
    expect(found?.source).toBe("plugin");
    expect(found?.description).toBe(skill.description);

    // loadSkillBySelector is what SkillLoadTool.execute calls — it must
    // return a fully-populated SkillDefinition, including the body.
    const lookup = loadSkillBySelector("catalog-visible-skill");
    expect(lookup.error).toBeUndefined();
    expect(lookup.skill).toBeDefined();
    expect(lookup.skill?.id).toBe("catalog-visible-skill");
    expect(lookup.skill?.body).toContain("Body content for skill_load");

    // And name-based resolution (what users type when the model picks a
    // skill by name) works the same way.
    const byName = loadSkillBySelector("catalog-visible");
    expect(byName.skill?.id).toBe("catalog-visible-skill");
  });

  test("shutdown unregisters plugin skills so the catalog no longer lists them", async () => {
    const skill: PluginSkillRegistration = {
      id: "ephemeral-skill",
      name: "ephemeral",
      description: "Disappears after shutdown",
      body: "Only visible while the plugin is alive.",
    };

    registerPlugin(buildSkillPlugin("ephemeral-plugin", [skill]));
    await bootstrapPlugins(fakeCtx);

    // Sanity: present before shutdown.
    expect(loadSkillCatalog().some((s) => s.id === "ephemeral-skill")).toBe(
      true,
    );
    expect(getPluginSkillRefCount("ephemeral-plugin")).toBe(1);

    await runShutdownHooks("test-shutdown");

    // After shutdown, the plugin's skill is gone from both the in-memory
    // registry and any catalog view that consults it.
    expect(getPluginSkillRefCount("ephemeral-plugin")).toBe(0);
    expect(
      getPluginContributedSkillDefinition("ephemeral-skill"),
    ).toBeUndefined();

    const catalogAfter = loadSkillCatalog();
    expect(catalogAfter.some((s) => s.id === "ephemeral-skill")).toBe(false);

    // And the selector lookup the model would use fails closed.
    const lookup = loadSkillBySelector("ephemeral-skill");
    expect(lookup.skill).toBeUndefined();
  });

  test("bootstrap is a no-op for plugins without a skills list", async () => {
    // A plugin with no `skills` field must not bump ref counts or
    // populate the catalog at all.
    registerPlugin({
      manifest: {
        name: "no-skills-plugin",
        version: "0.0.1",
        requires: { pluginRuntime: "v1" },
      },
    });

    await bootstrapPlugins(fakeCtx);

    expect(getPluginSkillRefCount("no-skills-plugin")).toBe(0);
    expect(getPluginContributedSkillSummaries()).toEqual([]);
  });

  test("duplicate skill id across plugins fails bootstrap with the plugin named", async () => {
    const shared: PluginSkillRegistration = {
      id: "contested-id",
      name: "contested",
      description: "First",
      body: "from first plugin",
    };
    const duplicate: PluginSkillRegistration = {
      id: "contested-id",
      name: "contested",
      description: "Second",
      body: "from second plugin",
    };

    registerPlugin(buildSkillPlugin("first-plugin", [shared]));
    registerPlugin(buildSkillPlugin("second-plugin", [duplicate]));

    let caught: unknown;
    try {
      await bootstrapPlugins(fakeCtx);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginExecutionError);
    // The error must identify which plugin tripped the collision so
    // operators can deploy a fix.
    const msg = (caught as PluginExecutionError).message;
    expect(msg).toContain("second-plugin");
    expect(msg).toContain("contested-id");
  });

  test("intra-batch duplicate skill id in one plugin is rejected at registration", () => {
    // Directly exercise the registry (no bootstrap) — a single plugin
    // declaring the same id twice is a configuration bug and must fail
    // loudly rather than silently overwrite.
    expect(() =>
      registerPluginSkills("dup-plugin", [
        {
          id: "dup-id",
          name: "one",
          description: "first",
          body: "A",
        },
        {
          id: "dup-id",
          name: "two",
          description: "second",
          body: "B",
        },
      ]),
    ).toThrow(PluginExecutionError);
    expect(() =>
      registerPluginSkills("dup-plugin", [
        { id: "x", name: "one", description: "a", body: "A" },
        { id: "x", name: "two", description: "b", body: "B" },
      ]),
    ).toThrow(/declared skill "x" more than once/);
  });

  test("ref-counted unregister: second unregister call after repeated registers drops skills", () => {
    const registrations: PluginSkillRegistration[] = [
      {
        id: "refcount-skill",
        name: "refcount",
        description: "Ref-count demo",
        body: "stays until the counter hits zero",
      },
    ];

    registerPluginSkills("refcount-plugin", registrations);
    // Second call is the "same plugin registered again" pattern (hot
    // reload). It must bump the counter without re-inserting.
    registerPluginSkills("refcount-plugin", registrations);
    expect(getPluginSkillRefCount("refcount-plugin")).toBe(2);
    expect(getPluginContributedSkillDefinition("refcount-skill")).toBeDefined();

    // One unregister decrements only — skill must still be registered.
    unregisterPluginSkills("refcount-plugin");
    expect(getPluginSkillRefCount("refcount-plugin")).toBe(1);
    expect(getPluginContributedSkillDefinition("refcount-skill")).toBeDefined();

    // Second unregister drops the entry for real.
    unregisterPluginSkills("refcount-plugin");
    expect(getPluginSkillRefCount("refcount-plugin")).toBe(0);
    expect(
      getPluginContributedSkillDefinition("refcount-skill"),
    ).toBeUndefined();

    // Third unregister (over-decrement) is a no-op, not a throw — mirrors
    // the tool-registry behavior so shutdown races don't crash the
    // daemon.
    expect(() => unregisterPluginSkills("refcount-plugin")).not.toThrow();
  });

  test("managed (filesystem) skill with the same id overrides a plugin-contributed skill", async () => {
    // Plugin skills sit below managed/workspace in the catalog precedence
    // chain so a user can shadow a plugin-provided skill by dropping a
    // SKILL.md with the same id under ~/.vellum/workspace/skills. The test
    // harness configures VELLUM_WORKSPACE_DIR via the bun test preload, so
    // we can synthesize a filesystem skill for the same id and assert it
    // wins.
    const { mkdirSync, writeFileSync, rmSync, existsSync } =
      await import("node:fs");

    const workspaceDir = process.env.VELLUM_WORKSPACE_DIR;
    // Skip the filesystem override check when the harness did not provide a
    // workspace dir — the other tests in this file still cover catalog
    // visibility, which is the core of PR 33.
    if (!workspaceDir) {
      return;
    }

    const skillsDir = join(workspaceDir, "skills", "shared-id");
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(
      join(skillsDir, "SKILL.md"),
      [
        "---",
        'name: "filesystem-version"',
        'description: "User-authored override"',
        "---",
        "",
        "# Filesystem Override",
      ].join("\n"),
    );

    const pluginSkill: PluginSkillRegistration = {
      id: "shared-id",
      name: "plugin-version",
      description: "Plugin-provided skill that should be shadowed",
      body: "plugin body",
    };
    registerPlugin(buildSkillPlugin("shadow-plugin", [pluginSkill]));

    try {
      await bootstrapPlugins(fakeCtx);

      const catalog = loadSkillCatalog();
      const entry = catalog.find((s) => s.id === "shared-id");
      // The filesystem SKILL.md wins — source flips to "managed" and the
      // plugin's metadata is not what we see.
      expect(entry).toBeDefined();
      expect(entry?.source).toBe("managed");
      expect(entry?.name).toBe("filesystem-version");
    } finally {
      if (existsSync(skillsDir)) {
        rmSync(skillsDir, { recursive: true, force: true });
      }
    }
  });
});
