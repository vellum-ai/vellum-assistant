import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { SkillToolManifest } from "../config/skills.js";
import {
  parseToolManifest,
  parseToolManifestFile,
} from "../skills/tool-manifest.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeToolEntry(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name: "test-tool",
    description: "A test tool",
    category: "testing",
    risk: "low",
    input_schema: { type: "object", properties: {} },
    executor: "tools/run.ts",
    execution_target: "host",
    ...overrides,
  };
}

function makeManifest(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: 1,
    tools: [makeToolEntry()],
    ...overrides,
  };
}

let tempDir: string;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "skill-tool-manifest-test-"));
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// parseToolManifest — happy path
// ---------------------------------------------------------------------------

describe("parseToolManifest", () => {
  test("parses a valid manifest with one tool", () => {
    const raw = makeManifest();
    const result = parseToolManifest(raw);

    expect(result.version).toBe(1);
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe("test-tool");
    expect(result.tools[0].description).toBe("A test tool");
    expect(result.tools[0].category).toBe("testing");
    expect(result.tools[0].risk).toBe("low");
    expect(result.tools[0].input_schema).toEqual({
      type: "object",
      properties: {},
    });
    expect(result.tools[0].executor).toBe("tools/run.ts");
    expect(result.tools[0].execution_target).toBe("host");
  });

  test("preserves all fields exactly", () => {
    const schema = {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to fetch" },
        timeout: { type: "number", description: "Timeout in ms" },
      },
      required: ["url"],
    };
    const raw = makeManifest({
      tools: [
        makeToolEntry({
          name: "web-fetch",
          description: "Fetch content from a URL",
          category: "network",
          risk: "medium",
          input_schema: schema,
          executor: "tools/web-fetch.ts",
          execution_target: "sandbox",
        }),
      ],
    });

    const result = parseToolManifest(raw);
    const tool = result.tools[0];

    expect(tool.name).toBe("web-fetch");
    expect(tool.description).toBe("Fetch content from a URL");
    expect(tool.category).toBe("network");
    expect(tool.risk).toBe("medium");
    expect(tool.input_schema).toEqual(schema);
    expect(tool.executor).toBe("tools/web-fetch.ts");
    expect(tool.execution_target).toBe("sandbox");
  });

  test("parses a manifest with multiple tools", () => {
    const raw = makeManifest({
      tools: [
        makeToolEntry({ name: "tool-a", risk: "low" }),
        makeToolEntry({ name: "tool-b", risk: "medium" }),
        makeToolEntry({ name: "tool-c", risk: "high" }),
      ],
    });

    const result = parseToolManifest(raw);
    expect(result.tools).toHaveLength(3);
    expect(result.tools.map((t) => t.name)).toEqual([
      "tool-a",
      "tool-b",
      "tool-c",
    ]);
    expect(result.tools.map((t) => t.risk)).toEqual(["low", "medium", "high"]);
  });

  test("accepts executor with ./ prefix", () => {
    const raw = makeManifest({
      tools: [makeToolEntry({ executor: "./tools/run.ts" })],
    });

    const result = parseToolManifest(raw);
    expect(result.tools[0].executor).toBe("./tools/run.ts");
  });

  test("accepts deeply nested executor paths", () => {
    const raw = makeManifest({
      tools: [makeToolEntry({ executor: "src/tools/impl/run.ts" })],
    });

    const result = parseToolManifest(raw);
    expect(result.tools[0].executor).toBe("src/tools/impl/run.ts");
  });

  test("accepts all valid risk levels", () => {
    for (const risk of ["low", "medium", "high"] as const) {
      const raw = makeManifest({
        tools: [makeToolEntry({ name: `tool-${risk}`, risk })],
      });
      const result = parseToolManifest(raw);
      expect(result.tools[0].risk).toBe(risk);
    }
  });

  test("accepts both execution targets", () => {
    for (const target of ["host", "sandbox"] as const) {
      const raw = makeManifest({
        tools: [
          makeToolEntry({ name: `tool-${target}`, execution_target: target }),
        ],
      });
      const result = parseToolManifest(raw);
      expect(result.tools[0].execution_target).toBe(target);
    }
  });

  test("accepts an empty input_schema object", () => {
    const raw = makeManifest({
      tools: [makeToolEntry({ input_schema: {} })],
    });

    const result = parseToolManifest(raw);
    expect(result.tools[0].input_schema).toEqual({});
  });

  test("returns a typed SkillToolManifest", () => {
    const raw = makeManifest();
    const result: SkillToolManifest = parseToolManifest(raw);

    // Type assertion is the test — if this compiles, the return type is correct
    expect(result).toBeDefined();
    expect(result.version).toBe(1);
    expect(Array.isArray(result.tools)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseToolManifestFile — happy path
// ---------------------------------------------------------------------------

describe("parseToolManifestFile", () => {
  test("reads and parses a valid TOOLS.json file", async () => {
    const manifest = makeManifest({
      tools: [makeToolEntry({ name: "file-tool", executor: "tools/file.ts" })],
    });
    const filePath = join(tempDir, "valid-TOOLS.json");
    await writeFile(filePath, JSON.stringify(manifest, null, 2), "utf-8");

    const result = parseToolManifestFile(filePath);
    expect(result.version).toBe(1);
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe("file-tool");
    expect(result.tools[0].executor).toBe("tools/file.ts");
  });

  test("parses a file with multiple tools", async () => {
    const manifest = makeManifest({
      tools: [
        makeToolEntry({ name: "alpha", risk: "low", execution_target: "host" }),
        makeToolEntry({
          name: "beta",
          risk: "high",
          execution_target: "sandbox",
        }),
      ],
    });
    const filePath = join(tempDir, "multi-TOOLS.json");
    await writeFile(filePath, JSON.stringify(manifest), "utf-8");

    const result = parseToolManifestFile(filePath);
    expect(result.tools).toHaveLength(2);
    expect(result.tools[0].name).toBe("alpha");
    expect(result.tools[1].name).toBe("beta");
  });
});

// ---------------------------------------------------------------------------
// parseToolManifest — root-level validation errors
// ---------------------------------------------------------------------------

describe("parseToolManifest — root-level validation", () => {
  test("rejects null input", () => {
    expect(() => parseToolManifest(null)).toThrow(
      "TOOLS.json must be a JSON object",
    );
  });

  test("rejects undefined input", () => {
    expect(() => parseToolManifest(undefined)).toThrow(
      "TOOLS.json must be a JSON object",
    );
  });

  test("rejects a string input", () => {
    expect(() => parseToolManifest("not an object")).toThrow(
      "TOOLS.json must be a JSON object",
    );
  });

  test("rejects a number input", () => {
    expect(() => parseToolManifest(42)).toThrow(
      "TOOLS.json must be a JSON object",
    );
  });

  test("rejects a boolean input", () => {
    expect(() => parseToolManifest(true)).toThrow(
      "TOOLS.json must be a JSON object",
    );
  });

  test("rejects an array instead of object at root", () => {
    expect(() => parseToolManifest([{ version: 1 }])).toThrow(
      "TOOLS.json must be a JSON object",
    );
  });
});

// ---------------------------------------------------------------------------
// parseToolManifest — version field validation
// ---------------------------------------------------------------------------

describe("parseToolManifest — version validation", () => {
  test("rejects missing version field", () => {
    const raw = { tools: [makeToolEntry()] };
    expect(() => parseToolManifest(raw)).toThrow(
      'TOOLS.json is missing required field "version"',
    );
  });

  test("rejects version 0", () => {
    expect(() => parseToolManifest(makeManifest({ version: 0 }))).toThrow(
      'TOOLS.json "version" must be 1, got: 0',
    );
  });

  test("rejects version 2", () => {
    expect(() => parseToolManifest(makeManifest({ version: 2 }))).toThrow(
      'TOOLS.json "version" must be 1, got: 2',
    );
  });

  test("rejects string version", () => {
    expect(() => parseToolManifest(makeManifest({ version: "1" }))).toThrow(
      'TOOLS.json "version" must be 1, got: "1"',
    );
  });

  test("rejects float version", () => {
    expect(() => parseToolManifest(makeManifest({ version: 1.5 }))).toThrow(
      'TOOLS.json "version" must be 1, got: 1.5',
    );
  });

  test("rejects null version", () => {
    expect(() => parseToolManifest(makeManifest({ version: null }))).toThrow(
      'TOOLS.json "version" must be 1, got: null',
    );
  });

  test("rejects boolean version", () => {
    expect(() => parseToolManifest(makeManifest({ version: true }))).toThrow(
      'TOOLS.json "version" must be 1, got: true',
    );
  });
});

// ---------------------------------------------------------------------------
// parseToolManifest — tools field validation
// ---------------------------------------------------------------------------

describe("parseToolManifest — tools field validation", () => {
  test("rejects missing tools field", () => {
    expect(() => parseToolManifest({ version: 1 })).toThrow(
      'TOOLS.json is missing required field "tools"',
    );
  });

  test("rejects tools as a string", () => {
    expect(() =>
      parseToolManifest(makeManifest({ tools: "not-an-array" })),
    ).toThrow('TOOLS.json "tools" must be an array');
  });

  test("rejects tools as an object", () => {
    expect(() => parseToolManifest(makeManifest({ tools: {} }))).toThrow(
      'TOOLS.json "tools" must be an array',
    );
  });

  test("rejects tools as null", () => {
    expect(() => parseToolManifest(makeManifest({ tools: null }))).toThrow(
      'TOOLS.json "tools" must be an array',
    );
  });

  test("rejects empty tools array", () => {
    expect(() => parseToolManifest(makeManifest({ tools: [] }))).toThrow(
      'TOOLS.json "tools" must contain at least one tool entry',
    );
  });
});

// ---------------------------------------------------------------------------
// parseToolManifest — tool entry type validation
// ---------------------------------------------------------------------------

describe("parseToolManifest — tool entry type validation", () => {
  test("rejects null tool entry", () => {
    expect(() => parseToolManifest(makeManifest({ tools: [null] }))).toThrow(
      "TOOLS.json tools[0]: each tool entry must be a JSON object",
    );
  });

  test("rejects undefined tool entry", () => {
    expect(() =>
      parseToolManifest(makeManifest({ tools: [undefined] })),
    ).toThrow("TOOLS.json tools[0]: each tool entry must be a JSON object");
  });

  test("rejects string tool entry", () => {
    expect(() =>
      parseToolManifest(makeManifest({ tools: ["a string"] })),
    ).toThrow("TOOLS.json tools[0]: each tool entry must be a JSON object");
  });

  test("rejects number tool entry", () => {
    expect(() => parseToolManifest(makeManifest({ tools: [42] }))).toThrow(
      "TOOLS.json tools[0]: each tool entry must be a JSON object",
    );
  });

  test("rejects array tool entry", () => {
    expect(() => parseToolManifest(makeManifest({ tools: [[]] }))).toThrow(
      "TOOLS.json tools[0]: each tool entry must be a JSON object",
    );
  });

  test("rejects boolean tool entry", () => {
    expect(() => parseToolManifest(makeManifest({ tools: [true] }))).toThrow(
      "TOOLS.json tools[0]: each tool entry must be a JSON object",
    );
  });

  test("error message includes correct index for later entries", () => {
    expect(() =>
      parseToolManifest(
        makeManifest({ tools: [makeToolEntry({ name: "ok" }), "bad"] }),
      ),
    ).toThrow("TOOLS.json tools[1]: each tool entry must be a JSON object");
  });
});

// ---------------------------------------------------------------------------
// parseToolManifest — required field validation
// ---------------------------------------------------------------------------

describe("parseToolManifest — required field validation", () => {
  const requiredStringFields = [
    "name",
    "description",
    "category",
    "risk",
    "executor",
    "execution_target",
  ] as const;

  for (const field of requiredStringFields) {
    test(`rejects missing "${field}" field`, () => {
      const entry = makeToolEntry();
      delete entry[field];
      expect(() => parseToolManifest(makeManifest({ tools: [entry] }))).toThrow(
        `TOOLS.json tools[0]: missing or non-string "${field}"`,
      );
    });

    test(`rejects non-string "${field}" field (number)`, () => {
      const entry = makeToolEntry({ [field]: 123 });
      expect(() => parseToolManifest(makeManifest({ tools: [entry] }))).toThrow(
        `TOOLS.json tools[0]: missing or non-string "${field}"`,
      );
    });

    test(`rejects null "${field}" field`, () => {
      const entry = makeToolEntry({ [field]: null });
      expect(() => parseToolManifest(makeManifest({ tools: [entry] }))).toThrow(
        `TOOLS.json tools[0]: missing or non-string "${field}"`,
      );
    });
  }

  test("rejects missing input_schema", () => {
    const entry = makeToolEntry();
    delete entry.input_schema;
    expect(() => parseToolManifest(makeManifest({ tools: [entry] }))).toThrow(
      'TOOLS.json tools[0]: missing or non-object "input_schema"',
    );
  });

  test("rejects null input_schema", () => {
    expect(() =>
      parseToolManifest(
        makeManifest({ tools: [makeToolEntry({ input_schema: null })] }),
      ),
    ).toThrow('TOOLS.json tools[0]: missing or non-object "input_schema"');
  });

  test("rejects array input_schema", () => {
    expect(() =>
      parseToolManifest(
        makeManifest({ tools: [makeToolEntry({ input_schema: [] })] }),
      ),
    ).toThrow('TOOLS.json tools[0]: missing or non-object "input_schema"');
  });

  test("rejects string input_schema", () => {
    expect(() =>
      parseToolManifest(
        makeManifest({ tools: [makeToolEntry({ input_schema: "schema" })] }),
      ),
    ).toThrow('TOOLS.json tools[0]: missing or non-object "input_schema"');
  });
});

// ---------------------------------------------------------------------------
// parseToolManifest — empty string validation
// ---------------------------------------------------------------------------

describe("parseToolManifest — empty string validation", () => {
  test("rejects empty name", () => {
    expect(() =>
      parseToolManifest(makeManifest({ tools: [makeToolEntry({ name: "" })] })),
    ).toThrow('TOOLS.json tools[0]: "name" must be a non-empty string');
  });

  test("rejects whitespace-only name", () => {
    expect(() =>
      parseToolManifest(
        makeManifest({ tools: [makeToolEntry({ name: "   " })] }),
      ),
    ).toThrow('TOOLS.json tools[0]: "name" must be a non-empty string');
  });

  test("rejects empty description", () => {
    expect(() =>
      parseToolManifest(
        makeManifest({ tools: [makeToolEntry({ description: "" })] }),
      ),
    ).toThrow('TOOLS.json tools[0]: "description" must be a non-empty string');
  });

  test("rejects whitespace-only description", () => {
    expect(() =>
      parseToolManifest(
        makeManifest({ tools: [makeToolEntry({ description: "  \t  " })] }),
      ),
    ).toThrow('TOOLS.json tools[0]: "description" must be a non-empty string');
  });

  test("rejects empty category", () => {
    expect(() =>
      parseToolManifest(
        makeManifest({ tools: [makeToolEntry({ category: "" })] }),
      ),
    ).toThrow('TOOLS.json tools[0]: "category" must be a non-empty string');
  });

  test("rejects whitespace-only category", () => {
    expect(() =>
      parseToolManifest(
        makeManifest({ tools: [makeToolEntry({ category: "\n" })] }),
      ),
    ).toThrow('TOOLS.json tools[0]: "category" must be a non-empty string');
  });

  test("rejects empty executor", () => {
    expect(() =>
      parseToolManifest(
        makeManifest({ tools: [makeToolEntry({ executor: "" })] }),
      ),
    ).toThrow('TOOLS.json tools[0]: "executor" must be a non-empty string');
  });
});

// ---------------------------------------------------------------------------
// parseToolManifest — risk level validation
// ---------------------------------------------------------------------------

describe("parseToolManifest — risk level validation", () => {
  test('rejects invalid risk level "critical"', () => {
    expect(() =>
      parseToolManifest(
        makeManifest({ tools: [makeToolEntry({ risk: "critical" })] }),
      ),
    ).toThrow(
      'TOOLS.json tools[0]: "risk" must be one of "low", "medium", "high", got: "critical"',
    );
  });

  test("rejects uppercase risk level", () => {
    expect(() =>
      parseToolManifest(
        makeManifest({ tools: [makeToolEntry({ risk: "LOW" })] }),
      ),
    ).toThrow(
      'TOOLS.json tools[0]: "risk" must be one of "low", "medium", "high", got: "LOW"',
    );
  });

  test("rejects mixed case risk level", () => {
    expect(() =>
      parseToolManifest(
        makeManifest({ tools: [makeToolEntry({ risk: "Medium" })] }),
      ),
    ).toThrow(
      'TOOLS.json tools[0]: "risk" must be one of "low", "medium", "high", got: "Medium"',
    );
  });
});

// ---------------------------------------------------------------------------
// parseToolManifest — execution_target validation
// ---------------------------------------------------------------------------

describe("parseToolManifest — execution_target validation", () => {
  test("rejects invalid execution_target", () => {
    expect(() =>
      parseToolManifest(
        makeManifest({ tools: [makeToolEntry({ execution_target: "cloud" })] }),
      ),
    ).toThrow(
      'TOOLS.json tools[0]: "execution_target" must be one of "host", "sandbox", got: "cloud"',
    );
  });

  test("rejects uppercase execution_target", () => {
    expect(() =>
      parseToolManifest(
        makeManifest({ tools: [makeToolEntry({ execution_target: "HOST" })] }),
      ),
    ).toThrow(
      'TOOLS.json tools[0]: "execution_target" must be one of "host", "sandbox", got: "HOST"',
    );
  });
});

// ---------------------------------------------------------------------------
// parseToolManifest — executor path traversal
// ---------------------------------------------------------------------------

describe("parseToolManifest — executor path traversal", () => {
  test("rejects absolute path executor", () => {
    expect(() =>
      parseToolManifest(
        makeManifest({
          tools: [makeToolEntry({ executor: "/absolute/path.ts" })],
        }),
      ),
    ).toThrow(
      'TOOLS.json tools[0]: "executor" must be a relative path, got absolute path: "/absolute/path.ts"',
    );
  });

  test("rejects simple ../ path traversal", () => {
    expect(() =>
      parseToolManifest(
        makeManifest({ tools: [makeToolEntry({ executor: "../escape.ts" })] }),
      ),
    ).toThrow(
      'TOOLS.json tools[0]: "executor" must not contain ".." path segments: "../escape.ts"',
    );
  });

  test("rejects embedded ../ path traversal", () => {
    expect(() =>
      parseToolManifest(
        makeManifest({
          tools: [makeToolEntry({ executor: "foo/../../escape.ts" })],
        }),
      ),
    ).toThrow(
      'TOOLS.json tools[0]: "executor" must not contain ".." path segments: "foo/../../escape.ts"',
    );
  });

  test("rejects deeply nested ../ path traversal", () => {
    expect(() =>
      parseToolManifest(
        makeManifest({
          tools: [makeToolEntry({ executor: "a/b/../../../escape.ts" })],
        }),
      ),
    ).toThrow(
      'TOOLS.json tools[0]: "executor" must not contain ".." path segments: "a/b/../../../escape.ts"',
    );
  });

  test("rejects .. as the only path segment", () => {
    expect(() =>
      parseToolManifest(
        makeManifest({ tools: [makeToolEntry({ executor: ".." })] }),
      ),
    ).toThrow(
      'TOOLS.json tools[0]: "executor" must not contain ".." path segments: ".."',
    );
  });
});

// ---------------------------------------------------------------------------
// parseToolManifest — duplicate tool names
// ---------------------------------------------------------------------------

describe("parseToolManifest — duplicate tool names", () => {
  test("rejects duplicate tool names", () => {
    expect(() =>
      parseToolManifest(
        makeManifest({
          tools: [
            makeToolEntry({ name: "dupe-tool", executor: "tools/a.ts" }),
            makeToolEntry({ name: "dupe-tool", executor: "tools/b.ts" }),
          ],
        }),
      ),
    ).toThrow('TOOLS.json tools[1]: duplicate tool name "dupe-tool"');
  });

  test("allows tools with different names", () => {
    const result = parseToolManifest(
      makeManifest({
        tools: [
          makeToolEntry({ name: "tool-x", executor: "tools/x.ts" }),
          makeToolEntry({ name: "tool-y", executor: "tools/y.ts" }),
        ],
      }),
    );
    expect(result.tools).toHaveLength(2);
  });

  test("detects duplicate at third position", () => {
    expect(() =>
      parseToolManifest(
        makeManifest({
          tools: [
            makeToolEntry({ name: "unique-a" }),
            makeToolEntry({ name: "unique-b" }),
            makeToolEntry({ name: "unique-a" }),
          ],
        }),
      ),
    ).toThrow('TOOLS.json tools[2]: duplicate tool name "unique-a"');
  });
});

// ---------------------------------------------------------------------------
// parseToolManifestFile — failure cases
// ---------------------------------------------------------------------------

describe("parseToolManifestFile — failure cases", () => {
  test("throws for nonexistent file", () => {
    const fakePath = join(tempDir, "does-not-exist.json");
    expect(() => parseToolManifestFile(fakePath)).toThrow(
      `Failed to read TOOLS.json at "${fakePath}"`,
    );
  });

  test("throws for invalid JSON content", async () => {
    const filePath = join(tempDir, "bad-json.json");
    await writeFile(filePath, "{ this is not valid json }", "utf-8");

    expect(() => parseToolManifestFile(filePath)).toThrow(
      `Failed to parse TOOLS.json at "${filePath}" as JSON`,
    );
  });

  test("throws for empty file", async () => {
    const filePath = join(tempDir, "empty.json");
    await writeFile(filePath, "", "utf-8");

    expect(() => parseToolManifestFile(filePath)).toThrow(
      `Failed to parse TOOLS.json at "${filePath}" as JSON`,
    );
  });

  test("throws validation error for valid JSON but invalid manifest", async () => {
    const filePath = join(tempDir, "bad-manifest.json");
    await writeFile(
      filePath,
      JSON.stringify({ version: 2, tools: [] }),
      "utf-8",
    );

    expect(() => parseToolManifestFile(filePath)).toThrow(
      'TOOLS.json "version" must be 1, got: 2',
    );
  });

  test("throws validation error for JSON array file", async () => {
    const filePath = join(tempDir, "array-root.json");
    await writeFile(filePath, JSON.stringify([{ version: 1 }]), "utf-8");

    expect(() => parseToolManifestFile(filePath)).toThrow(
      "TOOLS.json must be a JSON object",
    );
  });
});
