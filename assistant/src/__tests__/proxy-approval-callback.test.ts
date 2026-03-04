import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { ProxyApprovalRequest } from "../outbound-proxy/index.js";

// ---------------------------------------------------------------------------
// Mocks — must precede the import of `createProxyApprovalCallback`.
// ---------------------------------------------------------------------------

const addRuleMock = mock(() => {});
const findHighestPriorityRuleMock = mock(
  () =>
    null as ReturnType<
      typeof import("../permissions/trust-store.js").findHighestPriorityRule
    >,
);

mock.module("../permissions/trust-store.js", () => ({
  addRule: addRuleMock,
  findHighestPriorityRule: findHighestPriorityRuleMock,
  clearCache: () => {},
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},

    provider: "mock-provider",
    timeouts: { permissionTimeoutSec: 5 },
    permissions: { mode: "legacy" },
    skills: { load: { extraDirs: [] } },
  }),
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

mock.module("../security/redaction.js", () => ({
  redactSensitiveFields: (input: Record<string, unknown>) => input,
}));

// ---------------------------------------------------------------------------
// Import after mocks are registered.
// ---------------------------------------------------------------------------

import type { ToolSetupContext } from "../daemon/session-tool-setup.js";
import { createProxyApprovalCallback } from "../daemon/session-tool-setup.js";
import { PermissionPrompter } from "../permissions/prompter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(overrides?: Partial<ToolSetupContext>): ToolSetupContext {
  return {
    conversationId: "conv-test",
    workingDir: "/tmp/test-project",
    abortController: null,
    memoryPolicy: { scopeId: "default", strictSideEffects: false },
    sendToClient: () => {},
    surfacesByAppId: new Map(),
    ...overrides,
  } as ToolSetupContext;
}

function makeAskMissingCredentialRequest(
  overrides?: Partial<ProxyApprovalRequest>,
): ProxyApprovalRequest {
  return {
    decision: {
      kind: "ask_missing_credential",
      target: {
        hostname: "api.fal.ai",
        port: 443,
        path: "/v1/run",
        scheme: "https",
      },
      matchingPatterns: ["*.fal.ai"],
    },
    sessionId: "session-1",
    ...overrides,
  };
}

function makeAskUnauthenticatedRequest(
  overrides?: Partial<ProxyApprovalRequest>,
): ProxyApprovalRequest {
  return {
    decision: {
      kind: "ask_unauthenticated",
      target: {
        hostname: "example.com",
        port: null,
        path: "/data",
        scheme: "https",
      },
    },
    sessionId: "session-2",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createProxyApprovalCallback", () => {
  beforeEach(() => {
    addRuleMock.mockClear();
    findHighestPriorityRuleMock.mockClear();
    findHighestPriorityRuleMock.mockReturnValue(null);
  });

  test("returns true when user allows an ask_missing_credential request", async () => {
    const ctx = makeContext();

    const _resolvePrompt:
      | ((v: {
          decision: string;
          selectedPattern?: string;
          selectedScope?: string;
        }) => void)
      | null = null;
    const prompterSendToClient = mock(() => {});
    const prompter = new PermissionPrompter(prompterSendToClient);

    // Intercept the prompter's prompt method to control the response
    const originalPrompt = prompter.prompt.bind(prompter);
    prompter.prompt = async (...args) => {
      const p = originalPrompt(...args);
      // Find the pending request and resolve it
      await new Promise((r) => setTimeout(r, 10));
      const call = (prompterSendToClient.mock.calls as unknown[][])[0];
      const msg = call[0] as { requestId: string };
      prompter.resolveConfirmation(msg.requestId, "allow");
      return p;
    };

    const callback = createProxyApprovalCallback(prompter, ctx);
    const result = await callback(makeAskMissingCredentialRequest());

    expect(result).toBe(true);
  });

  test("returns false when user denies an ask_unauthenticated request", async () => {
    const ctx = makeContext();

    const prompterSendToClient = mock(() => {});
    const prompter = new PermissionPrompter(prompterSendToClient);

    const originalPrompt = prompter.prompt.bind(prompter);
    prompter.prompt = async (...args) => {
      const p = originalPrompt(...args);
      await new Promise((r) => setTimeout(r, 10));
      const call = (prompterSendToClient.mock.calls as unknown[][])[0];
      const msg = call[0] as { requestId: string };
      prompter.resolveConfirmation(msg.requestId, "deny");
      return p;
    };

    const callback = createProxyApprovalCallback(prompter, ctx);
    const result = await callback(makeAskUnauthenticatedRequest());

    expect(result).toBe(false);
  });

  test("skips prompting and returns true when trust store has an allow rule (medium risk)", async () => {
    findHighestPriorityRuleMock.mockReturnValue({
      id: "rule-1",
      tool: "bash",
      pattern: "proxied_origin:https%3A%2F%2Fexample.com",
      scope: "/tmp/test-project",
      decision: "allow" as const,
      priority: 100,
      createdAt: Date.now(),
    });

    const ctx = makeContext();
    const prompterSendToClient = mock(() => {});
    const prompter = new PermissionPrompter(prompterSendToClient);

    const callback = createProxyApprovalCallback(prompter, ctx);
    // ask_unauthenticated is medium risk — plain allow rule auto-allows
    const result = await callback(makeAskUnauthenticatedRequest());

    expect(result).toBe(true);
    // Prompter should not have been called
    expect(prompterSendToClient).not.toHaveBeenCalled();
  });

  test("ignores default broad bash allow rules and still prompts", async () => {
    findHighestPriorityRuleMock.mockReturnValue({
      id: "default:allow-bash-global",
      tool: "bash",
      pattern: "**",
      scope: "everywhere",
      decision: "allow" as const,
      priority: 50,
      createdAt: Date.now(),
      allowHighRisk: true,
    });

    const ctx = makeContext();
    const prompterSendToClient = mock(() => {});
    const prompter = new PermissionPrompter(prompterSendToClient);

    const originalPrompt = prompter.prompt.bind(prompter);
    prompter.prompt = async (...args) => {
      const p = originalPrompt(...args);
      await new Promise((r) => setTimeout(r, 10));
      const call = (prompterSendToClient.mock.calls as unknown[][])[0];
      const msg = call[0] as { requestId: string };
      prompter.resolveConfirmation(msg.requestId, "allow");
      return p;
    };

    const callback = createProxyApprovalCallback(prompter, ctx);
    const result = await callback(makeAskUnauthenticatedRequest());

    expect(result).toBe(true);
    expect(prompterSendToClient).toHaveBeenCalled();
  });

  test("high-risk with plain allow rule (no allowHighRisk) falls through to prompt", async () => {
    findHighestPriorityRuleMock.mockReturnValue({
      id: "rule-hr-1",
      tool: "bash",
      pattern: "proxied_origin:https%3A%2F%2Fapi.fal.ai",
      scope: "/tmp/test-project",
      decision: "allow" as const,
      priority: 100,
      createdAt: Date.now(),
      // No allowHighRisk — should NOT auto-allow for high-risk decisions
    });

    const ctx = makeContext();
    const prompterSendToClient = mock(() => {});
    const prompter = new PermissionPrompter(prompterSendToClient);

    const originalPrompt = prompter.prompt.bind(prompter);
    prompter.prompt = async (...args) => {
      const p = originalPrompt(...args);
      await new Promise((r) => setTimeout(r, 10));
      const call = (prompterSendToClient.mock.calls as unknown[][])[0];
      const msg = call[0] as { requestId: string };
      prompter.resolveConfirmation(msg.requestId, "allow");
      return p;
    };

    const callback = createProxyApprovalCallback(prompter, ctx);
    // ask_missing_credential is high risk
    const result = await callback(makeAskMissingCredentialRequest());

    expect(result).toBe(true);
    // Prompter SHOULD have been called — plain allow rule doesn't auto-allow high-risk
    expect(prompterSendToClient).toHaveBeenCalled();
  });

  test("high-risk with allowHighRisk allow rule auto-allows without prompting", async () => {
    findHighestPriorityRuleMock.mockReturnValue({
      id: "rule-hr-2",
      tool: "bash",
      pattern: "proxied_origin:https%3A%2F%2Fapi.fal.ai",
      scope: "/tmp/test-project",
      decision: "allow" as const,
      priority: 100,
      createdAt: Date.now(),
      allowHighRisk: true,
    });

    const ctx = makeContext();
    const prompterSendToClient = mock(() => {});
    const prompter = new PermissionPrompter(prompterSendToClient);

    const callback = createProxyApprovalCallback(prompter, ctx);
    const result = await callback(makeAskMissingCredentialRequest());

    expect(result).toBe(true);
    // Prompter should NOT have been called — allowHighRisk rule auto-allows
    expect(prompterSendToClient).not.toHaveBeenCalled();
  });

  test("skips prompting and returns false when trust store has a deny rule", async () => {
    findHighestPriorityRuleMock.mockReturnValue({
      id: "rule-2",
      tool: "bash",
      pattern: "proxied_origin:https%3A%2F%2Fexample.com",
      scope: "/tmp/test-project",
      decision: "deny" as const,
      priority: 100,
      createdAt: Date.now(),
    });

    const ctx = makeContext();
    const prompterSendToClient = mock(() => {});
    const prompter = new PermissionPrompter(prompterSendToClient);

    const callback = createProxyApprovalCallback(prompter, ctx);
    const result = await callback(makeAskUnauthenticatedRequest());

    expect(result).toBe(false);
    expect(prompterSendToClient).not.toHaveBeenCalled();
  });

  test("fast-denies when hasNoClient is true (non-interactive session)", async () => {
    const ctx = makeContext({ hasNoClient: true });
    const prompterSendToClient = mock(() => {});
    const prompter = new PermissionPrompter(prompterSendToClient);

    const callback = createProxyApprovalCallback(prompter, ctx);
    const result = await callback(makeAskMissingCredentialRequest());

    expect(result).toBe(false);
    // Prompter should not have been called — fast-deny path
    expect(prompterSendToClient).not.toHaveBeenCalled();
  });

  test("prompts when trust store has an ask rule", async () => {
    findHighestPriorityRuleMock.mockReturnValue({
      id: "rule-3",
      tool: "bash",
      pattern: "proxied_origin:https%3A%2F%2Fexample.com",
      scope: "/tmp/test-project",
      decision: "ask" as const,
      priority: 100,
      createdAt: Date.now(),
    });

    const ctx = makeContext();
    const prompterSendToClient = mock(() => {});
    const prompter = new PermissionPrompter(prompterSendToClient);

    const originalPrompt = prompter.prompt.bind(prompter);
    prompter.prompt = async (...args) => {
      const p = originalPrompt(...args);
      await new Promise((r) => setTimeout(r, 10));
      const call = (prompterSendToClient.mock.calls as unknown[][])[0];
      const msg = call[0] as { requestId: string };
      prompter.resolveConfirmation(msg.requestId, "allow");
      return p;
    };

    const callback = createProxyApprovalCallback(prompter, ctx);
    const result = await callback(makeAskUnauthenticatedRequest());

    expect(result).toBe(true);
    // Prompter should have been called (ask rule forces prompt)
    expect(prompterSendToClient).toHaveBeenCalled();
  });

  test("persists allow rule when user chooses always_allow", async () => {
    const ctx = makeContext();
    const prompterSendToClient = mock(() => {});
    const prompter = new PermissionPrompter(prompterSendToClient);

    const originalPrompt = prompter.prompt.bind(prompter);
    prompter.prompt = async (...args) => {
      const p = originalPrompt(...args);
      await new Promise((r) => setTimeout(r, 10));
      const call = (prompterSendToClient.mock.calls as unknown[][])[0];
      const msg = call[0] as { requestId: string };
      prompter.resolveConfirmation(
        msg.requestId,
        "always_allow",
        "proxied_origin:https%3A%2F%2Fapi.fal.ai",
        "/tmp/test-project",
      );
      return p;
    };

    const callback = createProxyApprovalCallback(prompter, ctx);
    const result = await callback(makeAskMissingCredentialRequest());

    expect(result).toBe(true);
    expect(addRuleMock).toHaveBeenCalledWith(
      "bash",
      "proxied_origin:https%3A%2F%2Fapi.fal.ai",
      "/tmp/test-project",
      "allow",
      100,
      undefined,
    );
  });

  test("persists deny rule when user chooses always_deny", async () => {
    const ctx = makeContext();
    const prompterSendToClient = mock(() => {});
    const prompter = new PermissionPrompter(prompterSendToClient);

    const originalPrompt = prompter.prompt.bind(prompter);
    prompter.prompt = async (...args) => {
      const p = originalPrompt(...args);
      await new Promise((r) => setTimeout(r, 10));
      const call = (prompterSendToClient.mock.calls as unknown[][])[0];
      const msg = call[0] as { requestId: string };
      prompter.resolveConfirmation(
        msg.requestId,
        "always_deny",
        "proxied_origin:https%3A%2F%2Fexample.com",
        "everywhere",
      );
      return p;
    };

    const callback = createProxyApprovalCallback(prompter, ctx);
    const result = await callback(makeAskUnauthenticatedRequest());

    expect(result).toBe(false);
    expect(addRuleMock).toHaveBeenCalledWith(
      "bash",
      "proxied_origin:https%3A%2F%2Fexample.com",
      "everywhere",
      "deny",
    );
  });

  test("sends correct tool name for ask_missing_credential decisions", async () => {
    const ctx = makeContext();
    const prompterSendToClient = mock(() => {});
    const prompter = new PermissionPrompter(prompterSendToClient);

    const originalPrompt = prompter.prompt.bind(prompter);
    prompter.prompt = async (...args) => {
      const p = originalPrompt(...args);
      await new Promise((r) => setTimeout(r, 10));
      const call = (prompterSendToClient.mock.calls as unknown[][])[0];
      const msg = call[0] as {
        requestId: string;
        toolName: string;
        input: Record<string, unknown>;
      };
      // Verify the confirmation request uses the bash tool name
      expect(msg.toolName).toBe("bash");
      expect(msg.input).toHaveProperty("url", "https://api.fal.ai:443/v1/run");
      expect(msg.input).toHaveProperty("network_mode", "proxied");
      expect(msg.input).toHaveProperty(
        "command",
        "curl https://api.fal.ai:443/v1/run",
      );
      expect(msg.input).toHaveProperty("matching_patterns", ["*.fal.ai"]);
      prompter.resolveConfirmation(msg.requestId, "allow");
      return p;
    };

    const callback = createProxyApprovalCallback(prompter, ctx);
    await callback(makeAskMissingCredentialRequest());
  });

  test("sends correct tool name for ask_unauthenticated decisions", async () => {
    const ctx = makeContext();
    const prompterSendToClient = mock(() => {});
    const prompter = new PermissionPrompter(prompterSendToClient);

    const originalPrompt = prompter.prompt.bind(prompter);
    prompter.prompt = async (...args) => {
      const p = originalPrompt(...args);
      await new Promise((r) => setTimeout(r, 10));
      const call = (prompterSendToClient.mock.calls as unknown[][])[0];
      const msg = call[0] as {
        requestId: string;
        toolName: string;
        input: Record<string, unknown>;
        riskLevel: string;
      };
      expect(msg.toolName).toBe("bash");
      expect(msg.input).toHaveProperty("url", "https://example.com/data");
      expect(msg.input).toHaveProperty("network_mode", "proxied");
      expect(msg.riskLevel).toBe("medium");
      prompter.resolveConfirmation(msg.requestId, "deny");
      return p;
    };

    const callback = createProxyApprovalCallback(prompter, ctx);
    await callback(makeAskUnauthenticatedRequest());
  });

  test("uses high risk level for ask_missing_credential decisions", async () => {
    const ctx = makeContext();
    const prompterSendToClient = mock(() => {});
    const prompter = new PermissionPrompter(prompterSendToClient);

    const originalPrompt = prompter.prompt.bind(prompter);
    prompter.prompt = async (...args) => {
      const p = originalPrompt(...args);
      await new Promise((r) => setTimeout(r, 10));
      const call = (prompterSendToClient.mock.calls as unknown[][])[0];
      const msg = call[0] as { requestId: string; riskLevel: string };
      // Missing credential prompts are high risk — the target wants auth
      expect(msg.riskLevel).toBe("high");
      prompter.resolveConfirmation(msg.requestId, "allow");
      return p;
    };

    const callback = createProxyApprovalCallback(prompter, ctx);
    await callback(makeAskMissingCredentialRequest());
  });

  test("generates URL-based proxied bash allowlist options", async () => {
    const ctx = makeContext();
    const prompterSendToClient = mock(() => {});
    const prompter = new PermissionPrompter(prompterSendToClient);

    const originalPrompt = prompter.prompt.bind(prompter);
    prompter.prompt = async (...args) => {
      const p = originalPrompt(...args);
      await new Promise((r) => setTimeout(r, 10));
      const call = (prompterSendToClient.mock.calls as unknown[][])[0];
      const msg = call[0] as {
        requestId: string;
        allowlistOptions: Array<{ label: string; pattern: string }>;
      };
      // Proxied bash options include encoded exact URL, encoded origin, and
      // a proxied-url wildcard.
      const patterns = msg.allowlistOptions.map((o) => o.pattern);
      expect(patterns).toContain(
        "proxied_url:https%3A%2F%2Fapi.fal.ai%2Fv1%2Frun",
      );
      expect(patterns).toContain("proxied_origin:https%3A%2F%2Fapi.fal.ai");
      expect(patterns).toContain("proxied_url:*");
      prompter.resolveConfirmation(msg.requestId, "allow");
      return p;
    };

    const callback = createProxyApprovalCallback(prompter, ctx);
    await callback(makeAskMissingCredentialRequest());
  });

  test("generates allowlist options without port when port is null", async () => {
    const ctx = makeContext();
    const prompterSendToClient = mock(() => {});
    const prompter = new PermissionPrompter(prompterSendToClient);

    const originalPrompt = prompter.prompt.bind(prompter);
    prompter.prompt = async (...args) => {
      const p = originalPrompt(...args);
      await new Promise((r) => setTimeout(r, 10));
      const call = (prompterSendToClient.mock.calls as unknown[][])[0];
      const msg = call[0] as {
        requestId: string;
        allowlistOptions: Array<{ label: string; pattern: string }>;
      };
      // Port is null — URL should be https://example.com/data (no port)
      const patterns = msg.allowlistOptions.map((o) => o.pattern);
      expect(patterns).toContain("proxied_origin:https%3A%2F%2Fexample.com");
      // Should NOT include ":null" in any pattern
      expect(patterns.every((p) => !p.includes(":null"))).toBe(true);
      prompter.resolveConfirmation(msg.requestId, "deny");
      return p;
    };

    const callback = createProxyApprovalCallback(prompter, ctx);
    await callback(makeAskUnauthenticatedRequest());
  });

  // ── E2E persistence invariants (PR 32) ──────────────────────────────
  // These tests verify the proxy approval callback persists proxy-scoped
  // destination rules when the user chooses an always_* decision.

  test("always_allow_high_risk persists rule with allowHighRisk flag", async () => {
    const ctx = makeContext();
    const prompterSendToClient = mock(() => {});
    const prompter = new PermissionPrompter(prompterSendToClient);

    const originalPrompt = prompter.prompt.bind(prompter);
    prompter.prompt = async (...args) => {
      const p = originalPrompt(...args);
      await new Promise((r) => setTimeout(r, 10));
      const call = (prompterSendToClient.mock.calls as unknown[][])[0];
      const msg = call[0] as { requestId: string };
      prompter.resolveConfirmation(
        msg.requestId,
        "always_allow_high_risk",
        "proxied_origin:https%3A%2F%2Fapi.fal.ai",
        "/tmp/test-project",
      );
      return p;
    };

    const callback = createProxyApprovalCallback(prompter, ctx);
    const result = await callback(makeAskMissingCredentialRequest());

    expect(result).toBe(true);
    expect(addRuleMock).toHaveBeenCalledWith(
      "bash",
      "proxied_origin:https%3A%2F%2Fapi.fal.ai",
      "/tmp/test-project",
      "allow",
      100,
      { allowHighRisk: true },
    );
  });

  test("one-time allow does NOT persist any rule", async () => {
    const ctx = makeContext();
    const prompterSendToClient = mock(() => {});
    const prompter = new PermissionPrompter(prompterSendToClient);

    const originalPrompt = prompter.prompt.bind(prompter);
    prompter.prompt = async (...args) => {
      const p = originalPrompt(...args);
      await new Promise((r) => setTimeout(r, 10));
      const call = (prompterSendToClient.mock.calls as unknown[][])[0];
      const msg = call[0] as { requestId: string };
      prompter.resolveConfirmation(msg.requestId, "allow");
      return p;
    };

    const callback = createProxyApprovalCallback(prompter, ctx);
    const result = await callback(makeAskMissingCredentialRequest());

    expect(result).toBe(true);
    // One-time allow should NOT save any persistent rule
    expect(addRuleMock).not.toHaveBeenCalled();
  });

  test("one-time deny does NOT persist any rule", async () => {
    const ctx = makeContext();
    const prompterSendToClient = mock(() => {});
    const prompter = new PermissionPrompter(prompterSendToClient);

    const originalPrompt = prompter.prompt.bind(prompter);
    prompter.prompt = async (...args) => {
      const p = originalPrompt(...args);
      await new Promise((r) => setTimeout(r, 10));
      const call = (prompterSendToClient.mock.calls as unknown[][])[0];
      const msg = call[0] as { requestId: string };
      prompter.resolveConfirmation(msg.requestId, "deny");
      return p;
    };

    const callback = createProxyApprovalCallback(prompter, ctx);
    const result = await callback(makeAskUnauthenticatedRequest());

    expect(result).toBe(false);
    expect(addRuleMock).not.toHaveBeenCalled();
  });

  test("always_allow without selectedPattern does not persist a rule", async () => {
    const ctx = makeContext();
    const prompterSendToClient = mock(() => {});
    const prompter = new PermissionPrompter(prompterSendToClient);

    const originalPrompt = prompter.prompt.bind(prompter);
    prompter.prompt = async (...args) => {
      const p = originalPrompt(...args);
      await new Promise((r) => setTimeout(r, 10));
      const call = (prompterSendToClient.mock.calls as unknown[][])[0];
      const msg = call[0] as { requestId: string };
      // Resolve with always_allow but NO pattern/scope
      prompter.resolveConfirmation(msg.requestId, "always_allow");
      return p;
    };

    const callback = createProxyApprovalCallback(prompter, ctx);
    const result = await callback(makeAskMissingCredentialRequest());

    expect(result).toBe(true);
    // No pattern/scope -> cannot save a rule
    expect(addRuleMock).not.toHaveBeenCalled();
  });

  test("trust store candidates include encoded proxied URL patterns for bash", async () => {
    // Verify that findHighestPriorityRule is called with bash
    // tool name and URL-based candidates
    findHighestPriorityRuleMock.mockReturnValue(null);

    const ctx = makeContext();
    const prompterSendToClient = mock(() => {});
    const prompter = new PermissionPrompter(prompterSendToClient);

    const originalPrompt = prompter.prompt.bind(prompter);
    prompter.prompt = async (...args) => {
      const p = originalPrompt(...args);
      await new Promise((r) => setTimeout(r, 10));
      const call = (prompterSendToClient.mock.calls as unknown[][])[0];
      const msg = call[0] as { requestId: string };
      prompter.resolveConfirmation(msg.requestId, "allow");
      return p;
    };

    const callback = createProxyApprovalCallback(prompter, ctx);
    await callback(makeAskMissingCredentialRequest());

    // Verify findHighestPriorityRule was called with bash
    // and URL-based candidates
    expect(findHighestPriorityRuleMock).toHaveBeenCalledTimes(1);
    const [toolArg, candidatesArg] = findHighestPriorityRuleMock.mock
      .calls[0] as unknown as [string, string[], string];
    expect(toolArg).toBe("bash");
    // Candidates should include encoded URL-based proxy patterns.
    expect(
      candidatesArg.some((c: string) =>
        c.startsWith("proxied_url:https%3A%2F%2Fapi.fal.ai"),
      ),
    ).toBe(true);
    expect(candidatesArg).toContain("proxied_origin:https%3A%2F%2Fapi.fal.ai");
  });
});
