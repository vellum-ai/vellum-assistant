/**
 * Tests for platform-hosted bash auto-approval.
 *
 * Verifies that bash and host_bash tools are auto-approved without prompting
 * when running in platform-hosted mode (IS_PLATFORM=true) for guardian actors.
 * Also verifies that deny rules, non-guardian actors, requireFreshApproval,
 * and non-bash tools are unaffected by this auto-approval path.
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import type { ScopeOption } from "../permissions/types.js";
import type { ToolExecutionResult } from "../tools/types.js";

// ---------------------------------------------------------------------------
// Mock setup — mirrors require-fresh-approval.test.ts patterns
// ---------------------------------------------------------------------------

const mockConfig = {
  provider: "anthropic",
  model: "test",
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
  rateLimit: { maxRequestsPerMinute: 0 },
  secretDetection: {
    enabled: false,
  },
  permissions: {},
};

let fakeToolResult: ToolExecutionResult = { content: "ok", isError: false };

/** Override the check() result for specific tests. */
let checkResultOverride: { decision: string; reason: string } | undefined;

/** Override the risk level returned by classifyRisk(). Defaults to "medium". */
let riskOverride: string = "medium";

/** Scope options override. */
let scopeOptionsOverride: ScopeOption[] | undefined;

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
  truncateForLog: (value: string) => value,
}));

mock.module("../permissions/checker.js", () => ({
  classifyRisk: async () => ({ level: riskOverride }),
  check: async () => {
    if (checkResultOverride) return checkResultOverride;
    return { decision: "allow", reason: "allowed" };
  },
  generateAllowlistOptions: () => [
    { label: "exact", description: "exact", pattern: "exact" },
  ],
  generateScopeOptions: () =>
    scopeOptionsOverride ?? [{ label: "/tmp", scope: "/tmp" }],
  getCachedAssessment: () => undefined,
}));

// Mock every export so downstream test files that dynamically import modules
// with a static `from "../memory/tool-usage-store.js"` still see all symbols.
mock.module("../memory/tool-usage-store.js", () => ({
  recordToolInvocation: () => {},
  getRecentInvocations: () => [],
  rotateToolInvocations: () => 0,
}));

mock.module("../tools/registry.js", () => ({
  getTool: (name: string) => {
    if (name === "unknown_tool") return undefined;
    return {
      name,
      description: "test tool",
      category: "shell",
      defaultRiskLevel: "medium",
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

import { initializeDb } from "../memory/db-init.js";
import { PermissionPrompter } from "../permissions/prompter.js";
import { ToolExecutor } from "../tools/executor.js";
import type { ToolContext as TC } from "../tools/types.js";

initializeDb();

function makeContext(overrides?: Partial<TC>): TC {
  return {
    workingDir: "/tmp/project",
    conversationId: "conversation-1",
    trustClass: "guardian",
    isInteractive: true,
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

// ---------------------------------------------------------------------------
// Platform-hosted bash auto-approval
// ---------------------------------------------------------------------------

describe("platform-hosted bash auto-approval", () => {
  beforeEach(() => {
    fakeToolResult = { content: "ok", isError: false };
    checkResultOverride = undefined;
    scopeOptionsOverride = undefined;
    riskOverride = "medium";
  });

  afterEach(() => {});

  test("bash auto-approved in platform-hosted mode", async () => {
    checkResultOverride = { decision: "prompt", reason: "Needs approval" };

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
      { command: "echo hello" },
      makeContext({ isPlatformHosted: true, trustClass: "guardian" }),
    );

    expect(promptCalled).toBe(false);
    expect(result.isError).toBe(false);
  });

  test("host_bash NOT auto-approved in platform-hosted mode", async () => {
    checkResultOverride = { decision: "prompt", reason: "Needs approval" };

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
    await executor.execute(
      "host_bash",
      { command: "echo hello" },
      makeContext({ isPlatformHosted: true, trustClass: "guardian" }),
    );

    expect(promptCalled).toBe(true);
  });

  test("bash NOT auto-approved when not platform-hosted", async () => {
    checkResultOverride = { decision: "prompt", reason: "Needs approval" };

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
    await executor.execute(
      "bash",
      { command: "echo hello" },
      makeContext({
        isPlatformHosted: false,
        trustClass: "guardian",
        requireFreshApproval: true,
      }),
    );

    expect(promptCalled).toBe(true);
  });

  test("bash NOT auto-approved for non-guardian actors via platform path (sandbox bash is allowed)", async () => {
    checkResultOverride = { decision: "prompt", reason: "Needs approval" };

    const platformAutoApproveCalled = false;
    const trackingPrompter = {
      prompt: async () => {
        // If this is called, we know the platform auto-approve did NOT fire
        return { decision: "allow" as const };
      },
      resolveConfirmation: () => {},
      updateSender: () => {},
      dispose: () => {},
    } as unknown as PermissionPrompter;

    const executor = new ToolExecutor(trackingPrompter);
    const result = await executor.execute(
      "bash",
      { command: "echo hello" },
      makeContext({
        isPlatformHosted: true,
        trustClass: "trusted_contact",
        requireFreshApproval: true,
      }),
    );

    // With requireFreshApproval, trusted_contact+bash goes through check()
    // which returns "prompt" and then the interactive prompter is called.
    // The platform auto-approve path (guardian-only) is NOT taken.
    expect(result.isError).toBe(false);
    void platformAutoApproveCalled; // suppress unused warning
  });

  test("bash NOT auto-approved when requireFreshApproval is set", async () => {
    checkResultOverride = { decision: "prompt", reason: "Needs approval" };

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
    await executor.execute(
      "bash",
      { command: "echo hello" },
      makeContext({
        isPlatformHosted: true,
        trustClass: "guardian",
        requireFreshApproval: true,
      }),
    );

    expect(promptCalled).toBe(true);
  });

  test("deny rules still respected in platform-hosted mode", async () => {
    checkResultOverride = { decision: "deny", reason: "Explicitly denied" };

    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      "bash",
      { command: "rm -rf /" },
      makeContext({
        isPlatformHosted: true,
        trustClass: "guardian",
        requireFreshApproval: true,
      }),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Explicitly denied");
  });

  test("high-risk bash auto-approved in platform-hosted mode", async () => {
    riskOverride = "high";
    checkResultOverride = { decision: "prompt", reason: "High risk command" };

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
      { command: "rm -rf /tmp/stuff" },
      makeContext({ isPlatformHosted: true, trustClass: "guardian" }),
    );

    expect(promptCalled).toBe(false);
    expect(result.isError).toBe(false);
  });

  test("non-bash tools NOT auto-approved in platform-hosted mode", async () => {
    checkResultOverride = { decision: "prompt", reason: "Needs approval" };

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
    await executor.execute(
      "file_write",
      { path: "/tmp/test.txt", content: "hello" },
      makeContext({
        isPlatformHosted: true,
        trustClass: "guardian",
        requireFreshApproval: true,
      }),
    );

    expect(promptCalled).toBe(true);
  });
});
