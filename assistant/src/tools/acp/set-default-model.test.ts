import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { getConfig, invalidateConfigCache } from "../../config/loader.js";
import type { ToolContext } from "../types.js";
import { executeAcpSetDefaultModel } from "./set-default-model.js";

const WORKSPACE_DIR = process.env.VELLUM_WORKSPACE_DIR!;
const CONFIG_PATH = join(WORKSPACE_DIR, "config.json");

function writeConfig(obj: unknown): void {
  if (!existsSync(WORKSPACE_DIR)) {
    mkdirSync(WORKSPACE_DIR, { recursive: true });
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(obj));
  invalidateConfigCache();
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Record<
    string,
    unknown
  >;
}

function acpSection(): Record<string, unknown> | undefined {
  return readConfig().acp as Record<string, unknown> | undefined;
}

function agentEntry(id: string): Record<string, unknown> | undefined {
  const agents = acpSection()?.agents as
    | Record<string, Record<string, unknown>>
    | undefined;
  return agents?.[id];
}

function makeContext(): ToolContext {
  return { conversationId: "conv-test" } as ToolContext;
}

beforeEach(() => {
  writeConfig({});
});

afterEach(() => {
  writeConfig({});
});

describe("acp_set_default_model - the global default", () => {
  test("writes acp.defaultModel and says it applies to new sessions", async () => {
    const result = await executeAcpSetDefaultModel(
      { model: "opus" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain(
      'The default coding-agent model is now "opus"',
    );
    expect(result.content).toContain("new sessions");
    expect(acpSection()?.defaultModel).toBe("opus");
    expect(getConfig().acp.defaultModel).toBe("opus");
  });

  test("trims the value before writing it", async () => {
    await executeAcpSetDefaultModel({ model: "  sonnet " }, makeContext());

    expect(acpSection()?.defaultModel).toBe("sonnet");
  });

  test("null removes the key rather than persisting null", async () => {
    writeConfig({ acp: { defaultModel: "opus" } });

    const result = await executeAcpSetDefaultModel(
      { model: null },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("No default coding-agent model is set");
    const acp = acpSection();
    expect(acp).toBeDefined();
    expect("defaultModel" in acp!).toBe(false);
    expect(getConfig().acp.defaultModel).toBeUndefined();
  });

  test("clearing an unset default writes nothing", async () => {
    const result = await executeAcpSetDefaultModel(
      { model: null },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(readConfig()).toEqual({});
  });
});

describe("acp_set_default_model - a single agent", () => {
  test("writes acp.agents.<id>.model and seeds the command the schema requires", async () => {
    const result = await executeAcpSetDefaultModel(
      { model: "opus", agent: "claude" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain(
      'Agent "claude" now starts new sessions on "opus"',
    );
    expect(agentEntry("claude")).toEqual({
      command: "claude-agent-acp",
      model: "opus",
    });
    expect(getConfig().acp.agents.claude?.model).toBe("opus");
  });

  test("a natural agent name resolves to the canonical config key", async () => {
    await executeAcpSetDefaultModel(
      { model: "opus", agent: "claude code" },
      makeContext(),
    );

    expect(agentEntry("claude")?.model).toBe("opus");
    expect(agentEntry("claude code")).toBeUndefined();
  });

  test("an existing entry keeps its own command and args", async () => {
    writeConfig({
      acp: { agents: { claude: { command: "my-adapter", args: ["--x"] } } },
    });

    await executeAcpSetDefaultModel(
      { model: "sonnet", agent: "claude" },
      makeContext(),
    );

    expect(agentEntry("claude")).toEqual({
      command: "my-adapter",
      args: ["--x"],
      model: "sonnet",
    });
  });

  test("null removes the agent's model and leaves the rest of the entry", async () => {
    writeConfig({
      acp: { agents: { codex: { command: "codex-acp", model: "gpt-5" } } },
    });

    const result = await executeAcpSetDefaultModel(
      { model: null, agent: "codex" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Agent "codex" has no model of its own');
    expect(agentEntry("codex")).toEqual({ command: "codex-acp" });
    expect(getConfig().acp.agents.codex?.model).toBeUndefined();
  });

  test("clearing an agent with no entry does not materialize one", async () => {
    const result = await executeAcpSetDefaultModel(
      { model: null, agent: "claude" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(readConfig()).toEqual({});
  });

  test("an unknown agent is rejected with the configured agents", async () => {
    const result = await executeAcpSetDefaultModel(
      { model: "opus", agent: "gemini" },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Unknown agent "gemini"');
    expect(result.content).toContain("claude");
    expect(result.content).toContain("codex");
    expect(readConfig()).toEqual({});
  });
});

describe("acp_set_default_model - hostile agent ids", () => {
  // A dotted path would split these into nested objects; `__proto__` would
  // walk onto the prototype itself.
  test("an id containing a dot addresses one literal agents key", async () => {
    writeConfig({
      acp: { agents: { "team.agent": { command: "custom-acp" } } },
    });

    const result = await executeAcpSetDefaultModel(
      { model: "opus", agent: "team.agent" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(agentEntry("team.agent")).toEqual({
      command: "custom-acp",
      model: "opus",
    });
    expect(agentEntry("team")).toBeUndefined();
    expect(getConfig().acp.agents["team.agent"]?.model).toBe("opus");
  });

  test("clearing an id containing a dot removes only that entry's model", async () => {
    writeConfig({
      acp: {
        agents: { "team.agent": { command: "custom-acp", model: "opus" } },
      },
    });

    const result = await executeAcpSetDefaultModel(
      { model: null, agent: "team.agent" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(agentEntry("team.agent")).toEqual({ command: "custom-acp" });
    expect(agentEntry("team")).toBeUndefined();
  });

  for (const id of ["__proto__", "constructor", "prototype"]) {
    test(`"${id}" is rejected and touches neither config nor Object.prototype`, async () => {
      const result = await executeAcpSetDefaultModel(
        { model: "opus", agent: id },
        makeContext(),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain(`Unknown agent "${id}"`);
      expect(readConfig()).toEqual({});
      const untouched: Record<string, unknown> = {};
      expect(untouched.model).toBeUndefined();
      expect(untouched.command).toBeUndefined();
    });
  }
});

describe("acp_set_default_model - input validation", () => {
  test("an omitted model is a caller mistake, not a clear", async () => {
    const result = await executeAcpSetDefaultModel({}, makeContext());

    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      'Invalid input for tool "acp_set_default_model"',
    );
    expect(readConfig()).toEqual({});
  });

  test("a blank model is rejected", async () => {
    const result = await executeAcpSetDefaultModel(
      { model: "   " },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Pass a model in "model"');
    expect(readConfig()).toEqual({});
  });

  test("an explicitly blank agent is an error, not the global default", async () => {
    const result = await executeAcpSetDefaultModel(
      { model: "opus", agent: "" },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      'Invalid input for tool "acp_set_default_model"',
    );
    expect(result.content).toContain("agent");
    expect(readConfig()).toEqual({});
  });

  test("a whitespace-only agent is an error, not the global default", async () => {
    const result = await executeAcpSetDefaultModel(
      { model: "opus", agent: "   " },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      'Invalid input for tool "acp_set_default_model"',
    );
    expect(readConfig()).toEqual({});
  });

  test("an explicitly null agent still means the global default", async () => {
    const result = await executeAcpSetDefaultModel(
      { model: "opus", agent: null },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(acpSection()?.defaultModel).toBe("opus");
    expect(acpSection()?.agents).toBeUndefined();
  });

  test("a padded agent id is trimmed before it is resolved", async () => {
    const result = await executeAcpSetDefaultModel(
      { model: "opus", agent: "  claude  " },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(agentEntry("claude")?.model).toBe("opus");
  });

  test("rejects a non-string model", async () => {
    const result = await executeAcpSetDefaultModel({ model: 7 }, makeContext());

    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      'Invalid input for tool "acp_set_default_model"',
    );
  });
});
