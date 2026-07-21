import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import { setConfig } from "../../../__tests__/helpers/set-config.js";
import type { ToolContext } from "../../../tools/types.js";

let tmpWorkspace: string;
let previousWorkspaceEnv: string | undefined;

// Track calls to enqueuePkbIndexJob so we can assert remember wires writes
// through to the re-index queue. Declared at module scope so the mock.module
// factory (hoisted) can close over it.
const enqueueCalls: Array<{
  pkbRoot: string;
  absPath: string;
}> = [];
let enqueueShouldThrow = false;

const recallCalls: Array<{
  input: Record<string, unknown>;
  context: Record<string, unknown>;
}> = [];
let recallContent = "agentic recall answer";

mock.module("./jobs/embed-pkb-file.js", () => ({
  enqueuePkbIndexJob: (input: { pkbRoot: string; absPath: string }) => {
    enqueueCalls.push(input);
    if (enqueueShouldThrow) {
      throw new Error("simulated enqueue failure");
    }
    return "job-mock-id";
  },
}));

mock.module("./context-search/agent-runner.js", () => ({
  runAgenticRecall: async (
    input: Record<string, unknown>,
    context: Record<string, unknown>,
  ) => {
    recallCalls.push({ input, context });
    return {
      content: recallContent,
      answer: recallContent,
      evidence: [],
      debug: { mode: "agentic" },
    };
  },
}));

beforeAll(() => {
  tmpWorkspace = mkdtempSync(join(tmpdir(), "remember-tool-test-"));
  previousWorkspaceEnv = process.env.VELLUM_WORKSPACE_DIR;
  process.env.VELLUM_WORKSPACE_DIR = tmpWorkspace;
  // Remember writes the memory/ buffer regardless of the injection engine;
  // seed with the v2 flag off to prove the write path does not depend on it.
  setConfig("memory", { v2: { enabled: false } });
});

afterAll(() => {
  if (previousWorkspaceEnv === undefined) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = previousWorkspaceEnv;
  }
  rmSync(tmpWorkspace, { recursive: true, force: true });
});

// Import after the env var is set so getWorkspaceDir() resolves to the tmpdir.
const { recallTool, rememberTool } = await import("./tools.js");
const { getConfig } = await import("../../../config/loader.js");

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDir: tmpWorkspace,
    conversationId: "test-conversation",
    trustClass: "guardian",
    ...overrides,
  };
}

describe("recallTool definition", () => {
  test("exposes the agentic local search schema", () => {
    const definition = recallTool;

    expect(definition.name).toBe("recall");
    expect(definition.description).toContain("Search local information");
    expect(definition.description).toContain("workspace files");

    const inputSchema = definition.input_schema as {
      required?: string[];
      properties: Record<string, unknown>;
    };
    expect(inputSchema.required).toEqual(["query"]);

    const properties = inputSchema.properties;
    expect(Object.keys(properties).sort()).toEqual([
      "depth",
      "max_results",
      "query",
      "sources",
    ]);
    expect(properties).not.toHaveProperty("mode");
    expect(properties).not.toHaveProperty("num_results");
    expect(properties).not.toHaveProperty("filters");
    expect(properties.sources).toMatchObject({
      type: "array",
      items: {
        type: "string",
        enum: ["memory", "conversations", "workspace"],
      },
    });
    expect(properties.max_results).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 20,
    });
    expect(properties.depth).toMatchObject({
      type: "string",
      enum: ["fast", "standard", "deep"],
    });
  });
});

describe("recallTool.execute", () => {
  beforeEach(() => {
    recallCalls.length = 0;
    recallContent = "agentic recall answer";
  });

  test("allows guardian recall to invoke the agentic runner", async () => {
    const result = await recallTool.execute(
      { query: "guardian recall" },
      makeContext({ trustClass: "guardian" }),
    );

    expect(result).toEqual({
      content: "agentic recall answer",
      isError: false,
    });
    expect(recallCalls).toHaveLength(1);
    expect(recallCalls[0]?.input).toEqual({ query: "guardian recall" });
  });

  test.each(["trusted_contact", "unknown"] as const)(
    "blocks %s recall before invoking the agentic runner",
    async (trustClass) => {
      const result = await recallTool.execute(
        { query: "sensitive local search", sources: ["workspace"] },
        makeContext({ trustClass }),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("only available to the guardian");
      expect(recallCalls).toHaveLength(0);
    },
  );

  test("passes source filtering input through to agentic recall", async () => {
    const result = await recallTool.execute(
      {
        query: "release notes",
        sources: ["memory", "workspace"],
        max_results: 4,
        depth: "deep",
      },
      makeContext(),
    );

    expect(result).toEqual({
      content: "agentic recall answer",
      isError: false,
    });
    expect(recallCalls).toHaveLength(1);
    expect(recallCalls[0]?.input).toEqual({
      query: "release notes",
      sources: ["memory", "workspace"],
      max_results: 4,
      depth: "deep",
    });
  });

  test("returns deterministic fallback content directly", async () => {
    recallContent = "Found evidence:\n\n- [workspace] fallback note";

    const result = await recallTool.execute(
      { query: "fallback search", sources: ["workspace"], depth: "fast" },
      makeContext(),
    );

    expect(result).toEqual({
      content: "Found evidence:\n\n- [workspace] fallback note",
      isError: false,
    });
  });

  test("propagates tool context", async () => {
    const controller = new AbortController();

    await recallTool.execute(
      { query: "context propagation" },
      makeContext({
        workingDir: "/workspace/project",
        conversationId: "conv-context",
        signal: controller.signal,
      }),
    );

    expect(recallCalls).toHaveLength(1);
    expect(recallCalls[0]?.context).toEqual({
      workingDir: "/workspace/project",
      conversationId: "conv-context",
      config: getConfig(),
      signal: controller.signal,
    });
  });
});

describe("rememberTool.execute — finish_turn", () => {
  test("omits yieldToUser when finish_turn is not provided", async () => {
    const result = await rememberTool.execute(
      { content: "no finish_turn provided" },
      makeContext(),
    );
    expect(result.isError).toBe(false);
    expect(result.yieldToUser).toBeUndefined();
  });

  test("omits yieldToUser when finish_turn is false", async () => {
    const result = await rememberTool.execute(
      { content: "finish_turn=false", finish_turn: false },
      makeContext(),
    );
    expect(result.isError).toBe(false);
    expect(result.yieldToUser).toBeUndefined();
  });

  test("sets yieldToUser=true when finish_turn is true", async () => {
    const result = await rememberTool.execute(
      { content: "finish_turn=true", finish_turn: true },
      makeContext(),
    );
    expect(result.isError).toBe(false);
    expect(result.yieldToUser).toBe(true);
  });

  test("sets yieldToUser=true even when the write fails (empty content)", async () => {
    const result = await rememberTool.execute(
      { content: "", finish_turn: true },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.yieldToUser).toBe(true);
  });
});

describe("rememberTool.execute — buffer writes", () => {
  beforeEach(() => {
    enqueueCalls.length = 0;
    enqueueShouldThrow = false;
  });

  test("writes memory/buffer.md + daily archive without any PKB re-index enqueue", async () => {
    const result = await rememberTool.execute(
      { content: "index me please" },
      makeContext(),
    );
    expect(result.isError).toBe(false);

    const memoryRoot = join(tmpWorkspace, "memory");
    const bufferContents = readFileSync(join(memoryRoot, "buffer.md"), "utf-8");
    expect(bufferContents).toContain("index me please");

    // Archive path is dated; derive from today's date the same way
    // handleRemember does.
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const archiveContents = readFileSync(
      join(memoryRoot, "archive", `${yyyy}-${mm}-${dd}.md`),
      "utf-8",
    );
    expect(archiveContents).toContain("index me please");

    expect(enqueueCalls).toHaveLength(0);
  });

  test("does not write when content is empty", async () => {
    const result = await rememberTool.execute(
      { content: "   " },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(enqueueCalls).toHaveLength(0);
  });
});

describe("rememberTool.execute — batch (array) content", () => {
  beforeEach(() => {
    enqueueCalls.length = 0;
    enqueueShouldThrow = false;
  });

  test("records every fact from an array in the memory buffer", async () => {
    const result = await rememberTool.execute(
      { content: ["batch fact A", "batch fact B"] },
      makeContext(),
    );
    expect(result.isError).toBe(false);

    const bufferContents = readFileSync(
      join(tmpWorkspace, "memory", "buffer.md"),
      "utf-8",
    );
    expect(bufferContents).toContain("batch fact A");
    expect(bufferContents).toContain("batch fact B");

    expect(enqueueCalls).toHaveLength(0);
  });

  test("rejects an all-blank array without writing or enqueueing", async () => {
    const result = await rememberTool.execute(
      { content: ["  ", ""] },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(enqueueCalls).toHaveLength(0);
  });
});

describe("rememberTool definition — page-hint guidance gating", () => {
  // The rest of this file seeds the v2 flag off; restore that seed.
  afterAll(() => {
    setConfig("memory", { v2: { enabled: false } });
  });

  test("omits the [[slug]] hint guidance in v1/PKB mode", () => {
    setConfig("memory", { v2: { enabled: false } });
    expect(
      rememberTool.input_schema.properties.content.description,
    ).not.toContain("[[slug]]");
  });

  test("includes the [[slug]] hint guidance under concept-page memory (v2)", () => {
    setConfig("memory", { v2: { enabled: true } });
    expect(rememberTool.input_schema.properties.content.description).toContain(
      "[[slug]] wikilinks",
    );
    // The gate must survive JSON serialization — that's how the schema
    // reaches the provider wire format.
    expect(JSON.stringify(rememberTool.input_schema)).toContain(
      "[[slug]] wikilinks",
    );
  });

  test("includes the [[slug]] hint guidance when v3 is live with the v2 flag off", () => {
    setConfig("memory", { v2: { enabled: false }, v3: { live: true } });
    expect(rememberTool.input_schema.properties.content.description).toContain(
      "[[slug]] wikilinks",
    );
  });

  test("re-resolves against config on each read, without re-registration", () => {
    const schema = rememberTool.input_schema;
    setConfig("memory", { v2: { enabled: true } });
    expect(schema.properties.content.description).toContain("[[slug]]");
    setConfig("memory", { v2: { enabled: false } });
    expect(schema.properties.content.description).not.toContain("[[slug]]");
  });
});
