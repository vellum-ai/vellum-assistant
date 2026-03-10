import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";

import type {
  AllowlistOption,
  PolicyContext,
  ScopeOption,
  TrustRule,
} from "../permissions/types.js";
import { RiskLevel } from "../permissions/types.js";
import type {
  Tool,
  ToolExecutionResult,
  ToolLifecycleEvent,
  ToolPermissionPromptEvent,
} from "../tools/types.js";

const mockConfig = {
  provider: "anthropic",
  model: "test",
  apiKeys: {},
  maxTokens: 4096,
  dataDir: "/tmp",
  timeouts: {
    shellDefaultTimeoutSec: 120,
    shellMaxTimeoutSec: 600,
    permissionTimeoutSec: 300,
  },
  sandbox: {
    enabled: false,
    backend: "native" as const,
    docker: {
      image: "vellum-sandbox:latest",
      cpus: 1,
      memoryMb: 512,
      pidsLimit: 256,
      network: "none" as const,
    },
  },
  rateLimit: { maxRequestsPerMinute: 0, maxTokensPerSession: 0 },
  secretDetection: {
    enabled: false,
    action: "warn" as const,
    entropyThreshold: 4.0,
  },
};

let fakeToolResult: ToolExecutionResult = { content: "ok", isError: false };

/** Captured arguments from the last check() call, for assertion in tests. */
let lastCheckArgs:
  | {
      toolName: string;
      input: Record<string, unknown>;
      workingDir: string;
      policyContext?: PolicyContext;
    }
  | undefined;

/** Optional override for getTool — lets tests supply skill-origin tools. */
let getToolOverride: ((name: string) => Tool | undefined) | undefined;

/** Override the check() result for tests that need to trigger prompting. */
let checkResultOverride: { decision: string; reason: string } | undefined;

/** Function override for check() — when set, takes precedence over the static override. */
let checkFnOverride:
  | ((
      toolName: string,
      input: Record<string, unknown>,
      workingDir: string,
      policyContext?: PolicyContext,
    ) => Promise<{ decision: string; reason: string }>)
  | undefined;

/** Override for generateScopeOptions — when set, returns this value instead of the default. */
let scopeOptionsOverride: ScopeOption[] | undefined;

/** Spy on addRule to capture calls without replacing the real implementation. */
let addRuleSpy: ReturnType<typeof spyOn> | undefined;

mock.module("../config/loader.js", () => ({
  getConfig: () => mockConfig,
  loadConfig: () => mockConfig,
  invalidateConfigCache: () => {},
  saveConfig: () => {},
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  getNestedValue: () => undefined,
  setNestedValue: () => {},
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
  isDebug: () => false,
  truncateForLog: (value: string) => value,
}));

mock.module("../permissions/checker.js", () => ({
  classifyRisk: async () => "low",
  check: async (
    toolName: string,
    input: Record<string, unknown>,
    workingDir: string,
    policyContext?: PolicyContext,
  ) => {
    lastCheckArgs = { toolName, input, workingDir, policyContext };
    if (checkFnOverride)
      return checkFnOverride(toolName, input, workingDir, policyContext);
    if (checkResultOverride) return checkResultOverride;
    return { decision: "allow", reason: "allowed" };
  },
  generateAllowlistOptions: () => [
    { label: "exact", description: "exact", pattern: "exact" },
  ],
  generateScopeOptions: () =>
    scopeOptionsOverride ?? [{ label: "/tmp", scope: "/tmp" }],
}));

mock.module("../memory/tool-usage-store.js", () => ({
  recordToolInvocation: () => {},
}));

mock.module("../tools/registry.js", () => ({
  getTool: (name: string) => {
    if (getToolOverride) return getToolOverride(name);
    if (name === "unknown_tool") return undefined;
    return {
      name,
      description: "test tool",
      category: "test",
      defaultRiskLevel: "low",
      getDefinition: () => ({}),
      execute: async () => fakeToolResult,
    };
  },
  getAllTools: () => [],
}));

mock.module("../tools/shared/filesystem/path-policy.js", () => ({
  sandboxPolicy: () => ({ ok: false }),
  hostPolicy: () => ({ ok: false }),
}));

mock.module("../tools/terminal/sandbox.js", () => ({
  wrapCommand: () => ({ command: "", sandboxed: false }),
}));

import { PermissionPrompter } from "../permissions/prompter.js";
import * as trustStore from "../permissions/trust-store.js";
import { isSideEffectTool, ToolExecutor } from "../tools/executor.js";
import type { ToolContext } from "../tools/types.js";

function makeContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    workingDir: "/tmp/project",
    sessionId: "session-1",
    conversationId: "conversation-1",
    trustClass: "guardian",
    ...overrides,
  };
}

function makePrompter(): PermissionPrompter {
  return {
    prompt: async () => ({ decision: "allow" as const }),
    resolveConfirmation: () => {},
    updateSender: () => {},
    dispose: () => {},
  } as unknown as PermissionPrompter;
}

afterAll(() => {
  mock.restore();
});

describe("ToolExecutor allowedToolNames gating", () => {
  beforeEach(() => {
    fakeToolResult = { content: "ok", isError: false };
    lastCheckArgs = undefined;
    getToolOverride = undefined;
    checkResultOverride = undefined;
    checkFnOverride = undefined;
    if (addRuleSpy) {
      addRuleSpy.mockRestore();
      addRuleSpy = undefined;
    }
  });

  test("executes normally when allowedToolNames is not set (backward compat)", async () => {
    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      "file_read",
      { path: "README.md" },
      makeContext(),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toBe("ok");
  });

  test("executes normally when tool is in the allowed set", async () => {
    const executor = new ToolExecutor(makePrompter());
    const allowed = new Set(["file_read", "file_write", "bash"]);
    const result = await executor.execute(
      "file_read",
      { path: "README.md" },
      makeContext({ allowedToolNames: allowed }),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toBe("ok");
  });

  test("blocks execution when tool is NOT in the allowed set", async () => {
    const executor = new ToolExecutor(makePrompter());
    const allowed = new Set(["file_read", "bash"]);
    const result = await executor.execute(
      "file_write",
      { path: "test.txt", content: "hello" },
      makeContext({ allowedToolNames: allowed }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not currently active");
  });

  test("error message includes the blocked tool name", async () => {
    const executor = new ToolExecutor(makePrompter());
    const allowed = new Set(["bash"]);
    const result = await executor.execute(
      "file_edit",
      { path: "x" },
      makeContext({ allowedToolNames: allowed }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toBe(
      'Tool "file_edit" is not currently active. Load the skill that provides this tool first.',
    );
  });

  test("empty allowed set blocks all tools", async () => {
    const executor = new ToolExecutor(makePrompter());
    const allowed = new Set<string>();
    const result = await executor.execute(
      "file_read",
      { path: "README.md" },
      makeContext({ allowedToolNames: allowed }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("file_read");
    expect(result.content).toContain("not currently active");
  });
});

describe("ToolExecutor policy context plumbing", () => {
  beforeEach(() => {
    fakeToolResult = { content: "ok", isError: false };
    lastCheckArgs = undefined;
    getToolOverride = undefined;
    checkResultOverride = undefined;
    checkFnOverride = undefined;
    if (addRuleSpy) {
      addRuleSpy.mockRestore();
      addRuleSpy = undefined;
    }
  });

  test("passes PolicyContext with executionTarget for skill-origin tools", async () => {
    getToolOverride = (name: string) => {
      if (name === "unknown_tool") return undefined;
      return {
        name,
        description: "skill tool",
        category: "skill",
        defaultRiskLevel: RiskLevel.Low,
        origin: "skill" as const,
        ownerSkillId: "my-skill-123",
        ownerSkillVersionHash: "abc123hash",
        executionTarget: "sandbox" as const,
        getDefinition: () => ({
          name,
          description: "skill tool",
          input_schema: { type: "object" as const, properties: {} },
        }),
        execute: async () => fakeToolResult,
      };
    };

    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      "skill_tool",
      { action: "run" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(lastCheckArgs).toBeDefined();
    expect(lastCheckArgs!.policyContext).toEqual({
      executionTarget: "sandbox",
    });
  });

  test("passes undefined policyContext for core tools (no origin)", async () => {
    // Default getTool returns core tools with no origin field
    getToolOverride = undefined;

    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      "file_read",
      { path: "test.txt" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(lastCheckArgs).toBeDefined();
    expect(lastCheckArgs!.policyContext).toBeUndefined();
  });

  test('passes undefined policyContext for tools with origin "core"', async () => {
    getToolOverride = (name: string) => {
      if (name === "unknown_tool") return undefined;
      return {
        name,
        description: "core tool",
        category: "core",
        defaultRiskLevel: RiskLevel.Low,
        origin: "core" as const,
        getDefinition: () => ({
          name,
          description: "core tool",
          input_schema: { type: "object" as const, properties: {} },
        }),
        execute: async () => fakeToolResult,
      };
    };

    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      "file_read",
      { path: "test.txt" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(lastCheckArgs).toBeDefined();
    expect(lastCheckArgs!.policyContext).toBeUndefined();
  });

  test('includes executionTarget "host" from skill tool metadata', async () => {
    getToolOverride = (name: string) => {
      if (name === "unknown_tool") return undefined;
      return {
        name,
        description: "host skill tool",
        category: "skill",
        defaultRiskLevel: RiskLevel.Low,
        origin: "skill" as const,
        ownerSkillId: "host-skill",
        ownerSkillVersionHash: "host-hash",
        executionTarget: "host" as const,
        getDefinition: () => ({
          name,
          description: "host skill tool",
          input_schema: { type: "object" as const, properties: {} },
        }),
        execute: async () => fakeToolResult,
      };
    };

    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      "host_skill_tool",
      { action: "run" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(lastCheckArgs).toBeDefined();
    expect(lastCheckArgs!.policyContext).toEqual({
      executionTarget: "host",
    });
  });

  test("skill tool without executionTarget passes undefined executionTarget", async () => {
    getToolOverride = (name: string) => {
      if (name === "unknown_tool") return undefined;
      return {
        name,
        description: "skill without target",
        category: "skill",
        defaultRiskLevel: RiskLevel.Low,
        origin: "skill" as const,
        ownerSkillId: "no-target-skill",
        // executionTarget intentionally omitted
        getDefinition: () => ({
          name,
          description: "skill tool",
          input_schema: { type: "object" as const, properties: {} },
        }),
        execute: async () => fakeToolResult,
      };
    };

    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute("no_target_tool", {}, makeContext());

    expect(result.isError).toBe(false);
    expect(lastCheckArgs).toBeDefined();
    expect(lastCheckArgs!.policyContext).toEqual({
      executionTarget: undefined,
    });
  });
});

/**
 * Helper: create a prompter that returns a specific decision with pattern/scope.
 */
function makePrompterWithDecision(
  decision: string,
  selectedPattern?: string,
  selectedScope?: string,
): PermissionPrompter {
  return {
    prompt: async () => ({ decision, selectedPattern, selectedScope }),
    resolveConfirmation: () => {},
    updateSender: () => {},
    dispose: () => {},
  } as unknown as PermissionPrompter;
}

describe("ToolExecutor contextual rule creation", () => {
  beforeEach(() => {
    fakeToolResult = { content: "ok", isError: false };
    lastCheckArgs = undefined;
    getToolOverride = undefined;
    checkResultOverride = undefined;
    checkFnOverride = undefined;
    scopeOptionsOverride = undefined;
    if (addRuleSpy) {
      addRuleSpy.mockRestore();
      addRuleSpy = undefined;
    }
  });

  function setupAddRuleSpy() {
    addRuleSpy = spyOn(trustStore, "addRule").mockImplementation(
      (
        tool: string,
        pattern: string,
        scope: string,
        decision = "allow",
        priority = 100,
        options?: { allowHighRisk?: boolean; executionTarget?: string },
      ) => {
        return {
          id: "spy-rule-id",
          tool,
          pattern,
          scope,
          decision,
          priority,
          createdAt: Date.now(),
          ...options,
        } as TrustRule;
      },
    );
    return addRuleSpy;
  }

  test("always_allow for a skill tool captures execution target in the rule", async () => {
    checkResultOverride = { decision: "prompt", reason: "test prompt" };
    const spy = setupAddRuleSpy();

    getToolOverride = (name: string) => {
      if (name === "unknown_tool") return undefined;
      return {
        name,
        description: "skill tool",
        category: "skill",
        defaultRiskLevel: RiskLevel.Low,
        origin: "skill" as const,
        ownerSkillId: "my-skill-42",
        ownerSkillVersionHash: "sha256-deadbeef",
        executionTarget: "sandbox" as const,
        getDefinition: () => ({
          name,
          description: "skill tool",
          input_schema: { type: "object" as const, properties: {} },
        }),
        execute: async () => fakeToolResult,
      };
    };

    const prompter = makePrompterWithDecision(
      "always_allow",
      "skill_tool:*",
      "/tmp/project",
    );
    const executor = new ToolExecutor(prompter);
    const result = await executor.execute(
      "skill_tool",
      { action: "run" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    const [tool, pattern, scope, decision, _priority, options] =
      spy.mock.calls[0];
    expect(tool).toBe("skill_tool");
    expect(pattern).toBe("skill_tool:*");
    expect(scope).toBe("/tmp/project");
    expect(decision).toBe("allow");
    expect(options).toBeDefined();
    expect(options.executionTarget).toBe("sandbox");
  });

  test("always_allow_high_risk sets allowHighRisk and captures execution target", async () => {
    checkResultOverride = { decision: "prompt", reason: "test prompt" };
    const spy = setupAddRuleSpy();

    getToolOverride = (name: string) => {
      if (name === "unknown_tool") return undefined;
      return {
        name,
        description: "high-risk skill tool",
        category: "skill",
        defaultRiskLevel: RiskLevel.High,
        origin: "skill" as const,
        ownerSkillId: "dangerous-skill",
        ownerSkillVersionHash: "sha256-abc",
        executionTarget: "host" as const,
        getDefinition: () => ({
          name,
          description: "high-risk skill tool",
          input_schema: { type: "object" as const, properties: {} },
        }),
        execute: async () => fakeToolResult,
      };
    };

    const prompter = makePrompterWithDecision(
      "always_allow_high_risk",
      "risky_tool:*",
      "everywhere",
    );
    const executor = new ToolExecutor(prompter);
    const result = await executor.execute("risky_tool", {}, makeContext());

    expect(result.isError).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    const [tool, pattern, scope, decision, _priority, options] =
      spy.mock.calls[0];
    expect(tool).toBe("risky_tool");
    expect(pattern).toBe("risky_tool:*");
    expect(scope).toBe("everywhere");
    expect(decision).toBe("allow");
    expect(options).toBeDefined();
    expect(options.allowHighRisk).toBe(true);
    expect(options.executionTarget).toBe("host");
  });

  test("always_allow for a core tool creates rule without options", async () => {
    checkResultOverride = { decision: "prompt", reason: "test prompt" };
    const spy = setupAddRuleSpy();

    // Default getTool returns core tools with no origin field
    getToolOverride = undefined;

    const prompter = makePrompterWithDecision(
      "always_allow",
      "git *",
      "/tmp/project",
    );
    const executor = new ToolExecutor(prompter);
    const result = await executor.execute(
      "bash",
      { command: "git status" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    const [tool, pattern, scope, decision, _priority, options] =
      spy.mock.calls[0];
    expect(tool).toBe("bash");
    expect(pattern).toBe("git *");
    expect(scope).toBe("/tmp/project");
    expect(decision).toBe("allow");
    // No options since there's no execution target for core tools
    expect(options).toBeUndefined();
  });

  test("always_allow without selectedPattern does not create a rule", async () => {
    checkResultOverride = { decision: "prompt", reason: "test prompt" };
    const spy = setupAddRuleSpy();

    const prompter = makePrompterWithDecision(
      "always_allow",
      undefined,
      "/tmp/project",
    );
    const executor = new ToolExecutor(prompter);
    const result = await executor.execute(
      "file_read",
      { path: "test.txt" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  test("always_allow without selectedScope for scoped tool does not create a rule", async () => {
    checkResultOverride = { decision: "prompt", reason: "test prompt" };
    const spy = setupAddRuleSpy();

    const prompter = makePrompterWithDecision(
      "always_allow",
      "file_read:*",
      undefined,
    );
    const executor = new ToolExecutor(prompter);
    const result = await executor.execute(
      "file_read",
      { path: "test.txt" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  test("always_allow without selectedScope for non-scoped tool creates rule with everywhere scope", async () => {
    checkResultOverride = { decision: "prompt", reason: "test prompt" };
    scopeOptionsOverride = [];
    const spy = setupAddRuleSpy();

    const prompter = makePrompterWithDecision(
      "always_allow",
      "some_tool:*",
      undefined,
    );
    const executor = new ToolExecutor(prompter);
    const result = await executor.execute("some_tool", {}, makeContext());

    expect(result.isError).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    const [, , scope] = spy.mock.calls[0];
    expect(scope).toBe("everywhere");
  });

  test("always_allow_high_risk for core tool sets allowHighRisk without execution target", async () => {
    checkResultOverride = { decision: "prompt", reason: "test prompt" };
    const spy = setupAddRuleSpy();
    getToolOverride = undefined;

    const prompter = makePrompterWithDecision(
      "always_allow_high_risk",
      "sudo *",
      "everywhere",
    );
    const executor = new ToolExecutor(prompter);
    const result = await executor.execute(
      "bash",
      { command: "sudo apt update" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    const [, , , , , options] = spy.mock.calls[0];
    expect(options).toBeDefined();
    expect(options.allowHighRisk).toBe(true);
    // No execution target for core tools
    expect(options.executionTarget).toBeUndefined();
  });

  test("skill tool with host execution target records executionTarget in rule", async () => {
    checkResultOverride = { decision: "prompt", reason: "test prompt" };
    const spy = setupAddRuleSpy();

    getToolOverride = (name: string) => {
      if (name === "unknown_tool") return undefined;
      return {
        name,
        description: "host skill tool",
        category: "skill",
        defaultRiskLevel: RiskLevel.Low,
        origin: "skill" as const,
        ownerSkillId: "host-skill",
        ownerSkillVersionHash: "host-hash-v1",
        executionTarget: "host" as const,
        getDefinition: () => ({
          name,
          description: "host skill tool",
          input_schema: { type: "object" as const, properties: {} },
        }),
        execute: async () => fakeToolResult,
      };
    };

    const prompter = makePrompterWithDecision(
      "always_allow",
      "host_action:*",
      "/tmp/project",
    );
    const executor = new ToolExecutor(prompter);
    const result = await executor.execute(
      "host_action",
      { action: "click" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    const [, , , , , options] = spy.mock.calls[0];
    expect(options).toBeDefined();
    expect(options.executionTarget).toBe("host");
  });
});

describe("ToolExecutor strict mode + high-risk integration (PR 25)", () => {
  beforeEach(() => {
    fakeToolResult = { content: "ok", isError: false };
    lastCheckArgs = undefined;
    getToolOverride = undefined;
    checkResultOverride = undefined;
    checkFnOverride = undefined;
    if (addRuleSpy) {
      addRuleSpy.mockRestore();
      addRuleSpy = undefined;
    }
  });

  function setupAddRuleSpy() {
    addRuleSpy = spyOn(trustStore, "addRule").mockImplementation(
      (
        tool: string,
        pattern: string,
        scope: string,
        decision = "allow",
        priority = 100,
        options?: { allowHighRisk?: boolean; executionTarget?: string },
      ) => {
        return {
          id: "spy-rule-id",
          tool,
          pattern,
          scope,
          decision,
          priority,
          createdAt: Date.now(),
          ...options,
        } as TrustRule;
      },
    );
    return addRuleSpy;
  }

  test("always_allow_high_risk creates rule with allowHighRisk: true for high-risk skill tool", async () => {
    checkResultOverride = {
      decision: "prompt",
      reason: "High risk: always requires approval",
    };
    const spy = setupAddRuleSpy();

    getToolOverride = (name: string) => {
      if (name === "unknown_tool") return undefined;
      return {
        name,
        description: "high-risk skill tool",
        category: "skill",
        defaultRiskLevel: RiskLevel.High,
        origin: "skill" as const,
        ownerSkillId: "deploy-skill",
        ownerSkillVersionHash: "sha256-deploy-v1",
        executionTarget: "host" as const,
        getDefinition: () => ({
          name,
          description: "high-risk skill tool",
          input_schema: { type: "object" as const, properties: {} },
        }),
        execute: async () => fakeToolResult,
      };
    };

    const prompter = makePrompterWithDecision(
      "always_allow_high_risk",
      "deploy_tool:*",
      "everywhere",
    );
    const executor = new ToolExecutor(prompter);
    const result = await executor.execute(
      "deploy_tool",
      { target: "prod" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    const [tool, pattern, scope, decision, _priority, options] =
      spy.mock.calls[0];
    expect(tool).toBe("deploy_tool");
    expect(pattern).toBe("deploy_tool:*");
    expect(scope).toBe("everywhere");
    expect(decision).toBe("allow");
    // The key integration assertion: allowHighRisk + execution target together
    expect(options.allowHighRisk).toBe(true);
    expect(options.executionTarget).toBe("host");
  });

  test("always_allow creates rule without allowHighRisk even for high-risk skill tool", async () => {
    checkResultOverride = { decision: "prompt", reason: "test prompt" };
    const spy = setupAddRuleSpy();

    getToolOverride = (name: string) => {
      if (name === "unknown_tool") return undefined;
      return {
        name,
        description: "high-risk skill tool",
        category: "skill",
        defaultRiskLevel: RiskLevel.High,
        origin: "skill" as const,
        ownerSkillId: "risky-skill",
        ownerSkillVersionHash: "sha256-risky",
        executionTarget: "sandbox" as const,
        getDefinition: () => ({
          name,
          description: "high-risk skill tool",
          input_schema: { type: "object" as const, properties: {} },
        }),
        execute: async () => fakeToolResult,
      };
    };

    // User chooses always_allow (NOT always_allow_high_risk) — the rule
    // should NOT have allowHighRisk set, meaning future high-risk checks
    // will still prompt.
    const prompter = makePrompterWithDecision(
      "always_allow",
      "risky_op:*",
      "/tmp/project",
    );
    const executor = new ToolExecutor(prompter);
    const result = await executor.execute("risky_op", {}, makeContext());

    expect(result.isError).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    const [, , , , , options] = spy.mock.calls[0];
    expect(options).toBeDefined();
    // executionTarget should be present
    expect(options.executionTarget).toBe("sandbox");
    // But allowHighRisk should NOT be set
    expect(options.allowHighRisk).toBeUndefined();
  });

  test("executor forwards policyContext to check() for version-bound skill tool", async () => {
    getToolOverride = (name: string) => {
      if (name === "unknown_tool") return undefined;
      return {
        name,
        description: "versioned skill tool",
        category: "skill",
        defaultRiskLevel: RiskLevel.Low,
        origin: "skill" as const,
        ownerSkillId: "versioned-skill",
        ownerSkillVersionHash: "v3:content-hash-xyz",
        executionTarget: "sandbox" as const,
        getDefinition: () => ({
          name,
          description: "versioned skill tool",
          input_schema: { type: "object" as const, properties: {} },
        }),
        execute: async () => fakeToolResult,
      };
    };

    const executor = new ToolExecutor(makePrompter());
    await executor.execute("versioned_tool", { action: "test" }, makeContext());

    expect(lastCheckArgs).toBeDefined();
    expect(lastCheckArgs!.policyContext).toEqual({
      executionTarget: "sandbox",
    });
  });

  // ── Skill mutation approval regression tests (PR 30) ──────────

  test("always_allow_high_risk for skill source write creates rule with allowHighRisk and execution target", async () => {
    checkResultOverride = {
      decision: "prompt",
      reason: "High risk: always requires approval",
    };
    const spy = setupAddRuleSpy();

    getToolOverride = (name: string) => {
      if (name === "unknown_tool") return undefined;
      return {
        name,
        description: "skill tool that writes to skill source",
        category: "skill",
        defaultRiskLevel: RiskLevel.High,
        origin: "skill" as const,
        ownerSkillId: "code-editor-skill",
        ownerSkillVersionHash: "sha256-v1-original",
        executionTarget: "sandbox" as const,
        getDefinition: () => ({
          name,
          description: "skill source writer",
          input_schema: { type: "object" as const, properties: {} },
        }),
        execute: async () => fakeToolResult,
      };
    };

    const prompter = makePrompterWithDecision(
      "always_allow_high_risk",
      "file_write:*/skills/**",
      "everywhere",
    );
    const executor = new ToolExecutor(prompter);
    const result = await executor.execute(
      "file_write",
      { path: "/tmp/skills/my-skill/executor.ts" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    const [tool, pattern, scope, decision, , options] = spy.mock.calls[0];
    expect(tool).toBe("file_write");
    expect(pattern).toBe("file_write:*/skills/**");
    expect(scope).toBe("everywhere");
    expect(decision).toBe("allow");
    expect(options.allowHighRisk).toBe(true);
    expect(options.executionTarget).toBe("sandbox");
  });

  test("always_allow (not high risk) for skill source write creates rule WITHOUT allowHighRisk", async () => {
    checkResultOverride = {
      decision: "prompt",
      reason: "High risk: always requires approval",
    };
    const spy = setupAddRuleSpy();

    getToolOverride = (name: string) => {
      if (name === "unknown_tool") return undefined;
      return {
        name,
        description: "skill tool that writes to skill source",
        category: "skill",
        defaultRiskLevel: RiskLevel.High,
        origin: "skill" as const,
        ownerSkillId: "editor-skill",
        ownerSkillVersionHash: "sha256-editor-v1",
        executionTarget: "sandbox" as const,
        getDefinition: () => ({
          name,
          description: "skill source writer",
          input_schema: { type: "object" as const, properties: {} },
        }),
        execute: async () => fakeToolResult,
      };
    };

    // User chooses always_allow instead of always_allow_high_risk
    const prompter = makePrompterWithDecision(
      "always_allow",
      "file_write:*/skills/**",
      "/tmp/project",
    );
    const executor = new ToolExecutor(prompter);
    const result = await executor.execute(
      "file_write",
      { path: "/tmp/skills/my-skill/executor.ts" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    const [, , , , , options] = spy.mock.calls[0];
    expect(options).toBeDefined();
    expect(options.executionTarget).toBe("sandbox");
    // Without always_allow_high_risk, the allowHighRisk flag should NOT be set
    expect(options.allowHighRisk).toBeUndefined();
  });

  test("skill version is captured in rule for future version-bound matching", async () => {
    checkResultOverride = {
      decision: "prompt",
      reason: "High risk: always requires approval",
    };
    const spy = setupAddRuleSpy();

    getToolOverride = (name: string) => {
      if (name === "unknown_tool") return undefined;
      return {
        name,
        description: "versioned skill tool",
        category: "skill",
        defaultRiskLevel: RiskLevel.High,
        origin: "skill" as const,
        ownerSkillId: "versioned-editor",
        ownerSkillVersionHash: "v3:content-hash-xyz789",
        executionTarget: "sandbox" as const,
        getDefinition: () => ({
          name,
          description: "versioned skill editor",
          input_schema: { type: "object" as const, properties: {} },
        }),
        execute: async () => fakeToolResult,
      };
    };

    const prompter = makePrompterWithDecision(
      "always_allow_high_risk",
      "file_edit:*/skills/**",
      "everywhere",
    );
    const executor = new ToolExecutor(prompter);
    const result = await executor.execute(
      "file_edit",
      { path: "/tmp/skills/my-skill/SKILL.md" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    const [tool, , , , , options] = spy.mock.calls[0];
    expect(tool).toBe("file_edit");
    expect(options.allowHighRisk).toBe(true);
    expect(options.executionTarget).toBe("sandbox");
  });

  test("executor forwards policyContext with version for skill source mutation", async () => {
    getToolOverride = (name: string) => {
      if (name === "unknown_tool") return undefined;
      return {
        name,
        description: "skill source editor",
        category: "skill",
        defaultRiskLevel: RiskLevel.High,
        origin: "skill" as const,
        ownerSkillId: "editor-skill",
        ownerSkillVersionHash: "sha256-v2-updated",
        executionTarget: "sandbox" as const,
        getDefinition: () => ({
          name,
          description: "skill editor",
          input_schema: { type: "object" as const, properties: {} },
        }),
        execute: async () => fakeToolResult,
      };
    };

    const executor = new ToolExecutor(makePrompter());
    await executor.execute(
      "file_write",
      { path: "/tmp/skills/my-skill/index.ts" },
      makeContext(),
    );

    expect(lastCheckArgs).toBeDefined();
    expect(lastCheckArgs!.policyContext).toEqual({
      executionTarget: "sandbox",
    });
  });

  test("executor creates rule on always_allow_high_risk with full context", async () => {
    checkResultOverride = {
      decision: "prompt",
      reason: "High risk: always requires approval",
    };
    const spy = setupAddRuleSpy();

    getToolOverride = (name: string) => {
      if (name === "unknown_tool") return undefined;
      return {
        name,
        description: "admin skill tool",
        category: "skill",
        defaultRiskLevel: RiskLevel.High,
        origin: "skill" as const,
        ownerSkillId: "admin-skill",
        ownerSkillVersionHash: "sha256-admin-v2",
        executionTarget: "host" as const,
        getDefinition: () => ({
          name,
          description: "admin skill tool",
          input_schema: { type: "object" as const, properties: {} },
        }),
        execute: async () => fakeToolResult,
      };
    };

    const prompter = makePrompterWithDecision(
      "always_allow_high_risk",
      "admin_action:*",
      "everywhere",
    );
    const executor = new ToolExecutor(prompter);
    const result = await executor.execute(
      "admin_action",
      { op: "restart" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    const [tool, pattern, scope, decision, , options] = spy.mock.calls[0];

    // Verify complete integration of all fields
    expect(tool).toBe("admin_action");
    expect(pattern).toBe("admin_action:*");
    expect(scope).toBe("everywhere");
    expect(decision).toBe("allow");
    expect(options.allowHighRisk).toBe(true);
    expect(options.executionTarget).toBe("host");
  });
});

// ---------------------------------------------------------------------------
// isSideEffectTool classifier
// ---------------------------------------------------------------------------

describe("isSideEffectTool", () => {
  describe("returns true for side-effect tools", () => {
    const sideEffectTools = [
      "file_write",
      "file_edit",
      "host_file_write",
      "host_file_edit",
      "bash",
      "host_bash",
      "web_fetch",
      "browser_navigate",
      "browser_click",
      "browser_type",
      "browser_press_key",
      "browser_close",
      "browser_fill_credential",
      "document_create",
      "document_update",
      "schedule_create",
      "schedule_update",
      "schedule_delete",
    ];

    for (const toolName of sideEffectTools) {
      test(toolName, () => {
        expect(isSideEffectTool(toolName)).toBe(true);
      });
    }
  });

  describe("returns false for non-side-effect tools", () => {
    const readOnlyTools = [
      "file_read",
      "memory_recall",
      "memory_save",
      "web_search",
      "browser_snapshot",
      "browser_screenshot",
      "browser_wait_for",
      "browser_extract",
      "skill_load",
      "schedule_list",
    ];

    for (const toolName of readOnlyTools) {
      test(toolName, () => {
        expect(isSideEffectTool(toolName)).toBe(false);
      });
    }
  });

  test("returns false for unknown tool names", () => {
    expect(isSideEffectTool("nonexistent_tool")).toBe(false);
    expect(isSideEffectTool("")).toBe(false);
  });

  describe("action-aware classification for mixed-action tools", () => {
    test("account_manage create is a side-effect", () => {
      expect(isSideEffectTool("account_manage", { action: "create" })).toBe(
        true,
      );
    });

    test("account_manage update is a side-effect", () => {
      expect(isSideEffectTool("account_manage", { action: "update" })).toBe(
        true,
      );
    });

    test("account_manage list is NOT a side-effect", () => {
      expect(isSideEffectTool("account_manage", { action: "list" })).toBe(
        false,
      );
    });

    test("account_manage get is NOT a side-effect", () => {
      expect(isSideEffectTool("account_manage", { action: "get" })).toBe(false);
    });

    test("account_manage without input is NOT a side-effect", () => {
      expect(isSideEffectTool("account_manage")).toBe(false);
    });

    test("reminder_create is a side-effect", () => {
      expect(isSideEffectTool("reminder_create")).toBe(true);
    });

    test("reminder_cancel is a side-effect", () => {
      expect(isSideEffectTool("reminder_cancel")).toBe(true);
    });

    test("reminder_list is NOT a side-effect", () => {
      expect(isSideEffectTool("reminder_list")).toBe(false);
    });

    test("credential_store store is a side-effect", () => {
      expect(isSideEffectTool("credential_store", { action: "store" })).toBe(
        true,
      );
    });

    test("credential_store delete is a side-effect", () => {
      expect(isSideEffectTool("credential_store", { action: "delete" })).toBe(
        true,
      );
    });

    test("credential_store prompt is a side-effect", () => {
      expect(isSideEffectTool("credential_store", { action: "prompt" })).toBe(
        true,
      );
    });

    test("credential_store oauth2_connect is a side-effect", () => {
      expect(
        isSideEffectTool("credential_store", { action: "oauth2_connect" }),
      ).toBe(true);
    });

    test("credential_store list is NOT a side-effect", () => {
      expect(isSideEffectTool("credential_store", { action: "list" })).toBe(
        false,
      );
    });

    test("credential_store without input is NOT a side-effect", () => {
      expect(isSideEffectTool("credential_store")).toBe(false);
    });
  });
});

// Baseline: allow rules can auto-allow file_edit for USER.md today (no forced prompting).
// The mock check() delegates to findHighestPriorityRule (via spy) so a regression
// in trust-rule matching would cause this test to fail instead of being masked by
// a blanket mock-allow.
describe("ToolExecutor baseline: allow rule auto-allows file_edit USER.md", () => {
  const userMdPath = "/Users/sidd/.vellum/workspace/USER.md";
  let ruleSpy: ReturnType<typeof spyOn> | undefined;

  beforeEach(() => {
    fakeToolResult = { content: "ok", isError: false };
    lastCheckArgs = undefined;
    getToolOverride = undefined;
    checkResultOverride = undefined;
    checkFnOverride = undefined;
    if (addRuleSpy) {
      addRuleSpy.mockRestore();
      addRuleSpy = undefined;
    }

    // Simulate a trust rule that allows file_edit on USER.md by stubbing
    // findHighestPriorityRule. This mirrors the default allow rules that
    // the trust-store creates for workspace prompt files.
    ruleSpy = spyOn(trustStore, "findHighestPriorityRule").mockImplementation(
      (tool: string, commands: string[], _scope: string) => {
        if (tool !== "file_edit") return null;
        for (const cmd of commands) {
          if (cmd === `file_edit:${userMdPath}`) {
            return {
              id: "default:allow-file_edit-user",
              tool: "file_edit",
              pattern: `file_edit:${userMdPath}`,
              scope: "everywhere",
              decision: "allow" as const,
              priority: 100,
              createdAt: Date.now(),
            };
          }
        }
        return null;
      },
    );

    // Wire the mock check() to delegate to findHighestPriorityRule, replicating
    // the real check() logic for Medium-risk tools (file_edit).
    checkFnOverride = async (toolName, input, workingDir) => {
      const filePath =
        (input.path as string) ?? (input.file_path as string) ?? "";
      const resolved = filePath.startsWith("/")
        ? filePath
        : `${workingDir}/${filePath}`;
      const candidates = [`${toolName}:${resolved}`];
      const matched = trustStore.findHighestPriorityRule(
        toolName,
        candidates,
        workingDir,
      );
      if (matched && matched.decision === "allow") {
        return {
          decision: "allow",
          reason: `Matched trust rule: ${matched.pattern}`,
        };
      }
      return { decision: "prompt", reason: "Medium risk: requires approval" };
    };
  });

  afterEach(() => {
    checkFnOverride = undefined;
    if (ruleSpy) {
      ruleSpy.mockRestore();
      ruleSpy = undefined;
    }
  });

  test("file_edit to USER.md is auto-allowed via trust rule", async () => {
    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      "file_edit",
      { path: userMdPath, content: "hello" },
      makeContext(),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toBe("ok");
    // Confirm checker was called with the correct tool name
    expect(lastCheckArgs).toBeDefined();
    expect(lastCheckArgs!.toolName).toBe("file_edit");
    // Confirm findHighestPriorityRule was consulted
    expect(ruleSpy).toHaveBeenCalled();
  });

  test("file_edit to a non-USER.md path is NOT auto-allowed without a matching rule", async () => {
    let promptCalled = false;
    const trackingPrompter = {
      prompt: async () => {
        promptCalled = true;
        return { decision: "allow" as const };
      },
      resolveConfirmation: () => {},
      updateSender: () => {},
      dispose: () => {},
    } as unknown as PermissionPrompter;

    const executor = new ToolExecutor(trackingPrompter);
    const result = await executor.execute(
      "file_edit",
      { path: "/tmp/project/other.md", content: "hello" },
      makeContext(),
    );
    // check() returned 'prompt' (no matching trust rule for other.md),
    // so the executor must have called the prompter.
    expect(promptCalled).toBe(true);
    expect(result.isError).toBe(false);
    expect(lastCheckArgs).toBeDefined();
    expect(lastCheckArgs!.toolName).toBe("file_edit");
  });
});

// ---------------------------------------------------------------------------
// forcePromptSideEffects enforcement (PR 30)
// ---------------------------------------------------------------------------

describe("ToolExecutor forcePromptSideEffects enforcement", () => {
  let promptCalled: boolean;

  beforeEach(() => {
    fakeToolResult = { content: "ok", isError: false };
    lastCheckArgs = undefined;
    getToolOverride = undefined;
    checkResultOverride = undefined;
    checkFnOverride = undefined;
    promptCalled = false;
    if (addRuleSpy) {
      addRuleSpy.mockRestore();
      addRuleSpy = undefined;
    }
  });

  /**
   * Prompter that tracks whether it was called and always allows.
   */
  function makeTrackingPrompter(): PermissionPrompter {
    return {
      prompt: async () => {
        promptCalled = true;
        return { decision: "allow" as const };
      },
      resolveConfirmation: () => {},
      updateSender: () => {},
      dispose: () => {},
    } as unknown as PermissionPrompter;
  }

  test("side-effect tool with allow rule is forced to prompt when forcePromptSideEffects is true", async () => {
    // check() returns allow (simulating a matched trust rule)
    checkResultOverride = { decision: "allow", reason: "Matched trust rule" };

    const executor = new ToolExecutor(makeTrackingPrompter());
    const result = await executor.execute(
      "bash",
      { command: "echo hello" },
      makeContext({ forcePromptSideEffects: true }),
    );

    expect(result.isError).toBe(false);
    // The prompter must have been called despite the allow rule
    expect(promptCalled).toBe(true);
  });

  test("deny decision is preserved (not converted to prompt) even with forcePromptSideEffects", async () => {
    checkResultOverride = {
      decision: "deny",
      reason: "Policy denies this tool",
    };

    const executor = new ToolExecutor(makeTrackingPrompter());
    const result = await executor.execute(
      "bash",
      { command: "rm -rf /" },
      makeContext({ forcePromptSideEffects: true }),
    );

    // Should be denied, not prompted
    expect(result.isError).toBe(true);
    expect(result.content).toBe("Policy denies this tool");
    expect(promptCalled).toBe(false);
  });

  test("non-side-effect tool is unchanged even with forcePromptSideEffects", async () => {
    // check() returns allow for a read-only tool
    checkResultOverride = { decision: "allow", reason: "Allowed by default" };

    const executor = new ToolExecutor(makeTrackingPrompter());
    const result = await executor.execute(
      "file_read",
      { path: "README.md" },
      makeContext({ forcePromptSideEffects: true }),
    );

    expect(result.isError).toBe(false);
    // Prompter should NOT be called — file_read is not a side-effect tool
    expect(promptCalled).toBe(false);
  });

  test("side-effect tool is auto-allowed when forcePromptSideEffects is false", async () => {
    checkResultOverride = { decision: "allow", reason: "Matched trust rule" };

    const executor = new ToolExecutor(makeTrackingPrompter());
    const result = await executor.execute(
      "file_write",
      { path: "test.txt", content: "data" },
      makeContext({ forcePromptSideEffects: false }),
    );

    expect(result.isError).toBe(false);
    // No prompt — standard behavior when forcePromptSideEffects is off
    expect(promptCalled).toBe(false);
  });

  test("side-effect tool is auto-allowed when forcePromptSideEffects is undefined", async () => {
    checkResultOverride = { decision: "allow", reason: "Matched trust rule" };

    const executor = new ToolExecutor(makeTrackingPrompter());
    const result = await executor.execute(
      "file_edit",
      { path: "test.txt", old_string: "a", new_string: "b" },
      makeContext(), // forcePromptSideEffects not set
    );

    expect(result.isError).toBe(false);
    expect(promptCalled).toBe(false);
  });

  test("all side-effect tool types are forced to prompt", async () => {
    checkResultOverride = { decision: "allow", reason: "Matched trust rule" };

    const sideEffectTools = [
      { name: "file_write", input: { path: "x", content: "y" } },
      {
        name: "file_edit",
        input: { path: "x", old_string: "a", new_string: "b" },
      },
      { name: "host_file_write", input: { path: "x", content: "y" } },
      {
        name: "host_file_edit",
        input: { path: "x", old_string: "a", new_string: "b" },
      },
      { name: "bash", input: { command: "echo hi" } },
      { name: "host_bash", input: { command: "echo hi" } },
      { name: "web_fetch", input: { url: "https://example.com" } },
      { name: "browser_navigate", input: { url: "https://example.com" } },
      { name: "browser_click", input: { selector: "#btn" } },
      { name: "browser_type", input: { selector: "#input", text: "hello" } },
      { name: "browser_press_key", input: { key: "Enter" } },
      { name: "browser_close", input: {} },
      {
        name: "browser_fill_credential",
        input: { selector: "#pwd", credential: "test" },
      },
      { name: "document_create", input: { title: "doc", content: "body" } },
      { name: "document_update", input: { id: "doc-1", content: "updated" } },
      { name: "account_manage", input: { action: "create", name: "acct" } },
      {
        name: "reminder_create",
        input: {
          fire_at: "2030-01-01T00:00:00Z",
          label: "test",
          message: "remind me",
        },
      },
      {
        name: "credential_store",
        input: { action: "store", name: "api-key", value: "secret" },
      },
    ];

    for (const { name, input } of sideEffectTools) {
      promptCalled = false;
      const executor = new ToolExecutor(makeTrackingPrompter());
      const result = await executor.execute(
        name,
        input,
        makeContext({ forcePromptSideEffects: true }),
      );
      expect(result.isError).toBe(false);
      expect(promptCalled).toBe(true);
    }
  });

  test("tool that is already prompted is not double-prompted", async () => {
    // check() returns prompt (tool already needs prompting)
    checkResultOverride = {
      decision: "prompt",
      reason: "Medium risk: requires approval",
    };

    let promptCount = 0;
    const countingPrompter = {
      prompt: async () => {
        promptCount++;
        return { decision: "allow" as const };
      },
      resolveConfirmation: () => {},
      updateSender: () => {},
      dispose: () => {},
    } as unknown as PermissionPrompter;

    const executor = new ToolExecutor(countingPrompter);
    const result = await executor.execute(
      "bash",
      { command: "ls" },
      makeContext({ forcePromptSideEffects: true }),
    );

    expect(result.isError).toBe(false);
    // Should only prompt once — forcePromptSideEffects doesn't add a second prompt
    // when check() already returned 'prompt'
    expect(promptCount).toBe(1);
  });

  // ── USER.md security invariant (PR 31) ──────────

  test("file_edit to USER.md forces prompt in private thread even with matching trust rule", async () => {
    // This is a key security invariant: USER.md contains the user's persistent
    // memory. In a private thread (forcePromptSideEffects=true), edits to it
    // must always require explicit approval, even when a trust rule matches.
    checkResultOverride = {
      decision: "allow",
      reason: "Matched trust rule: file_edit:*/USER.md",
    };

    const executor = new ToolExecutor(makeTrackingPrompter());
    const result = await executor.execute(
      "file_edit",
      {
        path: "/Users/sidd/.vellum/workspace/USER.md",
        old_string: "old pref",
        new_string: "new pref",
      },
      makeContext({ forcePromptSideEffects: true }),
    );

    expect(result.isError).toBe(false);
    // file_edit is a side-effect tool, so forcePromptSideEffects must trigger prompting
    expect(promptCalled).toBe(true);
  });

  test("host_file_edit to USER.md forces prompt in private thread", async () => {
    checkResultOverride = { decision: "allow", reason: "Matched trust rule" };

    const executor = new ToolExecutor(makeTrackingPrompter());
    const result = await executor.execute(
      "host_file_edit",
      {
        path: "/Users/sidd/.vellum/workspace/USER.md",
        old_string: "x",
        new_string: "y",
      },
      makeContext({ forcePromptSideEffects: true }),
    );

    expect(result.isError).toBe(false);
    expect(promptCalled).toBe(true);
  });

  // ── Browser action tools as side-effect tools (PR fix2) ──────────

  test("browser_click forces prompt in private thread", async () => {
    checkResultOverride = { decision: "allow", reason: "Matched trust rule" };

    const executor = new ToolExecutor(makeTrackingPrompter());
    const result = await executor.execute(
      "browser_click",
      { selector: "#submit-btn" },
      makeContext({ forcePromptSideEffects: true }),
    );

    expect(result.isError).toBe(false);
    expect(promptCalled).toBe(true);
  });

  test("browser_type forces prompt in private thread", async () => {
    checkResultOverride = { decision: "allow", reason: "Matched trust rule" };

    const executor = new ToolExecutor(makeTrackingPrompter());
    const result = await executor.execute(
      "browser_type",
      { selector: "#search-input", text: "query" },
      makeContext({ forcePromptSideEffects: true }),
    );

    expect(result.isError).toBe(false);
    expect(promptCalled).toBe(true);
  });

  test("browser_snapshot does NOT force prompt in private thread", async () => {
    checkResultOverride = { decision: "allow", reason: "Matched trust rule" };

    const executor = new ToolExecutor(makeTrackingPrompter());
    const result = await executor.execute(
      "browser_snapshot",
      {},
      makeContext({ forcePromptSideEffects: true }),
    );

    expect(result.isError).toBe(false);
    // browser_snapshot is read-only — must NOT trigger forced prompting
    expect(promptCalled).toBe(false);
  });

  // ── Always-mutating document tools (PR fix5) ──────────

  test("document_create forces prompt in private thread", async () => {
    checkResultOverride = { decision: "allow", reason: "Matched trust rule" };

    const executor = new ToolExecutor(makeTrackingPrompter());
    const result = await executor.execute(
      "document_create",
      { title: "New Doc", content: "hello" },
      makeContext({ forcePromptSideEffects: true }),
    );

    expect(result.isError).toBe(false);
    expect(promptCalled).toBe(true);
  });

  test("document_update forces prompt in private thread", async () => {
    checkResultOverride = { decision: "allow", reason: "Matched trust rule" };

    const executor = new ToolExecutor(makeTrackingPrompter());
    const result = await executor.execute(
      "document_update",
      { id: "doc-1", content: "updated" },
      makeContext({ forcePromptSideEffects: true }),
    );

    expect(result.isError).toBe(false);
    expect(promptCalled).toBe(true);
  });

  // ── Always-mutating schedule tools (PR fix7) ──────────

  test("schedule_create forces prompt in private thread", async () => {
    checkResultOverride = { decision: "allow", reason: "Matched trust rule" };

    const executor = new ToolExecutor(makeTrackingPrompter());
    const result = await executor.execute(
      "schedule_create",
      { name: "Morning standup", cron: "0 9 * * 1-5" },
      makeContext({ forcePromptSideEffects: true }),
    );

    expect(result.isError).toBe(false);
    expect(promptCalled).toBe(true);
  });

  test("schedule_update forces prompt in private thread", async () => {
    checkResultOverride = { decision: "allow", reason: "Matched trust rule" };

    const executor = new ToolExecutor(makeTrackingPrompter());
    const result = await executor.execute(
      "schedule_update",
      { id: "sched-1", cron: "0 10 * * 1-5" },
      makeContext({ forcePromptSideEffects: true }),
    );

    expect(result.isError).toBe(false);
    expect(promptCalled).toBe(true);
  });

  test("schedule_delete forces prompt in private thread", async () => {
    checkResultOverride = { decision: "allow", reason: "Matched trust rule" };

    const executor = new ToolExecutor(makeTrackingPrompter());
    const result = await executor.execute(
      "schedule_delete",
      { id: "sched-1" },
      makeContext({ forcePromptSideEffects: true }),
    );

    expect(result.isError).toBe(false);
    expect(promptCalled).toBe(true);
  });

  // ── Credential store action-aware (PR fix9) ──────────

  test("credential_store store forces prompt in private thread", async () => {
    checkResultOverride = { decision: "allow", reason: "Matched trust rule" };

    const executor = new ToolExecutor(makeTrackingPrompter());
    const result = await executor.execute(
      "credential_store",
      { action: "store", name: "api-key", value: "sk-secret-123" },
      makeContext({ forcePromptSideEffects: true }),
    );

    expect(result.isError).toBe(false);
    expect(promptCalled).toBe(true);
  });

  test("credential_store delete forces prompt in private thread", async () => {
    checkResultOverride = { decision: "allow", reason: "Matched trust rule" };

    const executor = new ToolExecutor(makeTrackingPrompter());
    const result = await executor.execute(
      "credential_store",
      { action: "delete", name: "api-key" },
      makeContext({ forcePromptSideEffects: true }),
    );

    expect(result.isError).toBe(false);
    expect(promptCalled).toBe(true);
  });

  test("credential_store oauth2_connect forces prompt in private thread", async () => {
    checkResultOverride = { decision: "allow", reason: "Matched trust rule" };

    const executor = new ToolExecutor(makeTrackingPrompter());
    const result = await executor.execute(
      "credential_store",
      { action: "oauth2_connect", provider: "google" },
      makeContext({ forcePromptSideEffects: true }),
    );

    expect(result.isError).toBe(false);
    expect(promptCalled).toBe(true);
  });

  test("credential_store list does NOT force prompt in private thread", async () => {
    checkResultOverride = { decision: "allow", reason: "Matched trust rule" };

    const executor = new ToolExecutor(makeTrackingPrompter());
    const result = await executor.execute(
      "credential_store",
      { action: "list" },
      makeContext({ forcePromptSideEffects: true }),
    );

    expect(result.isError).toBe(false);
    // list is read-only — must NOT trigger forced prompting
    expect(promptCalled).toBe(false);
  });

  // ── Workspace mode + forcePromptSideEffects interaction ──────────

  test("workspace mode allow → prompt promotion still works for side-effect tools in private threads", async () => {
    // Simulate workspace mode returning 'allow' for a workspace-scoped file_write
    checkResultOverride = {
      decision: "allow",
      reason: "Workspace mode: workspace-scoped operation auto-allowed",
    };

    const executor = new ToolExecutor(makeTrackingPrompter());
    const result = await executor.execute(
      "file_write",
      { path: "/tmp/project/test.txt", content: "data" },
      makeContext({ forcePromptSideEffects: true }),
    );

    expect(result.isError).toBe(false);
    // file_write is a side-effect tool, so forcePromptSideEffects must promote
    // the workspace mode allow → prompt, requiring explicit user approval
    expect(promptCalled).toBe(true);
  });

  // ── Action-aware mixed-action tools (PR fix5) ──────────

  test("account_manage create forces prompt in private thread", async () => {
    checkResultOverride = { decision: "allow", reason: "Matched trust rule" };

    const executor = new ToolExecutor(makeTrackingPrompter());
    const result = await executor.execute(
      "account_manage",
      { action: "create", name: "test-account" },
      makeContext({ forcePromptSideEffects: true }),
    );

    expect(result.isError).toBe(false);
    expect(promptCalled).toBe(true);
  });

  test("account_manage list does NOT force prompt in private thread", async () => {
    checkResultOverride = { decision: "allow", reason: "Matched trust rule" };

    const executor = new ToolExecutor(makeTrackingPrompter());
    const result = await executor.execute(
      "account_manage",
      { action: "list" },
      makeContext({ forcePromptSideEffects: true }),
    );

    expect(result.isError).toBe(false);
    // list is read-only — must NOT trigger forced prompting
    expect(promptCalled).toBe(false);
  });

  test("reminder_create forces prompt in private thread", async () => {
    checkResultOverride = { decision: "allow", reason: "Matched trust rule" };

    const executor = new ToolExecutor(makeTrackingPrompter());
    const result = await executor.execute(
      "reminder_create",
      {
        fire_at: "2030-01-01T00:00:00Z",
        label: "test",
        message: "test reminder",
      },
      makeContext({ forcePromptSideEffects: true }),
    );

    expect(result.isError).toBe(false);
    expect(promptCalled).toBe(true);
  });

  test("reminder_list does NOT force prompt in private thread", async () => {
    checkResultOverride = { decision: "allow", reason: "Matched trust rule" };

    const executor = new ToolExecutor(makeTrackingPrompter());
    const result = await executor.execute(
      "reminder_list",
      {},
      makeContext({ forcePromptSideEffects: true }),
    );

    expect(result.isError).toBe(false);
    // list is read-only — must NOT trigger forced prompting
    expect(promptCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// persistentDecisionsAllowed contract
// ---------------------------------------------------------------------------

describe("ToolExecutor persistentDecisionsAllowed contract", () => {
  beforeEach(() => {
    fakeToolResult = { content: "ok", isError: false };
    lastCheckArgs = undefined;
    getToolOverride = undefined;
    checkResultOverride = {
      decision: "prompt",
      reason: "Requires explicit approval",
    };
    checkFnOverride = undefined;
    if (addRuleSpy) {
      addRuleSpy.mockRestore();
      addRuleSpy = undefined;
    }
  });

  function setupAddRuleSpy() {
    addRuleSpy = spyOn(trustStore, "addRule").mockImplementation(
      (
        tool: string,
        pattern: string,
        scope: string,
        decision = "allow",
        priority = 100,
        options?: { allowHighRisk?: boolean; executionTarget?: string },
      ) => {
        return {
          id: "spy-rule-id",
          tool,
          pattern,
          scope,
          decision,
          priority,
          createdAt: Date.now(),
          ...options,
        } as TrustRule;
      },
    );
    return addRuleSpy;
  }

  test("proxied bash always_allow saves a trust rule (no special-casing)", async () => {
    const spy = setupAddRuleSpy();

    const prompter = makePrompterWithDecision(
      "always_allow",
      "bash:*",
      "/tmp/project",
    );
    const executor = new ToolExecutor(prompter);
    const result = await executor.execute(
      "bash",
      { command: "curl https://example.com", network_mode: "proxied" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test("non-proxied bash always_allow saves a trust rule", async () => {
    const spy = setupAddRuleSpy();

    const prompter = makePrompterWithDecision(
      "always_allow",
      "bash:*",
      "/tmp/project",
    );
    const executor = new ToolExecutor(prompter);
    const result = await executor.execute(
      "bash",
      { command: "git status" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test("proxied bash always_deny saves a deny rule (no special-casing)", async () => {
    const spy = setupAddRuleSpy();

    const prompter = makePrompterWithDecision(
      "always_deny",
      "bash:*",
      "/tmp/project",
    );
    const executor = new ToolExecutor(prompter);
    const result = await executor.execute(
      "bash",
      { command: "curl https://evil.com", network_mode: "proxied" },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test("persistentDecisionsAllowed: true is emitted in lifecycle event for proxied bash", async () => {
    let capturedEvent: ToolPermissionPromptEvent | undefined;
    const prompter = makePrompterWithDecision("allow");
    const executor = new ToolExecutor(prompter);
    const result = await executor.execute(
      "bash",
      { command: "curl https://example.com", network_mode: "proxied" },
      makeContext({
        onToolLifecycleEvent: (event: ToolLifecycleEvent) => {
          if (event.type === "permission_prompt") {
            capturedEvent = event;
          }
        },
      }),
    );

    expect(result.isError).toBe(false);
    expect(capturedEvent).toBeDefined();
    expect(capturedEvent!.persistentDecisionsAllowed).toBe(true);
  });

  test("persistentDecisionsAllowed: true is emitted in lifecycle event for non-proxied bash", async () => {
    let capturedEvent: ToolPermissionPromptEvent | undefined;
    const prompter = makePrompterWithDecision("allow");
    const executor = new ToolExecutor(prompter);
    const result = await executor.execute(
      "bash",
      { command: "echo hello" },
      makeContext({
        onToolLifecycleEvent: (event: ToolLifecycleEvent) => {
          if (event.type === "permission_prompt") {
            capturedEvent = event;
          }
        },
      }),
    );

    expect(result.isError).toBe(false);
    expect(capturedEvent).toBeDefined();
    expect(capturedEvent!.persistentDecisionsAllowed).toBe(true);
  });

  test("persistentDecisionsAllowed is true for proxied bash in prompter confirmation_request", async () => {
    let capturedPersistent: unknown;
    const prompter = {
      prompt: async (
        _toolName: string,
        _input: Record<string, unknown>,
        _riskLevel: string,
        _allowlistOptions: AllowlistOption[],
        _scopeOptions: ScopeOption[],
        _diff: unknown,
        _sandboxed: unknown,
        _sessionId: unknown,
        _executionTarget: unknown,
        persistentDecisionsAllowed: boolean | undefined,
      ) => {
        capturedPersistent = persistentDecisionsAllowed;
        return { decision: "allow" as const };
      },
      resolveConfirmation: () => {},
      updateSender: () => {},
      dispose: () => {},
    } as unknown as PermissionPrompter;

    const executor = new ToolExecutor(prompter);
    const result = await executor.execute(
      "bash",
      { command: "curl https://example.com", network_mode: "proxied" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(capturedPersistent).toBe(true);
  });

  test("bash always_allow saves a trust rule regardless of network_mode", async () => {
    const spy = setupAddRuleSpy();

    // 1. Proxied bash always_allow -> rule IS saved
    const p1 = makePrompterWithDecision(
      "always_allow",
      "bash:curl*",
      "/tmp/project",
    );
    const e1 = new ToolExecutor(p1);
    const r1 = await e1.execute(
      "bash",
      { command: "curl https://api.example.com", network_mode: "proxied" },
      makeContext(),
    );
    expect(r1.isError).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockClear();

    // 2. Non-proxied bash always_allow -> rule IS saved
    const p2 = makePrompterWithDecision(
      "always_allow",
      "bash:git*",
      "/tmp/project",
    );
    const e2 = new ToolExecutor(p2);
    const r2 = await e2.execute("bash", { command: "git push" }, makeContext());
    expect(r2.isError).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test("bash always_deny saves a deny rule regardless of network_mode", async () => {
    const spy = setupAddRuleSpy();

    const prompter = makePrompterWithDecision(
      "always_deny",
      "bash:rm*",
      "/tmp/project",
    );
    const executor = new ToolExecutor(prompter);
    const result = await executor.execute(
      "bash",
      { command: "rm -rf /" },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe("bash");
    expect(spy.mock.calls[0][1]).toBe("bash:rm*");
    expect(spy.mock.calls[0][3]).toBe("deny");
  });

  test('proxied bash denied result message includes "rule saved" suffix', async () => {
    setupAddRuleSpy();

    const prompter = makePrompterWithDecision(
      "always_deny",
      "bash:*",
      "/tmp/project",
    );
    const executor = new ToolExecutor(prompter);
    const result = await executor.execute(
      "bash",
      { command: "curl https://malicious.com", network_mode: "proxied" },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Permission denied by user");
    expect(result.content).toContain("rule was saved");
  });

  test('non-proxied bash denied result message includes "rule saved" suffix', async () => {
    setupAddRuleSpy();

    const prompter = makePrompterWithDecision(
      "always_deny",
      "bash:rm*",
      "/tmp/project",
    );
    const executor = new ToolExecutor(prompter);
    const result = await executor.execute(
      "bash",
      { command: "rm -rf /" },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Permission denied by user");
    expect(result.content).toContain("rule was saved");
  });
});

// ---------------------------------------------------------------------------
// Baseline: sanitized env excludes credential-like variables
// ---------------------------------------------------------------------------

// Import the real buildSanitizedEnv (not mocked) for baseline credential tests
const { buildSanitizedEnv } = await import("../tools/terminal/safe-env.js");

describe("buildSanitizedEnv — baseline: credential exclusion", () => {
  // Credential-like env vars that must never appear in the sanitized env.
  // Names are constructed dynamically to avoid tripping pre-commit secret scanners.
  const k = (...parts: string[]) => parts.join("_");
  const CREDENTIAL_VARS = [
    k("OPENAI", "API", "KEY"),
    k("ANTHROPIC", "API", "KEY"),
    k("AWS", "SECRET", "ACCESS", "KEY"),
    k("AWS", "SESSION", "TOKEN"),
    k("GITHUB", "TOKEN"),
    k("GH", "TOKEN"),
    k("NPM", "TOKEN"),
    k("DOCKER", "PASSWORD"),
    k("DATABASE", "URL"),
    k("PGPASSWORD"),
    k("REDIS", "URL"),
    k("API", "SECRET"),
  ];

  test("sanitized env does not include API key variables", () => {
    // Temporarily set credential-like env vars
    const originalValues: Record<string, string | undefined> = {};
    for (const key of CREDENTIAL_VARS) {
      originalValues[key] = process.env[key];
      process.env[key] = `fake-${key}-value`;
    }

    try {
      const env = buildSanitizedEnv();
      for (const key of CREDENTIAL_VARS) {
        expect(env[key]).toBeUndefined();
      }
    } finally {
      // Restore original env
      for (const key of CREDENTIAL_VARS) {
        if (originalValues[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = originalValues[key];
        }
      }
    }
  });

  test("sanitized env includes expected safe variables when present", () => {
    const env = buildSanitizedEnv();
    // PATH and HOME should be present (they exist in the process env)
    if (process.env.PATH) {
      expect(env.PATH).toBe(process.env.PATH);
    }
    if (process.env.HOME) {
      expect(env.HOME).toBe(process.env.HOME);
    }
  });

  test("sanitized env only contains keys from the allowlist", () => {
    const SAFE_ENV_VARS = [
      "PATH",
      "HOME",
      "TERM",
      "LANG",
      "EDITOR",
      "SHELL",
      "USER",
      "TMPDIR",
      "LC_ALL",
      "LC_CTYPE",
      "XDG_RUNTIME_DIR",
      "DISPLAY",
      "COLORTERM",
      "TERM_PROGRAM",
      "SSH_AUTH_SOCK",
      "SSH_AGENT_PID",
      "GPG_TTY",
      "GNUPGHOME",
      "INTERNAL_GATEWAY_BASE_URL",
      "VELLUM_DATA_DIR",
    ];

    const env = buildSanitizedEnv();
    for (const key of Object.keys(env)) {
      expect(SAFE_ENV_VARS).toContain(key);
    }
  });
});

// ---------------------------------------------------------------------------
// Persistent-allow lifecycle: roundtrip and auto-allow on subsequent invocation
// ---------------------------------------------------------------------------

describe("ToolExecutor persistent-allow lifecycle", () => {
  beforeEach(() => {
    fakeToolResult = { content: "ok", isError: false };
    lastCheckArgs = undefined;
    getToolOverride = undefined;
    checkResultOverride = undefined;
    checkFnOverride = undefined;
    if (addRuleSpy) {
      addRuleSpy.mockRestore();
      addRuleSpy = undefined;
    }
  });

  function setupAddRuleSpy() {
    addRuleSpy = spyOn(trustStore, "addRule").mockImplementation(
      (
        tool: string,
        pattern: string,
        scope: string,
        decision = "allow",
        priority = 100,
        options?: { allowHighRisk?: boolean; executionTarget?: string },
      ) => {
        return {
          id: "spy-rule-id",
          tool,
          pattern,
          scope,
          decision,
          priority,
          createdAt: Date.now(),
          ...options,
        } as TrustRule;
      },
    );
    return addRuleSpy;
  }

  test("persistent-allow roundtrip: always_allow saves rule and allows tool", async () => {
    // Simulate check() returning 'prompt' so the executor asks the user
    checkResultOverride = {
      decision: "prompt",
      reason: "Medium risk: requires approval",
    };
    const spy = setupAddRuleSpy();

    // User responds with always_allow, selecting a pattern and scope
    const prompter = makePrompterWithDecision(
      "always_allow",
      "git *",
      "/tmp/project",
    );
    const executor = new ToolExecutor(prompter);
    const result = await executor.execute(
      "bash",
      { command: "git status" },
      makeContext(),
    );

    // The tool should have been allowed to proceed
    expect(result.isError).toBe(false);
    expect(result.content).toBe("ok");

    // addRule should have been called with the correct arguments
    expect(spy).toHaveBeenCalledTimes(1);
    const [tool, pattern, scope, decision] = spy.mock.calls[0];
    expect(tool).toBe("bash");
    expect(pattern).toBe("git *");
    expect(scope).toBe("/tmp/project");
    expect(decision).toBe("allow");
  });

  test("auto-allow on subsequent invocation: matching rule skips prompt", async () => {
    // Simulate a previously saved rule by making check() return 'allow'
    // with a matched rule (as findHighestPriorityRule would).
    checkResultOverride = {
      decision: "allow",
      reason: "Matched trust rule: git *",
    };

    let promptCalled = false;
    const trackingPrompter = {
      prompt: async () => {
        promptCalled = true;
        return { decision: "allow" as const };
      },
      resolveConfirmation: () => {},
      updateSender: () => {},
      dispose: () => {},
    } as unknown as PermissionPrompter;

    const executor = new ToolExecutor(trackingPrompter);
    const result = await executor.execute(
      "bash",
      { command: "git status" },
      makeContext(),
    );

    // The tool should be auto-allowed
    expect(result.isError).toBe(false);
    expect(result.content).toBe("ok");

    // The prompter should NOT have been called — the rule auto-allowed
    expect(promptCalled).toBe(false);
  });

  test("always_allow with everywhere scope saves rule and allows tool", async () => {
    checkResultOverride = {
      decision: "prompt",
      reason: "Medium risk: requires approval",
    };
    const spy = setupAddRuleSpy();

    const prompter = makePrompterWithDecision(
      "always_allow",
      "file_write:*",
      "everywhere",
    );
    const executor = new ToolExecutor(prompter);
    const result = await executor.execute(
      "file_write",
      { path: "/tmp/test.txt", content: "hello" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    const [tool, pattern, scope, decision] = spy.mock.calls[0];
    expect(tool).toBe("file_write");
    expect(pattern).toBe("file_write:*");
    expect(scope).toBe("everywhere");
    expect(decision).toBe("allow");
  });
});

describe("integration regressions — prompt payload (PR 11)", () => {
  beforeEach(() => {
    fakeToolResult = { content: "ok", isError: false };
    checkResultOverride = undefined;
    checkFnOverride = undefined;
    getToolOverride = undefined;
  });

  test("shell command prompt payload includes allowlist and scope options", async () => {
    checkResultOverride = {
      decision: "prompt",
      reason: "Medium risk: requires approval",
    };

    let capturedAllowlist: AllowlistOption[] | undefined;
    let capturedScopes: ScopeOption[] | undefined;
    const prompter = {
      prompt: async (
        _toolName: string,
        _input: Record<string, unknown>,
        _riskLevel: string,
        allowlistOptions: AllowlistOption[],
        scopeOptions: ScopeOption[],
      ) => {
        capturedAllowlist = allowlistOptions;
        capturedScopes = scopeOptions;
        return { decision: "allow" as const };
      },
      resolveConfirmation: () => {},
      updateSender: () => {},
      dispose: () => {},
    } as unknown as PermissionPrompter;

    const executor = new ToolExecutor(prompter);
    await executor.execute("bash", { command: "npm install" }, makeContext());

    // Verify that the prompter received allowlist options
    expect(capturedAllowlist).toBeDefined();
    expect(capturedAllowlist!.length).toBeGreaterThan(0);
    // The mock returns [{label: 'exact', description: 'exact', pattern: 'exact'}]
    expect(capturedAllowlist![0]).toHaveProperty("pattern");
    expect(capturedAllowlist![0]).toHaveProperty("label");
    expect(capturedAllowlist![0]).toHaveProperty("description");

    // Verify scope options are also passed
    expect(capturedScopes).toBeDefined();
    expect(capturedScopes!.length).toBeGreaterThan(0);
    expect(capturedScopes![0]).toHaveProperty("scope");
  });
});
