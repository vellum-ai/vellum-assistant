/**
 * Non-interactive guardian sessions auto-approve prompted tools within the
 * background threshold — but inline-command ("dynamic") skill loads must
 * never ride that path. They execute embedded shell commands at load time,
 * so a prompted (i.e. not covered by a trust rule) dynamic load requires a
 * human: in a session with no interactive client it is denied, not
 * silently approved.
 *
 * The gate lives in tools/permission-checker.ts and keys off
 * `isDynamicSkillLoadInvocation` from permissions/checker.js (resolved
 * skill metadata), not off any matched-rule pattern.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { RiskLevel } from "../permissions/types.js";
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
  secretDetection: { enabled: false },
};

const fakeToolResult: ToolExecutionResult = { content: "ok", isError: false };

/** Controls what isDynamicSkillLoadInvocation reports for the invocation. */
let dynamicSkillLoad = false;

mock.module("../config/loader.js", () => ({
  getConfig: () => mockConfig,
  loadConfig: () => mockConfig,
  invalidateConfigCache: () => {},
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

mock.module("../permissions/channel-permission-query.js", () => ({
  buildChannelPermissionCellQuery: () => undefined,
}));

// check() always prompts: the scenario under test is "no trust rule covers
// this load" (a covering rule lowers the classified risk upstream, so the
// covered case resolves to "allow" before the background gate is reached).
mock.module("../permissions/checker.js", () => ({
  isDynamicSkillLoadInvocation: () => dynamicSkillLoad,
  classifyRisk: async () => ({ level: "medium" }),
  check: async () => ({ decision: "prompt", reason: "medium risk" }),
  generateAllowlistOptions: () => [],
  generateScopeOptions: () => [],
  getCachedAssessment: () => undefined,
}));

mock.module("../telemetry/tool-usage-store.js", () => ({
  recordToolInvocation: () => {},
  getRecentInvocations: () => [],
  rotateToolInvocations: async () => 0,
}));

mock.module("../tools/registry.js", () => ({
  getTool: (name: string) => ({
    name,
    description: "test tool",
    category: "skills",
    defaultRiskLevel: "medium",
    input_schema: {},
    execute: async () => fakeToolResult,
  }),
  getAllTools: () => [],
}));

// Background threshold "medium" covers the medium-risk load — the guard,
// not the threshold, must be what blocks the dynamic case.
mock.module("../permissions/gateway-threshold-reader.js", () => ({
  getAutoApproveThreshold: async () => "medium",
  refreshAutoApproveThreshold: async () => null,
  _clearGlobalCacheForTesting: () => {},
}));

mock.module("../tools/shared/filesystem/path-policy.js", () => ({
  sandboxPolicy: () => ({ ok: false }),
  hostPolicy: () => ({ ok: false }),
}));

import type { PermissionPrompter } from "../permissions/prompter.js";
import { PermissionChecker } from "../tools/permission-checker.js";
import type { Tool, ToolContext } from "../tools/types.js";

const skillLoadTool: Tool = {
  name: "skill_load",
  description: "test tool",
  category: "skills",
  defaultRiskLevel: RiskLevel.Medium,
  executionTarget: "sandbox",
  input_schema: {},
  execute: async () => fakeToolResult,
};

// The prompter must never be reached in a non-interactive session; throwing
// makes an unexpected prompt fail the test loudly.
const throwingPrompter = {
  prompt: () => {
    throw new Error("prompter must not be invoked in a background session");
  },
} as unknown as PermissionPrompter;

function makeBackgroundGuardianContext(): ToolContext {
  return {
    workingDir: "/tmp/project",
    conversationId: "conversation-1",
    trustClass: "guardian",
    isInteractive: false,
  };
}

async function checkSkillLoad(skill: string) {
  const checker = new PermissionChecker(throwingPrompter);
  return checker.checkPermission(
    "skill_load",
    { skill },
    skillLoadTool,
    makeBackgroundGuardianContext(),
    "sandbox",
    Date.now(),
    () => undefined,
  );
}

beforeEach(() => {
  dynamicSkillLoad = false;
});

afterAll(() => {
  mock.restore();
});

describe("non-interactive guardian background auto-approve", () => {
  test("a plain prompted skill_load within the background threshold is auto-approved", async () => {
    const decision = await checkSkillLoad("plain-skill");
    expect(decision.allowed).toBe(true);
    expect(decision.decision).toBe("guardian_auto_approve");
  });

  test("a prompted dynamic skill load is denied, never silently auto-approved", async () => {
    dynamicSkillLoad = true;
    const decision = await checkSkillLoad("inline-command-skill");
    expect(decision.allowed).toBe(false);
    expect(decision.decision).toBe("denied");
  });
});
