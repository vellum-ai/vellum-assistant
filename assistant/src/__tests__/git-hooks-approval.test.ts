import { describe, expect, mock, test } from "bun:test";

import {
  GIT_HOOKS_TRUST_TOOL_NAME,
  requestGitHooksTrustApproval,
} from "../daemon/git-hooks-approval.js";
import type { PermissionPrompter } from "../permissions/prompter.js";
import type { UserDecision } from "../permissions/types.js";

function createMockPrompter(decision: UserDecision): PermissionPrompter {
  const promptFn = mock(() =>
    Promise.resolve({
      decision,
      selectedPattern: undefined,
      selectedScope: undefined,
      decisionContext: undefined,
    }),
  );
  return { prompt: promptFn } as unknown as PermissionPrompter;
}

describe("requestGitHooksTrustApproval", () => {
  // ── Prompt shape ──

  test("uses the reserved pseudo tool name", async () => {
    const prompter = createMockPrompter("allow");
    await requestGitHooksTrustApproval(prompter);

    expect(prompter.prompt).toHaveBeenCalledTimes(1);
    const args = (prompter.prompt as ReturnType<typeof mock>).mock.calls[0];
    expect(args[0]).toBe(GIT_HOOKS_TRUST_TOOL_NAME);
  });

  test("passes medium risk level", async () => {
    const prompter = createMockPrompter("allow");
    await requestGitHooksTrustApproval(prompter);

    const args = (prompter.prompt as ReturnType<typeof mock>).mock.calls[0];
    // riskLevel is the 3rd argument (index 2)
    expect(args[2]).toBe("medium");
  });

  test("provides empty allowlist and scope options", async () => {
    const prompter = createMockPrompter("allow");
    await requestGitHooksTrustApproval(prompter);

    const args = (prompter.prompt as ReturnType<typeof mock>).mock.calls[0];
    // allowlistOptions (index 3) and scopeOptions (index 4)
    expect(args[3]).toEqual([]);
    expect(args[4]).toEqual([]);
  });

  test("sets persistentDecisionsAllowed to false (one-shot prompt)", async () => {
    const prompter = createMockPrompter("allow");
    await requestGitHooksTrustApproval(prompter);

    const args = (prompter.prompt as ReturnType<typeof mock>).mock.calls[0];
    // persistentDecisionsAllowed is index 9
    expect(args[9]).toBe(false);
  });

  test("includes explicit user-facing description in the input", async () => {
    const prompter = createMockPrompter("allow");
    await requestGitHooksTrustApproval(prompter);

    const args = (prompter.prompt as ReturnType<typeof mock>).mock.calls[0];
    // input is the 2nd argument (index 1)
    const input = args[1] as Record<string, unknown>;
    expect(typeof input.description).toBe("string");
    expect(input.description).toContain("git hooks");
    expect(input.description).toContain("trust");
  });

  // ── Decision mapping ──

  test("maps allow decision to approved: true", async () => {
    const prompter = createMockPrompter("allow");
    const result = await requestGitHooksTrustApproval(prompter);
    expect(result).toEqual({ approved: true });
  });

  test("maps deny decision to approved: false", async () => {
    const prompter = createMockPrompter("deny");
    const result = await requestGitHooksTrustApproval(prompter);
    expect(result).toEqual({ approved: false });
  });

  test("maps always_deny decision to approved: false", async () => {
    const prompter = createMockPrompter("always_deny");
    const result = await requestGitHooksTrustApproval(prompter);
    expect(result).toEqual({ approved: false });
  });

  test("maps always_allow decision to approved: true", async () => {
    const prompter = createMockPrompter("always_allow");
    const result = await requestGitHooksTrustApproval(prompter);
    expect(result).toEqual({ approved: true });
  });

  test("maps allow_10m decision to approved: true", async () => {
    const prompter = createMockPrompter("allow_10m");
    const result = await requestGitHooksTrustApproval(prompter);
    expect(result).toEqual({ approved: true });
  });

  test("maps allow_thread decision to approved: true", async () => {
    const prompter = createMockPrompter("allow_thread");
    const result = await requestGitHooksTrustApproval(prompter);
    expect(result).toEqual({ approved: true });
  });

  // ── Signal forwarding ──

  test("forwards abort signal to prompter", async () => {
    const controller = new AbortController();
    const prompter = createMockPrompter("allow");

    await requestGitHooksTrustApproval(prompter, {
      signal: controller.signal,
    });

    const args = (prompter.prompt as ReturnType<typeof mock>).mock.calls[0];
    // signal is index 10
    expect(args[10]).toBe(controller.signal);
  });

  test("works without signal option", async () => {
    const prompter = createMockPrompter("allow");
    const result = await requestGitHooksTrustApproval(prompter);
    expect(result).toEqual({ approved: true });

    const args = (prompter.prompt as ReturnType<typeof mock>).mock.calls[0];
    // signal should be undefined when not provided
    expect(args[10]).toBeUndefined();
  });

  // ── Tool name constant ──

  test("GIT_HOOKS_TRUST_TOOL_NAME is the reserved internal pseudo tool name", () => {
    expect(GIT_HOOKS_TRUST_TOOL_NAME).toBe("__internal:git-hooks-trust");
  });
});
