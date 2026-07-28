/**
 * Tests for plugin-resident skill discovery in `loadSkillCatalog`.
 *
 * The catalog surfaces skills a plugin ships at `plugins/<dir>/skills/<id>/`.
 * The gate is a loadable manifest (parseable `package.json` with a non-empty
 * `name`) — the manifest `name` need NOT equal the install directory name.
 * That match must not be required: a plugin is installed under its marketplace
 * slug or GitHub path leaf, which routinely differs from its `package.json`
 * `name` (e.g. cognee installs to `cognee`/`vellum-assistant` while its package
 * is named `cognee-memory`). Requiring the match silently drops the plugin's
 * skills even though the runtime loads its hooks and tools fine.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";

import { getWorkspacePluginsDir } from "../../util/platform.js";
import { loadSkillCatalog } from "../skills.js";

function writePlugin(
  dirName: string,
  packageName: string,
  skills: Array<{ id: string; description: string }>,
  opts: { disabled?: boolean; packageJson?: string | null } = {},
): void {
  const pluginDir = join(getWorkspacePluginsDir(), dirName);
  mkdirSync(pluginDir, { recursive: true });

  if (opts.packageJson === null) {
    // Intentionally omit package.json.
  } else {
    writeFileSync(
      join(pluginDir, "package.json"),
      opts.packageJson ??
        JSON.stringify({
          name: packageName,
          version: "1.0.0",
          peerDependencies: { "@vellumai/plugin-api": "*" },
        }),
    );
  }

  if (opts.disabled) writeFileSync(join(pluginDir, ".disabled"), "");

  for (const skill of skills) {
    const skillDir = join(pluginDir, "skills", skill.id);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---\nname: ${skill.id}\ndescription: ${skill.description}\n---\n\nBody for ${skill.id}.\n`,
    );
  }
}

function skillById(id: string) {
  return loadSkillCatalog().find((s) => s.id === id);
}

describe("discoverPluginResidentSkills (via loadSkillCatalog)", () => {
  beforeEach(() => {
    const pluginsDir = getWorkspacePluginsDir();
    if (existsSync(pluginsDir))
      rmSync(pluginsDir, { recursive: true, force: true });
  });

  test("surfaces a plugin skill when the install dir name differs from package.json name", () => {
    // dir `vellum-assistant` (GitHub path leaf) vs package `cognee-memory`:
    // the exact cognee shape that was silently dropped before.
    writePlugin("vellum-assistant", "cognee-memory", [
      {
        id: "qa-cognee-sync",
        description: "Sync session memory into the graph.",
      },
    ]);

    const skill = skillById("qa-cognee-sync");
    expect(skill).toBeDefined();
    expect(skill!.source).toBe("plugin");
    // Attribution is the install slug (directory name), which is the identity
    // used by `plugins list` and per-conversation plugin scoping.
    expect(skill!.owner).toEqual({ kind: "plugin", id: "vellum-assistant" });
  });

  test("surfaces a plugin skill when dir name equals package.json name", () => {
    writePlugin("demo-matched", "demo-matched", [
      { id: "qa-matched-skill", description: "A matched-name plugin skill." },
    ]);

    const skill = skillById("qa-matched-skill");
    expect(skill).toBeDefined();
    expect(skill!.owner).toEqual({ kind: "plugin", id: "demo-matched" });
  });

  test("skips a plugin directory that has no package.json", () => {
    writePlugin(
      "no-manifest",
      "unused",
      [{ id: "qa-no-manifest-skill", description: "Should not surface." }],
      { packageJson: null },
    );

    expect(skillById("qa-no-manifest-skill")).toBeUndefined();
  });

  test("skips a plugin directory whose package.json is unparseable", () => {
    writePlugin(
      "bad-manifest",
      "unused",
      [{ id: "qa-bad-manifest-skill", description: "Should not surface." }],
      { packageJson: "{ not valid json" },
    );

    expect(skillById("qa-bad-manifest-skill")).toBeUndefined();
  });

  test("skips a plugin directory whose package.json has no name", () => {
    writePlugin(
      "nameless",
      "unused",
      [{ id: "qa-nameless-skill", description: "Should not surface." }],
      { packageJson: JSON.stringify({ version: "1.0.0" }) },
    );

    expect(skillById("qa-nameless-skill")).toBeUndefined();
  });

  test("hides resident skills of a disabled plugin", () => {
    writePlugin(
      "disabled-plugin",
      "disabled-pkg",
      [{ id: "qa-disabled-skill", description: "Hidden while disabled." }],
      { disabled: true },
    );

    expect(skillById("qa-disabled-skill")).toBeUndefined();
  });
});
