/**
 * Tests for the host-access gate in the permission checker.
 *
 * When the `permission-controls-v2` feature flag is enabled, the permission
 * checker replaces the risk-classification path with a simple binary check:
 *   - Host tools + hostAccess=false → falls through to interactive prompter
 *   - Host tools + hostAccess=true → auto-allowed
 *   - Non-host tools → auto-allowed (no risk classification)
 *   - requireFreshApproval → falls through to interactive prompter
 *   - forcePromptSideEffects + side-effect tool → falls through to prompter
 *
 * When the flag is off, existing risk-level behavior is completely unchanged.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { _setOverridesForTesting } from "../config/assistant-feature-flags.js";
import type { PermissionPrompter } from "../permissions/prompter.js";
import { RiskLevel } from "../permissions/types.js";
import { PermissionChecker } from "../tools/permission-checker.js";
import type {
  ExecutionTarget,
  Tool,
  ToolContext,
  ToolLifecycleEvent,
} from "../tools/types.js";

// ---------------------------------------------------------------------------
// Mocks — suppress the risk classification / trust-rule subsystem so we can
// test the v2 early-return gate in isolation.
// ---------------------------------------------------------------------------

mock.module("../permissions/checker.js", () => ({
  classifyRisk: async () => ({ level: RiskLevel.Low }),
  check: async () => ({ decision: "allow", reason: "" }),
  generateAllowlistOptions: async () => [],
  generateScopeOptions: () => [],
}));

const hostAccessByConversation = new Map<string, boolean>();

mock.module("../memory/conversation-crud.js", () => ({
  getConversationHostAccess: (conversationId: string) =>
    hostAccessByConversation.get(conversationId) ?? false,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePrompter(): PermissionPrompter {
  return {
    prompt: async () => ({ decision: "allow" as const }),
  } as unknown as PermissionPrompter;
}

function makeTool(name: string): Tool {
  return {
    name,
    description: "test tool",
    category: "test",
    defaultRiskLevel: RiskLevel.Low,
    getDefinition: () => ({
      name,
      description: "test",
      input_schema: { type: "object" as const, properties: {} },
    }),
    execute: async () => ({ content: "", isError: false }),
  };
}

function makeContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    workingDir: "/tmp/test",
    conversationId: "test-conv",
    trustClass: "guardian",
    isInteractive: true,
    ...overrides,
  } as ToolContext;
}

const noopEmit = (_event: ToolLifecycleEvent): void => {};
const noopDiff = () => undefined;
const executionTarget: ExecutionTarget = "host";

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  _setOverridesForTesting({});
  hostAccessByConversation.clear();
});

afterEach(() => {
  _setOverridesForTesting({});
  hostAccessByConversation.clear();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("permission-checker host-access gate (v2)", () => {
  describe("when permission-controls-v2 flag is ON", () => {
    beforeEach(() => {
      _setOverridesForTesting({ "permission-controls-v2": true });
    });

    const HOST_TOOL_NAMES = [
      "host_bash",
      "host_file_read",
      "host_file_write",
      "host_file_edit",
      "computer_use_run_applescript",
    ];

    describe("host tools with hostAccess=false", () => {
      beforeEach(() => {
        hostAccessByConversation.set("test-conv", false);
      });

      for (const toolName of HOST_TOOL_NAMES) {
        test(`${toolName} falls through to prompter (interactive prompt)`, async () => {
          const promptSpy = mock(() =>
            Promise.resolve({ decision: "allow" as const }),
          );
          const prompter = {
            prompt: promptSpy,
          } as unknown as PermissionPrompter;
          const checker = new PermissionChecker(prompter);
          const result = await checker.checkPermission(
            toolName,
            {},
            makeTool(toolName),
            makeContext(),
            executionTarget,
            noopEmit,
            Date.now(),
            noopDiff,
          );

          // The prompter should have been called (interactive dialog)
          expect(promptSpy).toHaveBeenCalled();
          const call = promptSpy.mock.calls[0] as unknown as unknown[];
          expect(call[3]).toEqual([]);
          expect(call[4]).toEqual([]);
          expect(call[8]).toBe(false);
          expect(call[10]).toBeUndefined();
          expect(call[12]).toBe(true);
          // Since the mock prompter returns "allow", the result should be allowed
          expect(result.allowed).toBe(true);
          expect(result.decision).toBe("allow");
        });
      }

      test("host tool denied by user through prompter returns allowed=false", async () => {
        const promptSpy = mock(() =>
          Promise.resolve({ decision: "deny" as const }),
        );
        const prompter = {
          prompt: promptSpy,
        } as unknown as PermissionPrompter;
        const checker = new PermissionChecker(prompter);
        const result = await checker.checkPermission(
          "host_bash",
          {},
          makeTool("host_bash"),
          makeContext(),
          executionTarget,
          noopEmit,
          Date.now(),
          noopDiff,
        );

        expect(promptSpy).toHaveBeenCalled();
        expect(result.allowed).toBe(false);
        expect(result.decision).toBe("deny");
      });
    });

    describe("host tools with hostAccess=true", () => {
      beforeEach(() => {
        hostAccessByConversation.set("test-conv", true);
      });

      for (const toolName of HOST_TOOL_NAMES) {
        test(`${toolName} is auto-allowed`, async () => {
          const checker = new PermissionChecker(makePrompter());
          const result = await checker.checkPermission(
            toolName,
            {},
            makeTool(toolName),
            makeContext(),
            executionTarget,
            noopEmit,
            Date.now(),
            noopDiff,
          );

          expect(result.allowed).toBe(true);
          expect(result.decision).toBe("allow");
        });
      }
    });

    describe("non-host tools are auto-allowed (no risk classification)", () => {
      for (const toolName of [
        "bash",
        "file_read",
        "file_write",
        "web_search",
      ]) {
        test(`${toolName} is auto-allowed regardless of hostAccess`, async () => {
          hostAccessByConversation.set("test-conv", false);
          const checker = new PermissionChecker(makePrompter());
          const result = await checker.checkPermission(
            toolName,
            {},
            makeTool(toolName),
            makeContext(),
            "sandbox",
            noopEmit,
            Date.now(),
            noopDiff,
          );

          expect(result.allowed).toBe(true);
          expect(result.decision).toBe("allow");
        });
      }
    });

    describe("requireFreshApproval bypasses v2 auto-allow", () => {
      beforeEach(() => {
        hostAccessByConversation.set("test-conv", true);
      });

      test("host tool with requireFreshApproval falls through to prompter", async () => {
        const promptSpy = mock(() =>
          Promise.resolve({ decision: "allow" as const }),
        );
        const prompter = {
          prompt: promptSpy,
        } as unknown as PermissionPrompter;
        const checker = new PermissionChecker(prompter);
        const result = await checker.checkPermission(
          "host_bash",
          {},
          makeTool("host_bash"),
          makeContext({ requireFreshApproval: true }),
          executionTarget,
          noopEmit,
          Date.now(),
          noopDiff,
        );

        expect(promptSpy).toHaveBeenCalled();
        const call = promptSpy.mock.calls[0] as unknown as unknown[];
        expect(call[3]).toEqual([]);
        expect(call[4]).toEqual([]);
        expect(call[8]).toBe(false);
        expect(call[10]).toBeUndefined();
        expect(call[12]).toBe(false);
        expect(result.allowed).toBe(true);
        expect(result.decision).toBe("allow");
      });

      test("non-host side-effect tool with requireFreshApproval falls through to prompter", async () => {
        const promptSpy = mock(() =>
          Promise.resolve({ decision: "allow" as const }),
        );
        const prompter = {
          prompt: promptSpy,
        } as unknown as PermissionPrompter;
        const checker = new PermissionChecker(prompter);
        const result = await checker.checkPermission(
          "bash",
          { command: "echo hi" },
          makeTool("bash"),
          makeContext({ requireFreshApproval: true }),
          "sandbox",
          noopEmit,
          Date.now(),
          noopDiff,
        );

        expect(promptSpy).toHaveBeenCalled();
        const call = promptSpy.mock.calls[0] as unknown as unknown[];
        expect(call[3]).toEqual([]);
        expect(call[4]).toEqual([]);
        expect(call[8]).toBe(false);
        expect(call[10]).toBeUndefined();
        expect(call[12]).toBe(false);
        expect(result.allowed).toBe(true);
        expect(result.decision).toBe("allow");
      });
    });

    describe("non-interactive guardian session with hostAccess=false", () => {
      beforeEach(() => {
        hostAccessByConversation.set("test-conv", false);
      });

      test("host tool is NOT auto-approved (denies instead of guardian_auto_approve)", async () => {
        const promptSpy = mock(() =>
          Promise.resolve({ decision: "allow" as const }),
        );
        const prompter = {
          prompt: promptSpy,
        } as unknown as PermissionPrompter;
        const checker = new PermissionChecker(prompter);
        const result = await checker.checkPermission(
          "host_bash",
          {},
          makeTool("host_bash"),
          makeContext({ isInteractive: false, trustClass: "guardian" }),
          executionTarget,
          noopEmit,
          Date.now(),
          noopDiff,
        );

        // v2ForcePrompt is true (hostAccess=false), so the non-interactive
        // guardian auto-approve must NOT fire. Since there is no interactive
        // client, the tool should be denied.
        expect(promptSpy).not.toHaveBeenCalled();
        expect(result.allowed).toBe(false);
        expect(result.decision).toBe("denied");
      });
    });

    describe("forcePromptSideEffects bypasses v2 auto-allow for side-effect tools", () => {
      beforeEach(() => {
        hostAccessByConversation.set("test-conv", true);
      });

      test("host side-effect tool with forcePromptSideEffects falls through to prompter", async () => {
        const promptSpy = mock(() =>
          Promise.resolve({ decision: "allow" as const }),
        );
        const prompter = {
          prompt: promptSpy,
        } as unknown as PermissionPrompter;
        const checker = new PermissionChecker(prompter);
        const result = await checker.checkPermission(
          "host_bash",
          {},
          makeTool("host_bash"),
          makeContext({ forcePromptSideEffects: true }),
          executionTarget,
          noopEmit,
          Date.now(),
          noopDiff,
        );

        expect(promptSpy).toHaveBeenCalled();
        expect(result.allowed).toBe(true);
        expect(result.decision).toBe("allow");
      });

      test("non-host side-effect tool with forcePromptSideEffects falls through to prompter", async () => {
        const promptSpy = mock(() =>
          Promise.resolve({ decision: "allow" as const }),
        );
        const prompter = {
          prompt: promptSpy,
        } as unknown as PermissionPrompter;
        const checker = new PermissionChecker(prompter);
        const result = await checker.checkPermission(
          "bash",
          { command: "echo hi" },
          makeTool("bash"),
          makeContext({ forcePromptSideEffects: true }),
          "sandbox",
          noopEmit,
          Date.now(),
          noopDiff,
        );

        expect(promptSpy).toHaveBeenCalled();
        expect(result.allowed).toBe(true);
        expect(result.decision).toBe("allow");
      });

      test("non-host read-only tool with forcePromptSideEffects is still auto-allowed", async () => {
        const checker = new PermissionChecker(makePrompter());
        const result = await checker.checkPermission(
          "file_read",
          {},
          makeTool("file_read"),
          makeContext({ forcePromptSideEffects: true }),
          "sandbox",
          noopEmit,
          Date.now(),
          noopDiff,
        );

        // file_read is not a side-effect tool, so v2 auto-allows it
        expect(result.allowed).toBe(true);
        expect(result.decision).toBe("allow");
      });
    });

    test("host access is evaluated per conversation", async () => {
      hostAccessByConversation.set("allow-conv", true);
      hostAccessByConversation.set("deny-conv", false);

      const promptSpy = mock(() =>
        Promise.resolve({ decision: "deny" as const }),
      );
      const checker = new PermissionChecker({
        prompt: promptSpy,
      } as unknown as PermissionPrompter);

      const allowed = await checker.checkPermission(
        "host_bash",
        {},
        makeTool("host_bash"),
        makeContext({ conversationId: "allow-conv" }),
        executionTarget,
        noopEmit,
        Date.now(),
        noopDiff,
      );
      const denied = await checker.checkPermission(
        "host_bash",
        {},
        makeTool("host_bash"),
        makeContext({ conversationId: "deny-conv" }),
        executionTarget,
        noopEmit,
        Date.now(),
        noopDiff,
      );

      expect(allowed.allowed).toBe(true);
      expect(allowed.decision).toBe("allow");
      expect(denied.allowed).toBe(false);
      expect(denied.decision).toBe("deny");
      expect(promptSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("when permission-controls-v2 flag is OFF", () => {
    beforeEach(() => {
      _setOverridesForTesting({ "permission-controls-v2": false });
    });

    test("host_bash falls through to existing risk classification (returns allow from mocked checker)", async () => {
      const checker = new PermissionChecker(makePrompter());
      const result = await checker.checkPermission(
        "host_bash",
        {},
        makeTool("host_bash"),
        makeContext(),
        executionTarget,
        noopEmit,
        Date.now(),
        noopDiff,
      );

      // The mocked checker returns 'allow', so the result should be
      // allowed with the old risk-classification path's risk level.
      expect(result.allowed).toBe(true);
      expect(result.decision).toBe("allow");
      // When flag is off, riskLevel comes from classifyRisk (mocked as "low")
      expect(result.riskLevel).toBe(RiskLevel.Low);
    });

    test("non-host tools also follow old path", async () => {
      const checker = new PermissionChecker(makePrompter());
      const result = await checker.checkPermission(
        "bash",
        { command: "echo hello" },
        makeTool("bash"),
        makeContext(),
        "sandbox",
        noopEmit,
        Date.now(),
        noopDiff,
      );

      expect(result.allowed).toBe(true);
      expect(result.decision).toBe("allow");
      expect(result.riskLevel).toBe(RiskLevel.Low);
    });
  });
});
