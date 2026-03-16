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
    const tool = createSkillTool(
      makeEntry(),
      "my-skill",
      "/skills/my-skill",
      "v1:test",
    );

    expect(tool.name).toBe("test_tool");
    expect(tool.description).toBe("A test tool");
    expect(tool.category).toBe("testing");
  });

  test("sets origin to skill and ownerSkillId", () => {
    const tool = createSkillTool(
      makeEntry(),
      "weather-skill",
      "/skills/weather",
      "v1:test",
    );

    expect(tool.origin).toBe("skill");
    expect(tool.ownerSkillId).toBe("weather-skill");
  });

  test("sets ownerSkillVersionHash from versionHash", () => {
    const hash = "v1:abc123def456";
    const tool = createSkillTool(
      makeEntry(),
      "my-skill",
      "/skills/my-skill",
      hash,
    );

    expect(tool.ownerSkillVersionHash).toBe(hash);
  });

  test.each([
    ["low", RiskLevel.Low],
    ["medium", RiskLevel.Medium],
    ["high", RiskLevel.High],
  ] as const)('maps risk "%s" to RiskLevel.%s', (risk, expected) => {
    const tool = createSkillTool(
      makeEntry({ risk }),
      "sk",
      "/skills/sk",
      "v1:test",
    );

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
      "scraper",
      "/skills/scraper",
      "v1:test",
    );

    const def = tool.getDefinition();

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
      "my-skill",
      tempDir,
      hash,
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
      "my-skill",
      tempDir,
      hash,
    );

    const result = await tool.execute({}, makeContext());

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
      "multi-skill",
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

  test("all created tools share the same skillId and origin", () => {
    const entries: SkillToolEntry[] = [
      makeEntry({ name: "alpha" }),
      makeEntry({ name: "beta" }),
    ];

    const tools = createSkillToolsFromManifest(
      entries,
      "shared-skill",
      "/skills/shared",
      "v1:test",
    );

    for (const tool of tools) {
      expect(tool.origin).toBe("skill");
      expect(tool.ownerSkillId).toBe("shared-skill");
    }
  });

  test("returns an empty array when given no entries", () => {
    const tools = createSkillToolsFromManifest(
      [],
      "empty-skill",
      "/skills/empty",
      "v1:test",
    );

    expect(tools).toEqual([]);
  });

  test("passes versionHash through to all created tools", () => {
    const hash = "v1:deadbeef";
    const entries: SkillToolEntry[] = [
      makeEntry({ name: "alpha" }),
      makeEntry({ name: "beta" }),
    ];

    const tools = createSkillToolsFromManifest(
      entries,
      "versioned-skill",
      "/skills/versioned",
      hash,
    );

    for (const tool of tools) {
      expect(tool.ownerSkillVersionHash).toBe(hash);
    }
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
      "my-skill",
      tempDir,
      hash,
    );
    const ctx = makeContext({ workingDir: "/my/project" });
    const input = { query: "test" };

    const result = await tool.execute(input, ctx);

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.input).toEqual({ query: "test" });
    expect(parsed.workingDir).toBe("/my/project");
    // Confirm the tool still has the hash stored
    expect(tool.ownerSkillVersionHash).toBe(hash);
  });
});
