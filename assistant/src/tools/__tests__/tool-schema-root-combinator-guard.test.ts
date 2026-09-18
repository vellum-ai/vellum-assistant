import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

import { parseToolManifestFile } from "../../skills/tool-manifest.js";
import { explicitTools } from "../tool-manifest.js";

/**
 * Tool input schemas must be plain objects at the root.
 *
 * Anthropic's Messages API rejects a tool whose `input_schema` carries
 * `oneOf`, `anyOf`, or `allOf` at the top level ("input_schema does not
 * support oneOf, allOf, or anyOf at the top level"). The rejection is a 400
 * for the whole request, so one offending definition takes down every call
 * that advertises it. Other hosts accept the same schema, which lets the
 * mistake hide until a request routes to Anthropic directly. Either/or rules
 * between fields belong in the tool description and the tool's own input
 * validation instead.
 *
 * Covers the core manifest and every bundled skill's `TOOLS.json`.
 * Combinators nested under `properties` are accepted by Anthropic and stay
 * out of scope.
 */

const ROOT_COMBINATORS = ["oneOf", "anyOf", "allOf"] as const;

const BUNDLED_SKILLS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../config/bundled-skills",
);

interface SchemaCase {
  /** Tool name, prefixed with the skill directory for bundled skill tools. */
  label: string;
  schema: Record<string, unknown>;
}

function bundledSkillSchemas(): SchemaCase[] {
  const cases: SchemaCase[] = [];
  for (const relative of new Bun.Glob("*/TOOLS.json").scanSync({
    cwd: BUNDLED_SKILLS_DIR,
  })) {
    const manifest = parseToolManifestFile(join(BUNDLED_SKILLS_DIR, relative));
    for (const tool of manifest.tools) {
      cases.push({
        label: `${dirname(relative)}/${tool.name}`,
        schema: tool.input_schema,
      });
    }
  }
  return cases;
}

function coreSchemas(): SchemaCase[] {
  return explicitTools.map((tool) => {
    if (!tool.name) {
      throw new Error("core manifest entries carry explicit names");
    }
    return {
      label: tool.name,
      schema: tool.input_schema as Record<string, unknown>,
    };
  });
}

const CASES: SchemaCase[] = [...coreSchemas(), ...bundledSkillSchemas()];

describe("tool input schema root", () => {
  test("covers the core manifest and the bundled skills", () => {
    expect(CASES.length).toBeGreaterThan(explicitTools.length);
  });

  for (const { label, schema } of CASES) {
    test(`${label} keeps combinators out of the schema root`, () => {
      for (const keyword of ROOT_COMBINATORS) {
        expect(schema).not.toHaveProperty(keyword);
      }
      expect(schema.type).toBe("object");
    });
  }
});
