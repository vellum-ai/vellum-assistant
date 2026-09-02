import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { SkillToolEntry } from "../config/skills.js";
import { RiskLevel } from "../permissions/types.js";
import { computeSkillVersionHash } from "../skills/version-hash.js";
import { resolveSubagentRole } from "../subagent/role-resolution.js";
import type { SubagentRole } from "../subagent/types.js";
import { bundledToolInputMisuseKeys } from "../tools/shared/input-misuse.js";
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
    const tool = createSkillTool(
      makeEntry({ supported_client_os: ["macos"] }),
      "/skills/my-skill",
      "v1:test",
    );

    expect(tool.name).toBe("test_tool");
    expect(tool.description).toBe("A test tool");
    expect(tool.category).toBe("testing");
    expect(tool.supportedClientOs).toEqual(["macos"]);
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

  test("repairs array shapes before validation and passes the repaired value to the executor", async () => {
    const hash = computeSkillVersionHash(tempDir);
    const tool = createSkillTool(
      makeEntry({
        executor: "echo.ts",
        input_schema: {
          type: "object",
          properties: {
            activation_hints: { type: "array", items: { type: "string" } },
            avoid_when: { type: "array", items: { type: "string" } },
            files: { type: "array", items: { type: "object" } },
            name: { type: "string" },
          },
          required: ["activation_hints"],
        },
      }),
      tempDir,
      hash,
      BUNDLED,
    );

    const result = await tool.execute(
      {
        activation_hints: '["user asks to deploy staging","needs a rollback"]',
        avoid_when: "the repo is dirty",
        files: '[{"path":"references/notes.md","content":"hi"}]',
        name: "x",
      },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.input).toEqual({
      activation_hints: ["user asks to deploy staging", "needs a rollback"],
      avoid_when: ["the repo is dirty"],
      files: [{ path: "references/notes.md", content: "hi" }],
      name: "x",
    });
  });

  test("rejects a truncated array with a self-correcting message", async () => {
    const hash = computeSkillVersionHash(tempDir);
    const tool = createSkillTool(
      makeEntry({
        executor: "echo.ts",
        input_schema: {
          type: "object",
          properties: {
            activation_hints: { type: "array", items: { type: "string" } },
          },
        },
      }),
      tempDir,
      hash,
      BUNDLED,
    );

    const result = await tool.execute(
      { activation_hints: "[user asks to deploy staging" },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "activation_hints must be an array: pass a JSON array, not a string",
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
// createSkillTool: parameter misuse redirects
// ---------------------------------------------------------------------------

/**
 * The subagent skill's real `subagent_read` manifest entry. Its redirect keys
 * are absent from the advertised `properties`, so manifest validation is the
 * layer that has to surface the redirect: nothing downstream of it runs.
 */
function subagentReadEntry(): SkillToolEntry {
  const manifest = JSON.parse(
    readFileSync(
      join(import.meta.dir, "../config/bundled-skills/subagent/TOOLS.json"),
      "utf-8",
    ),
  ) as { tools: SkillToolEntry[] };
  const entry = manifest.tools.find((t) => t.name === "subagent_read");
  if (!entry) {
    throw new Error("subagent_read is missing from the subagent TOOLS.json");
  }
  return entry;
}

function subagentReadTool() {
  return createSkillTool(
    subagentReadEntry(),
    "/skills/subagent",
    "v1:test",
    BUNDLED,
  );
}

describe("createSkillTool: parameter misuse redirects", () => {
  for (const key of ["path", "file", "filename"]) {
    test(`subagent_read sends "${key}" to file_read`, async () => {
      const result = await subagentReadTool().execute(
        { [key]: "/tmp/notes.md" },
        makeContext(),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toBe(
        "subagent_read returns a subagent's output, it does not read files. Use file_read for files. Pass subagent_id or label here.",
      );
    });
  }

  for (const key of ["subagentId", "agent_id"]) {
    test(`subagent_read names "${key}" as a misspelling of subagent_id`, async () => {
      const result = await subagentReadTool().execute(
        { [key]: "sa-1" },
        makeContext(),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toBe(
        "Unknown parameter. Use subagent_id (snake_case) or label.",
      );
    });
  }

  test("a key with no redirect keeps the generic validation error", async () => {
    const result = await subagentReadTool().execute(
      { subagent_id: "sa-1", nonsense: 1 },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Invalid input for tool "subagent_read"');
    expect(result.content).toContain('Unknown parameter "nonsense"');
  });

  test("redirect keys stay out of the advertised schema", () => {
    const properties = (
      subagentReadEntry().input_schema as {
        properties: Record<string, unknown>;
      }
    ).properties;

    for (const key of bundledToolInputMisuseKeys("subagent_read")) {
      expect(properties[key]).toBeUndefined();
    }
  });

  test("a non-bundled skill reusing the name keeps the generic validation error", async () => {
    // Tool names are not reserved, so a workspace skill can define its own
    // `subagent_read` where `path` is a declared parameter. Its validation
    // errors must describe its own manifest, not Vellum's file-reader redirect.
    const tool = createSkillTool(
      makeEntry({
        name: "subagent_read",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      }),
      "/workspace/skills/notes",
      "v1:test",
      false,
    );

    const result = await tool.execute(
      { path: "/tmp/notes.md", nonsense: 1 },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Invalid input for tool "subagent_read"');
    expect(result.content).toContain('Unknown parameter "nonsense"');
  });

  test("an unspecified owner keeps the generic validation error", async () => {
    const tool = createSkillTool(
      subagentReadEntry(),
      "/skills/subagent",
      "v1:test",
    );

    const result = await tool.execute({ path: "/tmp/notes.md" }, makeContext());

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Invalid input for tool "subagent_read"');
    expect(result.content).toContain('Unknown parameter "path"');
  });

  test("a tool with no rules keeps the generic validation error", async () => {
    const hash = computeSkillVersionHash(tempDir);
    const tool = createSkillTool(
      makeEntry({ executor: "echo.ts" }),
      tempDir,
      hash,
      BUNDLED,
    );

    const result = await tool.execute(
      { query: "hello", path: "/tmp/notes.md" },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Invalid input for tool "test_tool"');
    expect(result.content).toContain('Unknown parameter "path"');
  });
});

// ---------------------------------------------------------------------------
// createSkillTool: subagent_spawn roles survive manifest validation
// ---------------------------------------------------------------------------

/** The subagent skill's real `subagent_spawn` manifest entry. */
function subagentSpawnEntry(): SkillToolEntry {
  const manifest = JSON.parse(
    readFileSync(
      join(import.meta.dir, "../config/bundled-skills/subagent/TOOLS.json"),
      "utf-8",
    ),
  ) as { tools: SkillToolEntry[] };
  const entry = manifest.tools.find((t) => t.name === "subagent_spawn");
  if (!entry) {
    throw new Error("subagent_spawn is missing from the subagent TOOLS.json");
  }
  return entry;
}

/**
 * The real `subagent_spawn` schema wired to a stub executor. Only the schema
 * is under test here, so the manifest's own executor (which would really spawn)
 * is swapped for the echo script.
 */
function subagentSpawnTool() {
  return createSkillTool(
    { ...subagentSpawnEntry(), executor: "echo.ts" },
    tempDir,
    computeSkillVersionHash(tempDir),
    BUNDLED,
  );
}

/**
 * Every `role` string {@link resolveSubagentRole} defines an answer for has to
 * clear manifest validation first: `createSkillTool` validates against the
 * manifest BEFORE the executor runs, so a constraint there that is narrower
 * than the resolver silently deletes the resolver's behavior, and every test
 * that calls `executeSubagentSpawn` directly still passes.
 */
describe("createSkillTool: bundled input repairs", () => {
  const SCAFFOLD_SCHEMA = {
    type: "object",
    properties: {
      skill_id: { type: "string" },
      body_markdown: { type: "string" },
      files: {
        type: "array",
        items: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
            copy_from: { type: "string" },
          },
          required: ["path"],
        },
      },
    },
    required: ["skill_id", "body_markdown"],
  };

  function makeScaffoldTool(bundled: boolean) {
    return createSkillTool(
      makeEntry({
        name: "scaffold_managed_skill",
        executor: "echo.ts",
        input_schema: SCAFFOLD_SCHEMA,
      }),
      tempDir,
      computeSkillVersionHash(tempDir),
      bundled,
    );
  }

  test("reads `body` as `body_markdown` and reaches the executor", async () => {
    const result = await makeScaffoldTool(true).execute(
      { skill_id: "deploy", body: "# Deploy\n" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content).input).toEqual({
      skill_id: "deploy",
      body_markdown: "# Deploy\n",
    });
  });

  test("reads a path-keyed files map as the declared array", async () => {
    const result = await makeScaffoldTool(true).execute(
      {
        skill_id: "deploy",
        body_markdown: "# Deploy\n",
        files: { "references/notes.md": "hi" },
      },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content).input.files).toEqual([
      { path: "references/notes.md", content: "hi" },
    ]);
  });

  test("accepts the injected activity field the model is shown", async () => {
    const result = await makeScaffoldTool(true).execute(
      {
        skill_id: "deploy",
        body_markdown: "# Deploy\n",
        activity: "Writing the deploy skill",
      },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content).input.activity).toBe(
      "Writing the deploy skill",
    );
  });

  test("a non-bundled skill reusing the name keeps its own contract", async () => {
    const result = await makeScaffoldTool(false).execute(
      { skill_id: "deploy", body: "# Deploy\n" },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("body_markdown is required");
    expect(result.content).toContain('Unknown parameter "body"');
  });
});

describe("createSkillTool: subagent_spawn role validation", () => {
  const ROLE_CASES: ReadonlyArray<readonly [string, SubagentRole]> = [
    ["researcher", "researcher"],
    ["builder", "builder"],
    ["advisor", "advisor"],
    ["planner", "researcher"],
    ["investigator", "researcher"],
    ["coder", "builder"],
    ["general", "builder"],
    ["a skeptical security reviewer", "researcher"],
    ["Researcher", "researcher"],
  ];

  test.each(ROLE_CASES)(
    'role "%s" passes manifest validation and resolves to %s',
    async (role, expected) => {
      const result = await subagentSpawnTool().execute(
        { label: "Check", objective: "Do the thing", role },
        makeContext(),
      );

      // Reached the executor at all, so validation let the role through.
      expect(result.isError).toBe(false);
      expect(JSON.parse(result.content).input.role).toBe(role);
      // And the value the executor receives lands where the tool description
      // and the docs say it does.
      expect(resolveSubagentRole(role).role).toBe(expected);
    },
  );

  test("role declares no enum, so the resolver stays reachable", () => {
    const role = (
      subagentSpawnEntry().input_schema as {
        properties: Record<string, { type?: string; enum?: unknown }>;
      }
    ).properties.role;

    expect(role.type).toBe("string");
    // An enum here is enforced by `validateInputAgainstSchema` ahead of the
    // executor, so any list short of "every string" rejects the legacy names
    // and free-text personas the resolver exists to handle.
    expect(role.enum).toBeUndefined();
  });

  test("output_contract keeps its enum, which the resolver has no fallback for", () => {
    // The counterpart constraint: unlike `role`, an unrecognized contract has
    // no defined behavior, so rejecting it at the boundary is correct.
    const contract = (
      subagentSpawnEntry().input_schema as {
        properties: Record<string, { enum?: string[] }>;
      }
    ).properties.output_contract;

    expect(contract.enum).toEqual(["report", "verdict", "artifact"]);
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
