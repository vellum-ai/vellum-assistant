/**
 * Inline-command ("dynamic") skill loads execute embedded shell at load time,
 * so an uncovered one (no covering trust rule) is gated before it can run. The
 * non-guardian escalation lives in the sensitive-tool gate (lane A) and is
 * covered by tool-approval-handler.test.ts. This suite covers what the
 * permission checker (lane B) still owns for such loads:
 *
 * - A guardian background session auto-approves ordinary prompted tools within
 *   the background threshold, but an uncovered dynamic load is denied — no
 *   human is present to review embedded shell — at any threshold.
 * - A guardian interactive session self-approves within its threshold (allow at
 *   Full access); a plain (non-dynamic) load is untouched by the gate.
 *
 * The gate keys off `isDynamicSkillLoadInvocation` from permissions/checker.js
 * (resolved skill metadata).
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { RiskLevel } from "../permissions/types.js";
import type { ToolExecutionResult } from "../tools/types.js";

// ---------------------------------------------------------------------------
// Mock setup — mirrors require-fresh-approval.test.ts patterns
// ---------------------------------------------------------------------------

const fakeToolResult: ToolExecutionResult = { content: "ok", isError: false };

/** Controls what isDynamicSkillLoadInvocation reports for the invocation. */
let dynamicSkillLoad = false;

/**
 * Controls the decision check() returns. The non-interactive dynamic-load guard
 * is orthogonal to the threshold, so it must deny whether check() resolved to a
 * "prompt" (background threshold below High) or an "allow" (background threshold
 * at Full access).
 */
let checkDecision = "prompt";

mock.module("../permissions/channel-permission-query.js", () => ({
  buildChannelPermissionCellQuery: () => undefined,
}));

// The scenario under test is "no trust rule covers this load" (a covering rule
// lowers the classified risk upstream and arrives as matchType "user_rule",
// which the guard exempts). check()'s decision is variable so both the
// below-Full (prompt) and Full-access (allow) background cases are exercised.
mock.module("../permissions/checker.js", () => ({
  isDynamicSkillLoadInvocation: () => dynamicSkillLoad,
  classifyRisk: async () => ({ level: "medium" }),
  check: async () => ({ decision: checkDecision, reason: "medium risk" }),
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
    Date.now(),
    () => undefined,
  );
}

function makeInteractiveContext(
  trustClass: ToolContext["trustClass"],
): ToolContext {
  return {
    workingDir: "/tmp/project",
    conversationId: "conversation-1",
    trustClass,
    isInteractive: true,
  };
}

/** A prompter that records whether it was reached and resolves to `decision`. */
function makeRecordingPrompter(decision: "allow" | "deny") {
  let called = false;
  const prompter = {
    prompt: async () => {
      called = true;
      return { decision };
    },
  } as unknown as PermissionPrompter;
  return { prompter, wasCalled: () => called };
}

async function checkSkillLoadWith(
  prompter: PermissionPrompter,
  context: ToolContext,
  skill: string,
) {
  const checker = new PermissionChecker(prompter);
  return checker.checkPermission(
    "skill_load",
    { skill },
    skillLoadTool,
    context,
    Date.now(),
    () => undefined,
  );
}

beforeEach(() => {
  dynamicSkillLoad = false;
  checkDecision = "prompt";
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

  test("a dynamic skill load is denied even when check() allows it (Full-access background)", async () => {
    dynamicSkillLoad = true;
    checkDecision = "allow";
    const decision = await checkSkillLoad("inline-command-skill");
    expect(decision.allowed).toBe(false);
    expect(decision.decision).toBe("denied");
  });
});

describe("interactive self-approval gate", () => {
  test("a guardian at Full access self-approves an uncovered dynamic load without prompting", async () => {
    dynamicSkillLoad = true;
    checkDecision = "allow"; // Full access → check() allows
    const { prompter, wasCalled } = makeRecordingPrompter("deny");
    const decision = await checkSkillLoadWith(
      prompter,
      makeInteractiveContext("guardian"),
      "inline-command-skill",
    );
    expect(decision.allowed).toBe(true);
    expect(wasCalled()).toBe(false); // no escalation — the guardian self-approves
  });

  test("a non-guardian plain (non-dynamic) skill load is unaffected by the gate", async () => {
    dynamicSkillLoad = false;
    checkDecision = "allow";
    const { prompter, wasCalled } = makeRecordingPrompter("deny");
    const decision = await checkSkillLoadWith(
      prompter,
      makeInteractiveContext("trusted_contact"),
      "plain-skill",
    );
    expect(decision.allowed).toBe(true); // check()'s allow stands; gate skipped
    expect(wasCalled()).toBe(false);
  });
});
