import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { installAcpConfigStub } from "../../acp/__tests__/helpers/acp-config-stub.js";
import { installExecFileStub } from "../../acp/__tests__/helpers/exec-file-stub.js";
import { installWhichStub } from "../../acp/__tests__/helpers/which-stub.js";
import type { ToolContext } from "../types.js";

// ---------------------------------------------------------------------------
// Mock infrastructure
// ---------------------------------------------------------------------------

const {
  execScripts,
  execFileMock,
  reset: resetExecFileStub,
} = installExecFileStub();

/** Fixed resolved `bun` path so install script keys are predictable. */
const BUN_BIN = "/usr/local/bin/bun";
const BUN_ADD_KEY = `${BUN_BIN} add`;

// Default ACP config used by these tests: the `unknown-agent` entry is here
// to give the "unmapped binary" tests a configured agent whose command isn't
// in DEFAULT_AGENT_NPM_PACKAGES.
const DEFAULT_TEST_AGENTS = {
  claude: { command: "claude-agent-acp", args: [] },
  codex: { command: "codex-acp", args: [] },
  "unknown-agent": { command: "some-other-binary", args: [] },
};

const config = await installAcpConfigStub();
const which = installWhichStub();

afterAll(() => {
  which.restore();
});

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Stub credential broker + metadata store so `prepareAgentEnv` can resolve
// tokens without the real OS keyring. Driven via `vaultStore` per test in
// beforeEach; the default seeds a vault token so existing tests (which assume
// claude spawns succeed) keep passing.
const vaultStore = new Map<string, string>();
const metadataStore = new Map<
  string,
  { allowedTools: string[]; usageDescription?: string }
>();

mock.module("../credentials/metadata-store.js", () => ({
  getCredentialMetadata: (service: string, field: string) => {
    const key = `${service}/${field}`;
    const entry = metadataStore.get(key);
    if (!entry) return undefined;
    return {
      credentialId: `cred-${key}`,
      service,
      field,
      allowedTools: entry.allowedTools,
      allowedDomains: [],
      usageDescription: entry.usageDescription,
      createdAt: 0,
      updatedAt: 0,
    };
  },
  upsertCredentialMetadata: (
    service: string,
    field: string,
    policy?: { allowedTools?: string[]; usageDescription?: string },
  ) => {
    const key = `${service}/${field}`;
    const existing = metadataStore.get(key);
    metadataStore.set(key, {
      allowedTools: policy?.allowedTools ?? existing?.allowedTools ?? [],
      usageDescription: policy?.usageDescription ?? existing?.usageDescription,
    });
    return {
      credentialId: `cred-${key}`,
      service,
      field,
      allowedTools: metadataStore.get(key)!.allowedTools,
      allowedDomains: [],
      createdAt: 0,
      updatedAt: 0,
    };
  },
}));

mock.module("../credentials/broker.js", () => ({
  credentialBroker: {
    serverUse: async <T>(request: {
      service: string;
      field: string;
      toolName: string;
      execute: (value: string) => Promise<T>;
    }) => {
      const key = `${request.service}/${request.field}`;
      const meta = metadataStore.get(key);
      if (!meta) {
        return { success: false, reason: `No credential found for ${key}` };
      }
      if (!meta.allowedTools.includes(request.toolName)) {
        return {
          success: false,
          reason: `Tool "${request.toolName}" not allowed`,
        };
      }
      const value = vaultStore.get(key);
      if (!value) {
        return { success: false, reason: `No stored value for ${key}` };
      }
      const result = await request.execute(value);
      return { success: true, result };
    },
  },
}));

// Stub session manager so we don't actually spawn child processes.
const spawnMock = mock(
  async (
    _agentId: string,
    _agentConfig: unknown,
    _task: string,
    _cwd: string,
    _parentConversationId: string,
    _sendToVellum: (msg: unknown) => void,
    _parentToolUseId?: string,
  ) => ({
    acpSessionId: "acp-session-test",
    protocolSessionId: "proto-session-test",
  }),
);

// Spread the real module's exports so transitive importers that pull other
// names from `../../acp/index.js` still resolve at parse time. Bun's `mock.module` is
// process-global and returns *exactly* the keys the factory returns —
// without the spread, any module evaluated after this test file errors at
// load with "Export named '<X>' not found".
const realAcpModule = await import("../../acp/index.js");
mock.module("../../acp/index.js", () => ({
  ...realAcpModule,
  getAcpSessionManager: () => ({ spawn: spawnMock }),
}));

const { executeAcpSpawn } = await import("./spawn.js");
const { _resetAdapterInstallCacheForTests } =
  await import("../../acp/auto-install.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(): ToolContext {
  return {
    workingDir: "/tmp",
    conversationId: "test-conversation",
    trustClass: "guardian",
    sendToClient: () => {},
  } as ToolContext;
}

beforeEach(() => {
  resetExecFileStub();
  spawnMock.mockClear();
  _resetAdapterInstallCacheForTests();
  config.setConfig({ agents: DEFAULT_TEST_AGENTS });
  // Default: every command (including bun and the adapters) on PATH, so
  // spawns resolve directly with no install.
  which.setWhich((cmd) => `/usr/local/bin/${cmd}`);
  // Default: vault has a claude token so the preflight in `prepareAgentEnv`
  // succeeds for tests that don't care about env injection. Env-injection
  // tests below clear/override this explicitly.
  vaultStore.clear();
  metadataStore.clear();
  vaultStore.set("acp/claude_oauth_token", "default-test-token");
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("executeAcpSpawn - happy path", () => {
  test("binary on PATH: spawns directly with no install and no npm probe", async () => {
    const result = await executeAcpSpawn(
      { agent: "claude", task: "do something" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    // No package manager is ever invoked when the binary is already present.
    expect(execFileMock).not.toHaveBeenCalled();
    expect(result.content).not.toContain("outdated");
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(result.content);
    expect(payload.acpSessionId).toBe("acp-session-test");
    expect(payload.status).toBe("running");
    // The real adapter binary is spawned (no `bun x` wrapper).
    const agentConfigArg = spawnMock.mock.calls[0][1] as { command: string };
    expect(agentConfigArg.command).toBe("claude-agent-acp");
  });

  test("threads the executing tool-use id into manager.spawn as parentToolUseId", async () => {
    const result = await executeAcpSpawn(
      { agent: "claude", task: "do something" },
      { ...makeContext(), toolUseId: "toolu_abc123" },
    );

    expect(result.isError).toBe(false);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    // parentToolUseId is the 7th positional arg to spawn().
    expect(spawnMock.mock.calls[0][6]).toBe("toolu_abc123");
  });

  test("default-profile fallback when user config is empty", async () => {
    // No user `agents.codex` entry, but `agent: "codex"` works via the bundled
    // default profile (command: "codex-acp"). The resolver merges defaults
    // automatically.
    config.setConfig({ agents: {} });

    const result = await executeAcpSpawn(
      { agent: "codex", task: "do something" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const agentConfigArg = spawnMock.mock.calls[0][1] as { command: string };
    expect(agentConfigArg.command).toBe("codex-acp");
  });
});

describe("executeAcpSpawn — input validation", () => {
  test("missing task returns error", async () => {
    const result = await executeAcpSpawn({ agent: "claude" }, makeContext());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("task");
  });

  test("missing sendToClient returns error", async () => {
    const result = await executeAcpSpawn(
      { agent: "claude", task: "do something" },
      { ...makeContext(), sendToClient: undefined },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("No client connected");
  });

  test("unknown agent in config returns error", async () => {
    const result = await executeAcpSpawn(
      { agent: "nonexistent", task: "do something" },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Unknown agent "nonexistent"');
    // New error message lists the merged catalog (defaults + user agents).
    expect(result.content).toContain("Available:");
  });

  test("missing binary + bun absent returns install hint, no install attempted", async () => {
    which.setWhich({}); // neither bun nor the adapter on PATH
    const result = await executeAcpSpawn(
      { agent: "claude", task: "do something" },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("claude-agent-acp is not on PATH");
    expect(result.content).toContain(
      "bun add -g @agentclientprotocol/claude-agent-acp",
    );
    expect(execFileMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe("executeAcpSpawn: sandboxed bun auto-install on missing binary", () => {
  test("known command + bun present: installs via bun and spawn proceeds with a note", async () => {
    // Only bun is on PATH until `bun add --global` runs, simulating a
    // successful global install that links the adapter bin onto PATH.
    let binaryOnPath = false;
    which.setWhich((cmd) => {
      if (cmd === "bun") return BUN_BIN;
      if (binaryOnPath) return `/usr/local/bin/${cmd}`;
      return null;
    });
    execScripts.set(BUN_ADD_KEY, {
      stdout: "",
      onCall: () => {
        binaryOnPath = true;
      },
    });

    const result = await executeAcpSpawn(
      { agent: "claude", task: "do something" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(result.content);
    expect(payload.message).toContain(
      "Installed @agentclientprotocol/claude-agent-acp automatically.",
    );
    // The real binary was spawned with cwd = the project dir and token
    // injected (trusted-binary config, no resolution at spawn).
    const agentConfigArg = spawnMock.mock.calls[0][1] as {
      command: string;
      env?: Record<string, string>;
    };
    expect(agentConfigArg.command).toBe("claude-agent-acp");
    expect(agentConfigArg.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe(
      "default-test-token",
    );
    expect(spawnMock.mock.calls[0][3]).toBe("/tmp");

    // Exactly one install, and it was `bun add --global` (never npm).
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [command, args] = execFileMock.mock.calls[0];
    expect(command).toBe(BUN_BIN);
    expect(args).toEqual([
      "add",
      "--global",
      "@agentclientprotocol/claude-agent-acp",
    ]);
  });

  test("the installer cwd is a temp dir (not the project cwd) with secrets stripped", async () => {
    let binaryOnPath = false;
    which.setWhich((cmd) => {
      if (cmd === "bun") return BUN_BIN;
      if (binaryOnPath) return `/usr/local/bin/${cmd}`;
      return null;
    });
    execScripts.set(BUN_ADD_KEY, {
      stdout: "",
      onCall: () => {
        binaryOnPath = true;
      },
    });

    await executeAcpSpawn(
      { agent: "claude", task: "do something", cwd: "/untrusted/project" },
      makeContext(),
    );

    const options = execFileMock.mock.calls[0][2] as {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
    };
    expect(options.cwd).toBeDefined();
    expect(options.cwd).not.toBe("/untrusted/project");
    expect(options.cwd).toContain("vellum-acp-install-");
    expect(options.env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(options.env?.GEMINI_API_KEY).toBeUndefined();
    expect(options.env?.BUN_CONFIG_REGISTRY).toBe(
      "https://registry.npmjs.org/",
    );
  });

  test("unmapped command: no install attempted, plain hint returned", async () => {
    which.setWhich({});

    const result = await executeAcpSpawn(
      { agent: "unknown-agent", task: "do something" },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("some-other-binary is not on PATH");
    expect(result.content).toContain("Install 'some-other-binary'");
    expect(result.content).not.toContain("auto-install failed");
    expect(execFileMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  test("no client connected: no install attempted even when the binary is missing", async () => {
    // The no-client guard is a pure precondition and must run BEFORE the
    // auto-install side effect: without a client the spawn fails anyway, so
    // the host must not be mutated by a global install (which can also block
    // for up to the install timeout).
    which.setWhich({ bun: BUN_BIN });

    const result = await executeAcpSpawn(
      { agent: "claude", task: "do something" },
      { ...makeContext(), sendToClient: undefined },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("No client connected");
    expect(execFileMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  test("install failure: hint and install failure both surface, never npm", async () => {
    which.setWhich({ bun: BUN_BIN }); // bun present, adapter never appears
    execScripts.set(BUN_ADD_KEY, {
      error: new Error("EACCES: permission denied"),
    });

    const result = await executeAcpSpawn(
      { agent: "claude", task: "do something" },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("claude-agent-acp is not on PATH");
    expect(result.content).toContain(
      "bun add -g @agentclientprotocol/claude-agent-acp",
    );
    expect(result.content).toContain("auto-install failed");
    expect(result.content).toContain("EACCES");
    for (const call of execFileMock.mock.calls) {
      expect(call[0]).not.toBe("npm");
    }
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe("executeAcpSpawn — per-agent resume hint", () => {
  test("claude payload includes the `claude --resume` hint", async () => {
    const result = await executeAcpSpawn(
      { agent: "claude", task: "do something" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content);
    expect(payload.message).toContain("claude --resume");
    expect(payload.message).toContain("To resume:");
  });

  test("non-claude payload omits the `claude --resume` hint", async () => {
    // `claude --resume <id>` is Claude Code-specific. Codex (and any other
    // adapter) should not have that command suggested back to the user.
    const result = await executeAcpSpawn(
      { agent: "codex", task: "do something" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content);
    expect(payload.message).not.toContain("claude --resume");
    expect(payload.message).not.toContain("To resume:");
  });
});

// ---------------------------------------------------------------------------
// executeAcpSpawn — CLAUDE_CODE_OAUTH_TOKEN env injection + preflight
//
// Mirrors the HTTP-route test block in
// `runtime/routes/acp-routes.test.ts` — the skill tool calls into the same
// `prepareAgentEnv` helper, and the contract must be identical so a
// missing token fails the spawn at the tool boundary (`isError: true`)
// instead of letting a token-less subprocess zombie out. PR-history
// context: the inline env-injection used to live in the route only; this
// tool path was bypassing it entirely, causing every skill-driven ACP
// spawn to die on first prompt with "Authentication required". Pin both
// the happy paths and the throw path here so future drift on either
// caller fails the suite loudly.
// ---------------------------------------------------------------------------

describe("executeAcpSpawn — CLAUDE_CODE_OAUTH_TOKEN injection", () => {
  test("injects CLAUDE_CODE_OAUTH_TOKEN from the vault via the broker for the claude agent", async () => {
    vaultStore.clear();
    metadataStore.clear();
    vaultStore.set("acp/claude_oauth_token", "tool-vault-token-abc");

    const result = await executeAcpSpawn(
      { agent: "claude", task: "do something" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const agentConfigArg = spawnMock.mock.calls[0][1] as {
      env?: Record<string, string>;
    };
    expect(agentConfigArg.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe(
      "tool-vault-token-abc",
    );
  });

  test("accepts CLAUDE_CODE_OAUTH_TOKEN from config.json agent.env without a vault entry", async () => {
    vaultStore.clear();
    metadataStore.clear();
    config.setConfig({
      agents: {
        claude: {
          command: "claude-agent-acp",
          args: [],
          env: { CLAUDE_CODE_OAUTH_TOKEN: "tool-config-token-xyz" },
        },
        codex: { command: "codex-acp", args: [] },
        "unknown-agent": { command: "some-other-binary", args: [] },
      },
    });

    const result = await executeAcpSpawn(
      { agent: "claude", task: "do something" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    const agentConfigArg = spawnMock.mock.calls[0][1] as {
      env?: Record<string, string>;
    };
    expect(agentConfigArg.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe(
      "tool-config-token-xyz",
    );
  });

  test("returns isError when no token is available from either route (preflight throw mapped to tool result)", async () => {
    vaultStore.clear();
    metadataStore.clear();

    const result = await executeAcpSpawn(
      { agent: "claude", task: "do something" },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
