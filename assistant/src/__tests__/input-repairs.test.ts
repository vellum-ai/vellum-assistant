import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import type { SkillToolEntry } from "../config/skills.js";
import {
  bundledToolInputAliases,
  bundledToolInputRepairs,
} from "../tools/shared/input-repairs.js";

const TOOL = "scaffold_managed_skill";
const FIND_TOOL = "find_similar_skills";

/** The real manifest entries the repairs describe. */
function manifestEntry(name: string): SkillToolEntry {
  const manifest = JSON.parse(
    readFileSync(
      join(
        import.meta.dir,
        "../config/bundled-skills/skill-management/TOOLS.json",
      ),
      "utf-8",
    ),
  ) as { tools: SkillToolEntry[] };
  const entry = manifest.tools.find((t) => t.name === name);
  if (!entry) {
    throw new Error(`${name} is missing from the skill-management TOOLS.json`);
  }
  return entry;
}

function declaredProperties(name: string): Record<string, { type?: string }> {
  const schema = manifestEntry(name).input_schema as {
    properties: Record<string, { type?: string }>;
  };
  return schema.properties;
}

describe("bundledToolInputRepairs: parameter aliases", () => {
  test("reads `body` as the declared `body_markdown`", () => {
    const result = bundledToolInputRepairs(TOOL, {
      skill_id: "deploy",
      body: "# Deploy\n",
    });
    expect(result).toEqual({ skill_id: "deploy", body_markdown: "# Deploy\n" });
    expect("body" in result).toBe(false);
  });

  test("never overwrites a call that spells the parameter correctly", () => {
    const input = { body: "alias", body_markdown: "declared" };
    const result = bundledToolInputRepairs(TOOL, input);
    expect(result).toBe(input);
  });

  test("leaves a tool with no alias table alone", () => {
    const input = { body: "# Deploy\n" };
    expect(bundledToolInputRepairs("file_write", input)).toBe(input);
  });

  test.each([TOOL, FIND_TOOL])(
    "%s: no alias shadows a parameter the tool declares",
    (tool) => {
      const declared = declaredProperties(tool);
      const aliases = bundledToolInputAliases(tool);
      expect(aliases.length).toBeGreaterThan(0);
      for (const alias of aliases) {
        expect(declared[alias]).toBeUndefined();
      }
    },
  );

  test.each([TOOL, FIND_TOOL])(
    "%s: every alias targets a parameter the tool declares",
    (tool) => {
      const declared = declaredProperties(tool);
      for (const alias of bundledToolInputAliases(tool)) {
        const result = bundledToolInputRepairs(tool, { [alias]: "value" });
        const target = Object.keys(result).find((key) => key !== alias);
        expect(target).toBeDefined();
        expect(declared[target!]).toBeDefined();
      }
    },
  );

  test.each([
    ["title", "name"],
    ["summary", "description"],
    ["content", "body_markdown"],
  ])("reads `%s` as `%s`", (alias, canonical) => {
    const result = bundledToolInputRepairs(TOOL, { [alias]: "value" });
    expect(result).toEqual({ [canonical]: "value" });
  });

  test.each(["description", "query"])(
    "find_similar_skills reads `%s` as `goal`",
    (alias) => {
      const result = bundledToolInputRepairs(FIND_TOOL, {
        [alias]: "deploy staging",
      });
      expect(result).toEqual({ goal: "deploy staging" });
    },
  );
});

describe("bundledToolInputRepairs: files written as a path-keyed map", () => {
  test("reads string values as each file's contents", () => {
    const result = bundledToolInputRepairs(TOOL, {
      files: {
        "references/failure-modes.md": "The retry loop stalls.",
        "scripts/run.sh": "echo hi",
      },
    });
    expect(result.files).toEqual([
      {
        path: "references/failure-modes.md",
        content: "The retry loop stalls.",
      },
      { path: "scripts/run.sh", content: "echo hi" },
    ]);
  });

  test("reads an entry that names content or copy_from", () => {
    const result = bundledToolInputRepairs(TOOL, {
      files: {
        "references/notes.md": { content: "hi" },
        "scripts/run.sh": { copy_from: "/tmp/run.sh" },
      },
    });
    expect(result.files).toEqual([
      { path: "references/notes.md", content: "hi" },
      { path: "scripts/run.sh", copy_from: "/tmp/run.sh" },
    ]);
  });

  test("leaves one entry spelling out its own fields, which is a file not a map", () => {
    const input = { files: { path: "references/notes.md", content: "hi" } };
    expect(bundledToolInputRepairs(TOOL, input)).toBe(input);
  });

  test("leaves the whole value when any entry is unreadable", () => {
    const input = {
      files: {
        "references/notes.md": "hi",
        "scripts/run.sh": { mode: 755 },
      },
    };
    expect(bundledToolInputRepairs(TOOL, input)).toBe(input);
  });

  test("leaves a map with a blank path", () => {
    const input = { files: { "   ": "hi" } };
    expect(bundledToolInputRepairs(TOOL, input)).toBe(input);
  });

  test("leaves an empty object", () => {
    const input = { files: {} };
    expect(bundledToolInputRepairs(TOOL, input)).toBe(input);
  });

  test("an entry spelling out every declared file property is read as one file", () => {
    const schema = manifestEntry(TOOL).input_schema as {
      properties: {
        files: { items: { properties: Record<string, unknown> } };
      };
    };
    const declared = Object.keys(schema.properties.files.items.properties);
    expect(declared).toContain("path");
    const entry = Object.fromEntries(declared.map((key) => [key, "value"]));

    const input = { files: entry };
    expect(bundledToolInputRepairs(TOOL, input)).toBe(input);
  });

  test("leaves files that already arrived as an array", () => {
    const input = { files: [{ path: "references/notes.md", content: "hi" }] };
    expect(bundledToolInputRepairs(TOOL, input)).toBe(input);
  });
});

describe("bundledToolInputRepairs: purity", () => {
  test("returns the same object when there is nothing to repair", () => {
    const input = { skill_id: "deploy", body_markdown: "# Deploy\n" };
    expect(bundledToolInputRepairs(TOOL, input)).toBe(input);
  });

  test("returns a new object and never mutates the original input", () => {
    const input = {
      body: "# Deploy\n",
      files: { "references/notes.md": "hi" },
    };
    const snapshot = JSON.parse(JSON.stringify(input));
    const result = bundledToolInputRepairs(TOOL, input);
    expect(result).not.toBe(input);
    expect(input).toEqual(snapshot);
  });

  test("repairs an alias and a files map in the same call", () => {
    const result = bundledToolInputRepairs(TOOL, {
      body: "# Deploy\n",
      files: { "references/notes.md": "hi" },
    });
    expect(result).toEqual({
      body_markdown: "# Deploy\n",
      files: [{ path: "references/notes.md", content: "hi" }],
    });
  });
});
