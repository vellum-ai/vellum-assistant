/**
 * Tests for {@link detectPluginSurfaces}.
 *
 * Surface detection is a pure walk of an installed plugin's on-disk tree, so
 * the fixtures materialize the `hooks/`, `tools/`, and `skills/` directory
 * conventions in a real temp dir and assert the derived listing matches what
 * the runtime loader / skills catalog would discover.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { detectPluginSurfaces } from "../plugin-surfaces.js";

let pluginDir: string;

beforeEach(() => {
  pluginDir = mkdtempSync(join(tmpdir(), "plugin-surfaces-"));
});

afterEach(() => {
  rmSync(pluginDir, { recursive: true, force: true });
});

/** Create `<pluginDir>/<rel>` with empty contents, making parents as needed. */
function touch(rel: string): void {
  const path = join(pluginDir, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "");
}

describe("detectPluginSurfaces", () => {
  test("lists hooks, tools, and skills from the directory conventions", () => {
    // GIVEN a plugin shipping two hooks, one tool, and two skills
    touch("hooks/post-model-call.ts");
    touch("hooks/init.ts");
    touch("tools/summarize.ts");
    touch("skills/first-skill/SKILL.md");
    touch("skills/second-skill/SKILL.md");

    // WHEN its surfaces are detected
    const surfaces = detectPluginSurfaces(pluginDir);

    // THEN each surface type lists its items, sorted
    expect(surfaces.hooks).toEqual(["init", "post-model-call"]);
    expect(surfaces.tools).toEqual(["summarize"]);
    expect(surfaces.skills).toEqual(["first-skill", "second-skill"]);
  });

  test("omits surface types the plugin does not contribute", () => {
    // GIVEN a plugin that ships only a hook
    touch("hooks/post-model-call.ts");

    // WHEN its surfaces are detected
    const surfaces = detectPluginSurfaces(pluginDir);

    // THEN the contributed type is listed and the others are empty
    expect(surfaces.hooks).toEqual(["post-model-call"]);
    expect(surfaces.tools).toEqual([]);
    expect(surfaces.skills).toEqual([]);
  });

  test("prefers .js over .ts for the same basename and skips .d.ts declarations", () => {
    // GIVEN a compiled hook shipping both .ts and .js plus a .d.ts declaration
    touch("hooks/post-model-call.ts");
    touch("hooks/post-model-call.js");
    touch("hooks/post-model-call.d.ts");

    // WHEN its surfaces are detected
    const surfaces = detectPluginSurfaces(pluginDir);

    // THEN the basename appears once and the declaration file is ignored
    expect(surfaces.hooks).toEqual(["post-model-call"]);
  });

  test("ignores skill directories without a SKILL.md", () => {
    // GIVEN a skills dir with one real skill and one stray subdirectory
    touch("skills/real-skill/SKILL.md");
    touch("skills/not-a-skill/README.md");

    // WHEN its surfaces are detected
    const surfaces = detectPluginSurfaces(pluginDir);

    // THEN only the directory carrying a SKILL.md is reported
    expect(surfaces.skills).toEqual(["real-skill"]);
  });

  test("returns empty surfaces for a plugin with no surface directories", () => {
    // GIVEN a plugin tree with only a package.json
    touch("package.json");

    // WHEN its surfaces are detected
    const surfaces = detectPluginSurfaces(pluginDir);

    // THEN every surface type is empty
    expect(surfaces).toEqual({ skills: [], hooks: [], tools: [] });
  });
});
