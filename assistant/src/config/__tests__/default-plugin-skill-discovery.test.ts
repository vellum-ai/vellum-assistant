/**
 * Tests for default-plugin resident skill discovery.
 *
 * A default plugin ships inside the assistant's own source tree
 * (`plugins/defaults/<dir>/`) rather than under `<workspaceDir>/plugins/`, so
 * its `skills/` directory is enumerated from the compiled-in tree. The walk
 * takes its roots as an argument so these tests can drive it against a temp
 * tree instead of adding fixture plugins to `src/`.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { getDefaultPluginSkillRoots } from "../../plugins/defaults/main.js";
import { getWorkspacePluginsDir } from "../../util/platform.js";
import {
  discoverDefaultPluginResidentSkills,
  discoverPluginResidentSkills,
  mergePluginResidentSkills,
} from "../skills.js";

let tempRoot: string;

/**
 * Create `<tempRoot>/<dirName>/skills/<id>/SKILL.md` for each skill and return
 * the root descriptor the discovery walk consumes.
 */
function defaultPluginRoot(
  dirName: string,
  skills: Array<{ id: string; skillMd?: string }>,
): { pluginName: string; skillsDir: string } {
  const skillsDir = join(tempRoot, dirName, "skills");
  for (const skill of skills) {
    const skillDir = join(skillsDir, skill.id);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      skill.skillMd ??
        `---\nname: ${skill.id}\ndescription: Description for ${skill.id}.\n---\n\nBody for ${skill.id}.\n`,
    );
  }
  return { pluginName: `default-${dirName}`, skillsDir };
}

/** Install a workspace plugin shipping the given skills. */
function writeWorkspacePlugin(dirName: string, skillIds: string[]): void {
  const pluginDir = join(getWorkspacePluginsDir(), dirName);
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(
    join(pluginDir, "package.json"),
    JSON.stringify({ name: dirName, version: "1.0.0" }),
  );
  for (const id of skillIds) {
    const skillDir = join(pluginDir, "skills", id);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---\nname: ${id}\ndescription: Workspace plugin copy of ${id}.\n---\n\nBody.\n`,
    );
  }
}

/** Write the `.disabled` sentinel the CLI writes for `pluginName`. */
function disablePlugin(pluginName: string): void {
  const dir = join(getWorkspacePluginsDir(), pluginName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".disabled"), "");
}

describe("default plugin resident skills", () => {
  beforeEach(() => {
    const pluginsDir = getWorkspacePluginsDir();
    if (existsSync(pluginsDir)) {
      rmSync(pluginsDir, { recursive: true, force: true });
    }
    tempRoot = mkdtempSync(join(tmpdir(), "default-plugin-skills-"));
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test("surfaces a default plugin's resident skill, owned by its default- name", () => {
    const root = defaultPluginRoot("fixture", [{ id: "qa-fixture-skill" }]);

    const skills = discoverDefaultPluginResidentSkills([root]);

    expect(skills).toHaveLength(1);
    expect(skills[0]!.id).toBe("qa-fixture-skill");
    expect(skills[0]!.source).toBe("plugin");
    expect(skills[0]!.owner).toEqual({
      kind: "plugin",
      id: "default-fixture",
    });
    expect(skills[0]!.description).toBe("Description for qa-fixture-skill.");
  });

  test("hides a default plugin's skills when the plugin is disabled", () => {
    const root = defaultPluginRoot("fixture", [{ id: "qa-fixture-skill" }]);
    disablePlugin("default-fixture");

    expect(discoverDefaultPluginResidentSkills([root])).toEqual([]);
  });

  test("an installed plugin's skill of the same id overrides the default one", () => {
    const root = defaultPluginRoot("fixture", [
      { id: "qa-shared-skill" },
      { id: "qa-default-only" },
    ]);
    writeWorkspacePlugin("installed-fixture", ["qa-shared-skill"]);

    // The installed side comes from the real zero-arg discovery (the shipped
    // defaults tree contributes nothing), the default side from the fixture.
    const skills = mergePluginResidentSkills(
      discoverDefaultPluginResidentSkills([root]),
      discoverPluginResidentSkills(),
    );
    const shared = skills.filter((skill) => skill.id === "qa-shared-skill");

    expect(shared).toHaveLength(1);
    expect(shared[0]!.owner).toEqual({
      kind: "plugin",
      id: "installed-fixture",
    });
    // The default plugin's other skills are unaffected by the override.
    expect(
      skills.find((skill) => skill.id === "qa-default-only")?.owner,
    ).toEqual({ kind: "plugin", id: "default-fixture" });
  });

  test("skips a malformed SKILL.md and still surfaces its valid siblings", () => {
    const root = defaultPluginRoot("fixture", [
      { id: "qa-malformed-skill", skillMd: "No frontmatter here.\n" },
      { id: "qa-missing-description", skillMd: "---\nname: x\n---\n\nBody.\n" },
      { id: "qa-valid-skill" },
    ]);

    const skills = discoverDefaultPluginResidentSkills([root]);

    expect(skills.map((skill) => skill.id)).toEqual(["qa-valid-skill"]);
  });

  test("getDefaultPluginSkillRoots reports no roots until a default plugin ships skills", () => {
    // Every root it reports must be a `default-`-prefixed plugin name; today no
    // default plugin ships a `skills/` directory, so the set is empty.
    for (const root of getDefaultPluginSkillRoots()) {
      expect(root.pluginName).toMatch(/^default-[a-z0-9-]+$/);
    }
    expect(getDefaultPluginSkillRoots()).toEqual([]);
  });
});
