import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import { installAcpConfigStub } from "./__tests__/helpers/acp-config-stub.js";
import { installWhichStub } from "./__tests__/helpers/which-stub.js";

const config = await installAcpConfigStub();
const which = installWhichStub();

afterAll(() => {
  which.restore();
});

const { resolveAcpAgent, listAcpAgents } = await import("./resolve-agent.js");

beforeEach(() => {
  config.setConfig({});
  // Default: every command on PATH so binary preflight passes unless a test
  // explicitly says otherwise.
  which.setWhich((cmd) => `/usr/local/bin/${cmd}`);
});

// ---------------------------------------------------------------------------
// resolveAcpAgent
// ---------------------------------------------------------------------------

describe("resolveAcpAgent", () => {
  test("user config wins over default profile", () => {
    config.setConfig({
      agents: {
        claude: {
          command: "my-custom-claude",
          args: ["--my-flag"],
          description: "user override",
        },
      },
    });

    const result = resolveAcpAgent("claude");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.agent.command).toBe("my-custom-claude");
    expect(result.agent.args).toEqual(["--my-flag"]);
    expect(result.agent.description).toBe("user override");
  });

  test("falls back to default profile when no user entry", () => {
    config.setConfig({ agents: {} });

    const result = resolveAcpAgent("codex");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.agent.command).toBe("codex-acp");
    expect(result.agent.description).toContain("@zed-industries/codex-acp");
  });

  test("falls back to default profile for claude when no user entry", () => {
    config.setConfig({ agents: {} });

    const result = resolveAcpAgent("claude");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.agent.command).toBe("claude-agent-acp");
  });

  test.each([
    ["claude code", "claude-agent-acp"],
    ["Claude Code", "claude-agent-acp"],
    ["claude-code", "claude-agent-acp"],
    ["claude_code", "claude-agent-acp"],
    ["codex cli", "codex-acp"],
    ["OpenAI Codex", "codex-acp"],
  ])("alias %p resolves to the %p profile", (alias, command) => {
    config.setConfig({ agents: {} });

    const result = resolveAcpAgent(alias);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.agent.command).toBe(command);
  });

  test("user config entry literally keyed 'claude code' beats the alias", () => {
    config.setConfig({
      agents: {
        "claude code": {
          command: "my-claude-fork",
          args: [],
          description: "user-defined agent that happens to share an alias",
        },
      },
    });

    const result = resolveAcpAgent("claude code");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.agent.command).toBe("my-claude-fork");
  });

  test("alias re-runs the normal lookup, so a user override of the canonical id wins", () => {
    config.setConfig({
      agents: {
        claude: { command: "my-custom-claude", args: [] },
      },
    });

    const result = resolveAcpAgent("claude code");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.agent.command).toBe("my-custom-claude");
  });

  test("non-alias unknown id still returns unknown_agent", () => {
    config.setConfig({ agents: {} });

    const result = resolveAcpAgent("cursor cli");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unknown_agent");
  });

  test("returns unknown_agent with merged available list when id not found", () => {
    config.setConfig({
      agents: {
        "user-only": { command: "some-binary", args: [] },
      },
    });

    const result = resolveAcpAgent("nonexistent");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unknown_agent");
    if (result.reason !== "unknown_agent") return;
    // Defaults plus user-only ids, deduped, in stable order (defaults first).
    expect(result.available).toEqual(["claude", "codex", "user-only"]);
  });

  test("unknown_agent available list contains both defaults when user config is empty", () => {
    config.setConfig({ agents: {} });

    const result = resolveAcpAgent("nonexistent");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unknown_agent");
    if (result.reason !== "unknown_agent") return;
    expect(result.available).toContain("claude");
    expect(result.available).toContain("codex");
  });

  test("returns binary_not_found with the registered install hint", () => {
    config.setConfig({ agents: {} });
    which.setWhich({}); // no commands on PATH

    const result = resolveAcpAgent("claude");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("binary_not_found");
    if (result.reason !== "binary_not_found") return;
    expect(result.hint).toBe("bun add -g @agentclientprotocol/claude-agent-acp");
    expect(result.command).toBe("claude-agent-acp");
  });

  test("binary_not_found uses generic hint for user-only commands without a registered hint", () => {
    config.setConfig({
      agents: {
        custom: { command: "unknown-binary", args: [] },
      },
    });
    which.setWhich({});

    const result = resolveAcpAgent("custom");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("binary_not_found");
    if (result.reason !== "binary_not_found") return;
    expect(result.hint).toBe(
      "Install 'unknown-binary' and ensure it is on PATH.",
    );
    expect(result.command).toBe("unknown-binary");
  });

  test("binary_not_found uses the install hint based on the resolved command, not the agent id", () => {
    // User aliases id "claude" to the codex binary — the install hint should
    // follow the binary, not the id.
    config.setConfig({
      agents: {
        claude: { command: "codex-acp", args: [] },
      },
    });
    which.setWhich({});

    const result = resolveAcpAgent("claude");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("binary_not_found");
    if (result.reason !== "binary_not_found") return;
    expect(result.hint).toBe("bun add -g @zed-industries/codex-acp");
  });

  test("binary preflight honors agent.env.PATH override (matches spawn env)", () => {
    // The actual spawn merges `agentConfig.env` into the child env, so a
    // per-agent PATH override wins over the daemon's PATH. The preflight
    // must use the same PATH or it will reject configs that would have
    // spawned successfully.
    config.setConfig({
      agents: {
        custom: {
          command: "my-binary",
          args: [],
          env: { PATH: "/opt/custom/bin" },
        },
      },
    });
    which.setWhich((cmd, options) =>
      cmd === "my-binary" && options?.PATH === "/opt/custom/bin"
        ? "/opt/custom/bin/my-binary"
        : null,
    );

    const result = resolveAcpAgent("custom");

    expect(result.ok).toBe(true);
  });

  test("ok result when user config provides agent and binary is on PATH", () => {
    config.setConfig({
      agents: {
        codex: { command: "codex-acp", args: ["--verbose"] },
      },
    });
    which.setWhich({ "codex-acp": "/opt/bin/codex-acp" });

    const result = resolveAcpAgent("codex");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.agent.args).toEqual(["--verbose"]);
  });

  test("resolves a full-path command directly without rewriting it", () => {
    config.setConfig({
      agents: {
        custom: { command: "/opt/bin/claude-agent-acp", args: [] },
      },
    });

    const direct = resolveAcpAgent("claude");
    expect(direct.ok).toBe(true);
    if (!direct.ok) return;
    expect(direct.agent.command).toBe("claude-agent-acp");

    const fullPath = resolveAcpAgent("custom");
    expect(fullPath.ok).toBe(true);
    if (!fullPath.ok) return;
    expect(fullPath.agent.command).toBe("/opt/bin/claude-agent-acp");
  });
});

// ---------------------------------------------------------------------------
// resolveAcpAgent - missing binaries are never run from the task cwd
// ---------------------------------------------------------------------------

describe("resolveAcpAgent - missing binary", () => {
  test("binary missing + bun present: still binary_not_found (no bunx rewrite)", () => {
    // bun on PATH no longer makes a missing adapter "runnable" at resolve
    // time: the sandboxed install happens separately, never as a `bun x`
    // rewrite in the untrusted cwd.
    config.setConfig({ agents: {} });
    which.setWhich({ bun: "/usr/local/bin/bun" });

    const result = resolveAcpAgent("claude");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("binary_not_found");
    if (result.reason !== "binary_not_found") return;
    expect(result.command).toBe("claude-agent-acp");
    expect(result.hint).toBe("bun add -g @agentclientprotocol/claude-agent-acp");
  });

  test("binary missing + bun missing: binary_not_found with the bun hint", () => {
    config.setConfig({ agents: {} });
    which.setWhich({});

    const result = resolveAcpAgent("claude");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("binary_not_found");
    if (result.reason !== "binary_not_found") return;
    expect(result.hint).toBe("bun add -g @agentclientprotocol/claude-agent-acp");
  });
});

// ---------------------------------------------------------------------------
// listAcpAgents
// ---------------------------------------------------------------------------

describe("listAcpAgents", () => {
  test("includes all bundled defaults when user config is empty", () => {
    config.setConfig({ agents: {} });

    const result = listAcpAgents();

    const ids = result.agents.map((a) => a.id);
    expect(ids).toEqual(["claude", "codex"]);
    for (const entry of result.agents) {
      expect(entry.source).toBe("default");
      expect(entry.available).toBe(true);
      expect(entry.unavailableReason).toBeUndefined();
      expect(entry.setupHint).toBeUndefined();
    }
  });

  test("user override flips source to 'config' for the overridden id", () => {
    config.setConfig({
      agents: {
        claude: {
          command: "my-claude",
          args: [],
          description: "custom",
        },
      },
    });
    which.setWhich({
      "my-claude": "/usr/bin/my-claude",
      "codex-acp": "/usr/bin/codex-acp",
    });

    const result = listAcpAgents();

    const claude = result.agents.find((a) => a.id === "claude");
    const codex = result.agents.find((a) => a.id === "codex");
    expect(claude?.source).toBe("config");
    expect(claude?.command).toBe("my-claude");
    expect(claude?.description).toBe("custom");
    expect(codex?.source).toBe("default");
  });

  test("missing binaries are listed unavailable even when bun is present", () => {
    // bun presence no longer makes a missing adapter available: it is
    // installed on demand at spawn time, not run via `bun x` from the cwd.
    config.setConfig({ agents: {} });
    which.setWhich({ bun: "/usr/local/bin/bun" });

    const result = listAcpAgents();

    for (const entry of result.agents) {
      expect(entry.available).toBe(false);
      expect(entry.unavailableReason).toBeDefined();
      expect(entry.setupHint).toContain("bun add -g");
    }
    // The catalog keeps the canonical adapter commands.
    expect(result.agents.map((a) => a.command)).toEqual([
      "claude-agent-acp",
      "codex-acp",
    ]);
  });

  test("unavailable agent surfaces install hint derived from DEFAULT_AGENT_NPM_PACKAGES", () => {
    config.setConfig({ agents: {} });
    which.setWhich({ "claude-agent-acp": "/usr/bin/claude-agent-acp" });

    const result = listAcpAgents();

    const codex = result.agents.find((a) => a.id === "codex");
    expect(codex?.available).toBe(false);
    expect(codex?.unavailableReason).toBe("'codex-acp' is not on PATH");
    expect(codex?.setupHint).toBe("bun add -g @zed-industries/codex-acp");
  });

  test("aliases are resolution sugar, not catalog entries", () => {
    config.setConfig({ agents: {} });

    // "codex cli" resolves via the alias...
    expect(resolveAcpAgent("codex cli").ok).toBe(true);

    // ...but the catalog lists only canonical ids.
    const ids = listAcpAgents().agents.map((a) => a.id);
    expect(ids).toEqual(["claude", "codex"]);
  });

  test("user-only agent appended after defaults in stable order", () => {
    config.setConfig({
      agents: {
        "my-agent": {
          command: "my-binary",
          args: [],
          description: "user-only",
        },
      },
    });
    which.setWhich({
      "claude-agent-acp": "/x",
      "codex-acp": "/x",
      "my-binary": "/x",
    });

    const result = listAcpAgents();

    expect(result.agents.map((a) => a.id)).toEqual([
      "claude",
      "codex",
      "my-agent",
    ]);
    const userOnly = result.agents[2];
    expect(userOnly.source).toBe("config");
    expect(userOnly.description).toBe("user-only");
  });

  test("unavailable user-only agent without registered hint falls back to generic install hint", () => {
    config.setConfig({
      agents: {
        custom: { command: "unknown-binary", args: [] },
      },
    });
    which.setWhich({ "claude-agent-acp": "/x", "codex-acp": "/x" });

    const result = listAcpAgents();

    const custom = result.agents.find((a) => a.id === "custom");
    expect(custom?.available).toBe(false);
    expect(custom?.setupHint).toBe(
      "Install 'unknown-binary' and ensure it is on PATH.",
    );
  });
});
