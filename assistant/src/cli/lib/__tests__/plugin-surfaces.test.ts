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

/** Create `<pluginDir>/<rel>` with the given contents, making parents as needed. */
function touch(rel: string, content = ""): void {
  const path = join(pluginDir, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

/** A flat schedule declaration body with frontmatter carrying `expression`. */
function flatSchedule(expression: string): string {
  return `---\nexpression: "${expression}"\n---\nDo the thing.\n`;
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

  test("reports tools under their registered name, not the raw filename", () => {
    // GIVEN a tool whose filename is not already a valid tool-name segment
    touch("tools/create-issue.ts");

    // WHEN its surfaces are detected
    const surfaces = detectPluginSurfaces(pluginDir);

    // THEN the derived (registered) name is reported, matching the loader
    expect(surfaces.tools).toEqual(["create_issue"]);
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
    expect(surfaces).toEqual({
      skills: [],
      hooks: [],
      tools: [],
      schedules: [],
    });
  });

  test("lists declared schedules in both forms with cadence and mode", () => {
    // GIVEN a flat markdown declaration and both directory-form entrypoints
    touch("schedules/daily-report.md", flatSchedule("0 9 * * *"));
    touch(
      "schedules/cleanup/config.json",
      '{"expression": "0 0 * * 0", "timezone": "UTC"}',
    );
    touch("schedules/cleanup/index.sh", "#!/bin/sh\necho hi\n");
    touch("schedules/digest/config.json", '{"expression": "0 8 * * 1"}');
    touch("schedules/digest/index.md", "Summarize the week.\n");

    // WHEN its surfaces are detected
    const surfaces = detectPluginSurfaces(pluginDir);

    // THEN each declaration reports its raw expression and entrypoint mode
    expect(surfaces.schedules).toEqual([
      { name: "cleanup", cadence: "0 0 * * 0", mode: "script" },
      { name: "daily-report", cadence: "0 9 * * *", mode: "execute" },
      { name: "digest", cadence: "0 8 * * 1", mode: "execute" },
    ]);
  });

  test("skips a schedule basename declared in both forms", () => {
    // GIVEN the same basename as a flat file and a directory (ambiguous)
    touch("schedules/dupe.md", flatSchedule("0 9 * * *"));
    touch("schedules/dupe/config.json", '{"expression": "0 9 * * *"}');
    touch("schedules/dupe/index.md", "body\n");
    touch("schedules/keeper.md", flatSchedule("30 7 * * *"));

    // WHEN its surfaces are detected
    const surfaces = detectPluginSurfaces(pluginDir);

    // THEN neither ambiguous form is listed, and the sibling still is
    expect(surfaces.schedules).toEqual([
      { name: "keeper", cadence: "30 7 * * *", mode: "execute" },
    ]);
  });

  test("skips schedule declarations the loader would refuse", () => {
    // GIVEN a flat file without frontmatter
    touch("schedules/no-frontmatter.md", "just a body\n");
    // AND a directory with both entrypoints
    touch("schedules/two-entries/config.json", '{"expression": "0 9 * * *"}');
    touch("schedules/two-entries/index.md", "body\n");
    touch("schedules/two-entries/index.sh", "#!/bin/sh\n");
    // AND a directory with an unsupported entrypoint
    touch("schedules/bad-entry/config.json", '{"expression": "0 9 * * *"}');
    touch("schedules/bad-entry/index.py", "print()\n");
    // AND a directory missing its config.json
    touch("schedules/no-config/index.md", "body\n");
    // AND a directory whose config declares no expression
    touch("schedules/no-expression/config.json", '{"timezone": "UTC"}');
    touch("schedules/no-expression/index.md", "body\n");

    // WHEN its surfaces are detected
    // THEN none of them are listed
    expect(detectPluginSurfaces(pluginDir).schedules).toEqual([]);
  });
});
