import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { SkillToolEntry } from "../config/skills.js";
import { RiskLevel } from "../permissions/types.js";
import { computeSkillVersionHash } from "../skills/version-hash.js";
import {
  createSkillTool,
  createSkillToolsFromManifest,
} from "../tools/skills/skill-tool-factory.js";
import type { ToolContext } from "../tools/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<SkillToolEntry> = {}): SkillToolEntry {
  return {
    name: "test_tool",
    description: "A test tool",
    category: "testing",
    risk: "medium",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    executor: "scripts/run.ts",
    execution_target: "host",
    ...overrides,
  };
}

// These factory tests exercise the host executor-routing path (the default
// makeEntry uses execution_target: "host"). Host execution is a first-party
// capability, so the runner only runs it for bundled skills — pass this as the
// `bundled` argument so createSkillTool actually reaches the executor.
const BUNDLED = true;

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDir: "/tmp",
    conversationId: "test-conversation",
    trustClass: "guardian",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Temp dir for execute tests that need real scripts
// ---------------------------------------------------------------------------

let tempDir: string;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "skill-tool-factory-test-"));

  await writeFile(
    join(tempDir, "echo.ts"),
    `export async function run(input, context) {
  return {
    content: JSON.stringify({ input, workingDir: context.workingDir }),
    isError: false,
  };
}`,
    "utf-8",
  );
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// createSkillTool — metadata
// ---------------------------------------------------------------------------

describe("createSkillTool", () => {
  test("produces a tool with correct name, description, and category", () => {
    const tool = createSkillTool(makeEntry(), "/skills/my-skill", "v1:test");

    expect(tool.name).toBe("test_tool");
    expect(tool.description).toBe("A test tool");
    expect(tool.category).toBe("testing");
  });

  // Removed "sets origin to skill" test — the factory no longer stamps an
  // origin/kind on the Tool. Ownership is recorded by `registerSkillTools`
  // in the registry; see registry.test.ts.

  test.each([
    ["low", RiskLevel.Low],
    ["medium", RiskLevel.Medium],
    ["high", RiskLevel.High],
  ] as const)('maps risk "%s" to RiskLevel.%s', (risk, expected) => {
    const tool = createSkillTool(makeEntry({ risk }), "/skills/sk", "v1:test");

    expect(tool.defaultRiskLevel).toBe(expected);
  });

  // ---------------------------------------------------------------------------
  // getDefinition
  // ---------------------------------------------------------------------------

  test("getDefinition() returns correct ToolDefinition with input_schema", () => {
    const schema = {
      type: "object",
      properties: { url: { type: "string" }, depth: { type: "number" } },
      required: ["url"],
    };
    const tool = createSkillTool(
      makeEntry({
        name: "web_scrape",
        description: "Scrape a URL",
        input_schema: schema,
      }),
      "/skills/scraper",
      "v1:test",
    );

    const def = tool;

    expect(def.name).toBe("web_scrape");
    expect(def.description).toBe("Scrape a URL");
    expect(def.input_schema).toEqual(schema);
  });

  // ---------------------------------------------------------------------------
  // execute — integration with real script
  // ---------------------------------------------------------------------------

  test("execute() routes through runSkillToolScript to the executor", async () => {
    const hash = computeSkillVersionHash(tempDir);
    const tool = createSkillTool(
      makeEntry({ executor: "echo.ts" }),
      tempDir,
      hash,
      BUNDLED,
    );
    const ctx = makeContext({ workingDir: "/my/project" });
    const input = { query: "hello" };

    const result = await tool.execute(input, ctx);

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.input).toEqual({ query: "hello" });
    expect(parsed.workingDir).toBe("/my/project");
  });

  test("execute() returns error when executor script is missing", async () => {
    const hash = computeSkillVersionHash(tempDir);
    const tool = createSkillTool(
      makeEntry({ executor: "nonexistent.ts" }),
      tempDir,
      hash,
      BUNDLED,
    );

    // Provide valid input so we reach the executor (the default schema
    // declares `query` as required).
    const result = await tool.execute({ query: "x" }, makeContext());

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Failed to load skill tool script");
  });
});

// ---------------------------------------------------------------------------
// createSkillToolsFromManifest
// ---------------------------------------------------------------------------

describe("createSkillToolsFromManifest", () => {
  test("creates a tool for each manifest entry", () => {
    const entries: SkillToolEntry[] = [
      makeEntry({ name: "tool_a", description: "Tool A", risk: "low" }),
      makeEntry({ name: "tool_b", description: "Tool B", risk: "high" }),
      makeEntry({ name: "tool_c", description: "Tool C", risk: "medium" }),
    ];

    const tools = createSkillToolsFromManifest(
      entries,
      "/skills/multi",
      "v1:test",
    );

    expect(tools).toHaveLength(3);
    expect(tools.map((t) => t.name)).toEqual(["tool_a", "tool_b", "tool_c"]);
    expect(tools.map((t) => t.defaultRiskLevel)).toEqual([
      RiskLevel.Low,
      RiskLevel.High,
      RiskLevel.Medium,
    ]);
  });

  // Removed "all created tools share the same origin" — same reason as the
  // single-tool case above: ownership is recorded by `registerSkillTools` in
  // the registry, not stamped onto each Tool by the factory.

  test("returns an empty array when given no entries", () => {
    const tools = createSkillToolsFromManifest([], "/skills/empty", "v1:test");

    expect(tools).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// createSkillTool — unknown parameter validation
// ---------------------------------------------------------------------------

describe("createSkillTool — unknown parameter validation", () => {
  test("rejects input with unknown parameters", async () => {
    const hash = computeSkillVersionHash(tempDir);
    const tool = createSkillTool(
      makeEntry({ executor: "echo.ts" }),
      tempDir,
      hash,
      BUNDLED,
    );

    const result = await tool.execute(
      { query: "hello", unsubscribe: true },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Invalid input for tool "test_tool"');
    expect(result.content).toContain('Unknown parameter "unsubscribe"');
    expect(result.content).toContain("Supported:");
    expect(result.content).toContain('"query"');
  });

  test("rejects multiple unknown parameters", async () => {
    const hash = computeSkillVersionHash(tempDir);
    const tool = createSkillTool(
      makeEntry({ executor: "echo.ts" }),
      tempDir,
      hash,
      BUNDLED,
    );

    const result = await tool.execute(
      { query: "hello", foo: 1, bar: 2 },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Invalid input for tool "test_tool"');
    expect(result.content).toContain('Unknown parameter "foo"');
    expect(result.content).toContain('Unknown parameter "bar"');
  });

  test("allows input with only known parameters", async () => {
    const hash = computeSkillVersionHash(tempDir);
    const tool = createSkillTool(
      makeEntry({ executor: "echo.ts" }),
      tempDir,
      hash,
      BUNDLED,
    );

    const result = await tool.execute({ query: "hello" }, makeContext());

    expect(result.isError).toBe(false);
  });

  test("allows empty input when schema has no required fields", async () => {
    const hash = computeSkillVersionHash(tempDir);
    const tool = createSkillTool(
      makeEntry({
        executor: "echo.ts",
        input_schema: {
          type: "object",
          properties: { query: { type: "string" } },
        },
      }),
      tempDir,
      hash,
      BUNDLED,
    );

    const result = await tool.execute({}, makeContext());

    expect(result.isError).toBe(false);
  });

  test("skips validation when schema has no properties", async () => {
    const hash = computeSkillVersionHash(tempDir);
    const tool = createSkillTool(
      makeEntry({
        executor: "echo.ts",
        input_schema: { type: "object" },
      }),
      tempDir,
      hash,
      BUNDLED,
    );

    const result = await tool.execute({ anything: "goes" }, makeContext());

    expect(result.isError).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createSkillTool — required / type / enum validation
// ---------------------------------------------------------------------------

describe("createSkillTool — required/type/enum validation", () => {
  test("rejects missing required field with self-correcting message", async () => {
    const hash = computeSkillVersionHash(tempDir);
    const tool = createSkillTool(
      makeEntry({ executor: "echo.ts" }),
      tempDir,
      hash,
      BUNDLED,
    );

    const result = await tool.execute({}, makeContext());

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Invalid input for tool "test_tool"');
    expect(result.content).toContain("query is required");
  });

  test("rejects wrong type with `must be a string` message", async () => {
    const hash = computeSkillVersionHash(tempDir);
    const tool = createSkillTool(
      makeEntry({ executor: "echo.ts" }),
      tempDir,
      hash,
      BUNDLED,
    );

    const result = await tool.execute({ query: { nested: 1 } }, makeContext());

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Invalid input for tool "test_tool"');
    expect(result.content).toContain("query must be a string");
  });

  test("coerces finite numbers to strings before validation and passes the coerced value to the executor", async () => {
    const hash = computeSkillVersionHash(tempDir);
    const tool = createSkillTool(
      makeEntry({
        executor: "echo.ts",
        input_schema: {
          type: "object",
          properties: { phone_number: { type: "string" } },
          required: ["phone_number"],
        },
      }),
      tempDir,
      hash,
      BUNDLED,
    );

    const result = await tool.execute(
      { phone_number: 15550100 },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.input).toEqual({ phone_number: "15550100" });
  });

  test("rejects integers outside the safe range instead of coercing a rounded value", async () => {
    const hash = computeSkillVersionHash(tempDir);
    const tool = createSkillTool(
      makeEntry({
        executor: "echo.ts",
        input_schema: {
          type: "object",
          properties: { account_id: { type: "string" } },
          required: ["account_id"],
        },
      }),
      tempDir,
      hash,
      BUNDLED,
    );

    const result = await tool.execute(
      { account_id: 12345678901234567890 },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Invalid input for tool "test_tool"');
    expect(result.content).toContain("account_id must be a string");
  });

  test("rejects enum violation with `must be one of` message", async () => {
    const hash = computeSkillVersionHash(tempDir);
    const tool = createSkillTool(
      makeEntry({
        executor: "echo.ts",
        input_schema: {
          type: "object",
          properties: { mode: { type: "string", enum: ["a", "b"] } },
        },
      }),
      tempDir,
      hash,
      BUNDLED,
    );

    const result = await tool.execute({ mode: "c" }, makeContext());

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Invalid input for tool "test_tool"');
    expect(result.content).toContain('mode must be one of "a", "b"');
  });

  test("coerces string booleans before validation and passes the coerced value to the executor", async () => {
    const hash = computeSkillVersionHash(tempDir);
    const tool = createSkillTool(
      makeEntry({
        executor: "echo.ts",
        input_schema: {
          type: "object",
          properties: {
            auto_open: { type: "boolean" },
            name: { type: "string" },
          },
        },
      }),
      tempDir,
      hash,
      BUNDLED,
    );

    const result = await tool.execute(
      { auto_open: "false", name: "x" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.input).toEqual({ auto_open: false, name: "x" });
  });

  test("rejects non-coercible boolean strings with a self-correcting message", async () => {
    const hash = computeSkillVersionHash(tempDir);
    const tool = createSkillTool(
      makeEntry({
        executor: "echo.ts",
        input_schema: {
          type: "object",
          properties: { auto_open: { type: "boolean" } },
        },
      }),
      tempDir,
      hash,
      BUNDLED,
    );

    const result = await tool.execute({ auto_open: "yes" }, makeContext());

    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "auto_open must be a boolean — pass true or false as a JSON boolean, not a string",
    );
  });

  test("passes valid input through to the executor unchanged", async () => {
    const hash = computeSkillVersionHash(tempDir);
    const tool = createSkillTool(
      makeEntry({
        executor: "echo.ts",
        input_schema: {
          type: "object",
          properties: { mode: { type: "string", enum: ["a", "b"] } },
          required: ["mode"],
        },
      }),
      tempDir,
      hash,
      BUNDLED,
    );

    const result = await tool.execute({ mode: "a" }, makeContext());

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.input).toEqual({ mode: "a" });
  });
});

// ---------------------------------------------------------------------------
// createSkillTool — expectedSkillVersionHash plumbing
// ---------------------------------------------------------------------------

describe("createSkillTool — version hash plumbing to runner", () => {
  test("execute() works correctly when versionHash is provided", async () => {
    // Use the real hash of the temp directory so the runner's integrity check passes.
    const hash = computeSkillVersionHash(tempDir);
    const tool = createSkillTool(
      makeEntry({ executor: "echo.ts" }),
      tempDir,
      hash,
      BUNDLED,
    );
    const ctx = makeContext({ workingDir: "/my/project" });
    const input = { query: "test" };

    const result = await tool.execute(input, ctx);

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.input).toEqual({ query: "test" });
    expect(parsed.workingDir).toBe("/my/project");
  });
});
