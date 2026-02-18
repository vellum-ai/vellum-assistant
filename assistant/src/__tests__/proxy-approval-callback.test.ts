import { describe, expect, mock, test, beforeEach } from 'bun:test';
import type { ProxyApprovalRequest } from '../tools/network/script-proxy/types.js';

// ---------------------------------------------------------------------------
// Mocks — must precede the import of `createProxyApprovalCallback`.
// ---------------------------------------------------------------------------

const addRuleMock = mock(() => {});
const findHighestPriorityRuleMock = mock(() => null as ReturnType<typeof import('../permissions/trust-store.js').findHighestPriorityRule>);

mock.module('../permissions/trust-store.js', () => ({
  addRule: addRuleMock,
  findHighestPriorityRule: findHighestPriorityRuleMock,
  clearCache: () => {},
}));

mock.module('../config/loader.js', () => ({
  getConfig: () => ({
    provider: 'mock-provider',
    timeouts: { permissionTimeoutSec: 5 },
    permissions: { mode: 'legacy' },
    skills: { load: { extraDirs: [] } },
  }),
}));

mock.module('../util/logger.js', () => ({
  getLogger: () => new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

mock.module('../security/redaction.js', () => ({
  redactSensitiveFields: (input: Record<string, unknown>) => input,
}));

// ---------------------------------------------------------------------------
// Import after mocks are registered.
// ---------------------------------------------------------------------------

import { createProxyApprovalCallback } from '../daemon/session-tool-setup.js';
import type { ToolSetupContext } from '../daemon/session-tool-setup.js';
import { PermissionPrompter } from '../permissions/prompter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(overrides?: Partial<ToolSetupContext>): ToolSetupContext {
  return {
    conversationId: 'conv-test',
    workingDir: '/tmp/test-project',
    abortController: null,
    memoryPolicy: { scopeId: 'default', strictSideEffects: false },
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
      kind: 'ask_missing_credential',
      target: { hostname: 'api.fal.ai', port: 443, path: '/v1/run' },
      matchingPatterns: ['*.fal.ai'],
    },
    sessionId: 'session-1',
    ...overrides,
  };
}

function makeAskUnauthenticatedRequest(
  overrides?: Partial<ProxyApprovalRequest>,
): ProxyApprovalRequest {
  return {
    decision: {
      kind: 'ask_unauthenticated',
      target: { hostname: 'example.com', port: null, path: '/data' },
    },
    sessionId: 'session-2',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createProxyApprovalCallback', () => {
  beforeEach(() => {
    addRuleMock.mockClear();
    findHighestPriorityRuleMock.mockClear();
    findHighestPriorityRuleMock.mockReturnValue(null);
  });

  test('returns true when user allows an ask_missing_credential request', async () => {
    const ctx = makeContext();

    let resolvePrompt: ((v: { decision: string; selectedPattern?: string; selectedScope?: string }) => void) | null = null;
    const prompterSendToClient = mock(() => {});
    const prompter = new PermissionPrompter(prompterSendToClient);

    // Intercept the prompter's prompt method to control the response
    const originalPrompt = prompter.prompt.bind(prompter);
    prompter.prompt = async (...args) => {
      const p = originalPrompt(...args);
      // Find the pending request and resolve it
      await new Promise((r) => setTimeout(r, 10));
      const call = prompterSendToClient.mock.calls[0];
      const msg = call[0] as { requestId: string };
      prompter.resolveConfirmation(msg.requestId, 'allow');
      return p;
    };

    const callback = createProxyApprovalCallback(prompter, ctx);
    const result = await callback(makeAskMissingCredentialRequest());

    expect(result).toBe(true);
  });

  test('returns false when user denies an ask_unauthenticated request', async () => {
    const ctx = makeContext();

    const prompterSendToClient = mock(() => {});
    const prompter = new PermissionPrompter(prompterSendToClient);

    const originalPrompt = prompter.prompt.bind(prompter);
    prompter.prompt = async (...args) => {
      const p = originalPrompt(...args);
      await new Promise((r) => setTimeout(r, 10));
      const call = prompterSendToClient.mock.calls[0];
      const msg = call[0] as { requestId: string };
      prompter.resolveConfirmation(msg.requestId, 'deny');
      return p;
    };

    const callback = createProxyApprovalCallback(prompter, ctx);
    const result = await callback(makeAskUnauthenticatedRequest());

    expect(result).toBe(false);
  });

  test('skips prompting and returns true when trust store has an allow rule', async () => {
    findHighestPriorityRuleMock.mockReturnValue({
      id: 'rule-1',
      tool: 'proxy:missing_credential',
      pattern: 'proxy:api.fal.ai',
      scope: '/tmp/test-project',
      decision: 'allow' as const,
      priority: 100,
      createdAt: Date.now(),
    });

    const ctx = makeContext();
    const prompterSendToClient = mock(() => {});
    const prompter = new PermissionPrompter(prompterSendToClient);

    const callback = createProxyApprovalCallback(prompter, ctx);
    const result = await callback(makeAskMissingCredentialRequest());

    expect(result).toBe(true);
    // Prompter should not have been called
    expect(prompterSendToClient).not.toHaveBeenCalled();
  });

  test('skips prompting and returns false when trust store has a deny rule', async () => {
    findHighestPriorityRuleMock.mockReturnValue({
      id: 'rule-2',
      tool: 'proxy:unauthenticated',
      pattern: 'proxy:example.com',
      scope: '/tmp/test-project',
      decision: 'deny' as const,
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

  test('prompts when trust store has an ask rule', async () => {
    findHighestPriorityRuleMock.mockReturnValue({
      id: 'rule-3',
      tool: 'proxy:unauthenticated',
      pattern: 'proxy:example.com',
      scope: '/tmp/test-project',
      decision: 'ask' as const,
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
      const call = prompterSendToClient.mock.calls[0];
      const msg = call[0] as { requestId: string };
      prompter.resolveConfirmation(msg.requestId, 'allow');
      return p;
    };

    const callback = createProxyApprovalCallback(prompter, ctx);
    const result = await callback(makeAskUnauthenticatedRequest());

    expect(result).toBe(true);
    // Prompter should have been called (ask rule forces prompt)
    expect(prompterSendToClient).toHaveBeenCalled();
  });

  test('persists allow rule when user chooses always_allow', async () => {
    const ctx = makeContext();
    const prompterSendToClient = mock(() => {});
    const prompter = new PermissionPrompter(prompterSendToClient);

    const originalPrompt = prompter.prompt.bind(prompter);
    prompter.prompt = async (...args) => {
      const p = originalPrompt(...args);
      await new Promise((r) => setTimeout(r, 10));
      const call = prompterSendToClient.mock.calls[0];
      const msg = call[0] as { requestId: string };
      prompter.resolveConfirmation(msg.requestId, 'always_allow', 'proxy:api.fal.ai', '/tmp/test-project');
      return p;
    };

    const callback = createProxyApprovalCallback(prompter, ctx);
    const result = await callback(makeAskMissingCredentialRequest());

    expect(result).toBe(true);
    expect(addRuleMock).toHaveBeenCalledWith(
      'proxy:missing_credential',
      'proxy:api.fal.ai',
      '/tmp/test-project',
      'allow',
      100,
      undefined,
    );
  });

  test('persists deny rule when user chooses always_deny', async () => {
    const ctx = makeContext();
    const prompterSendToClient = mock(() => {});
    const prompter = new PermissionPrompter(prompterSendToClient);

    const originalPrompt = prompter.prompt.bind(prompter);
    prompter.prompt = async (...args) => {
      const p = originalPrompt(...args);
      await new Promise((r) => setTimeout(r, 10));
      const call = prompterSendToClient.mock.calls[0];
      const msg = call[0] as { requestId: string };
      prompter.resolveConfirmation(msg.requestId, 'always_deny', 'proxy:example.com', 'everywhere');
      return p;
    };

    const callback = createProxyApprovalCallback(prompter, ctx);
    const result = await callback(makeAskUnauthenticatedRequest());

    expect(result).toBe(false);
    expect(addRuleMock).toHaveBeenCalledWith(
      'proxy:unauthenticated',
      'proxy:example.com',
      'everywhere',
      'deny',
    );
  });

  test('sends correct tool name for ask_missing_credential decisions', async () => {
    const ctx = makeContext();
    const prompterSendToClient = mock(() => {});
    const prompter = new PermissionPrompter(prompterSendToClient);

    const originalPrompt = prompter.prompt.bind(prompter);
    prompter.prompt = async (...args) => {
      const p = originalPrompt(...args);
      await new Promise((r) => setTimeout(r, 10));
      const call = prompterSendToClient.mock.calls[0];
      const msg = call[0] as { requestId: string; toolName: string; input: Record<string, unknown> };
      // Verify the confirmation request has the right tool name
      expect(msg.toolName).toBe('proxy:missing_credential');
      expect(msg.input).toHaveProperty('hostname', 'api.fal.ai');
      expect(msg.input).toHaveProperty('matching_patterns', ['*.fal.ai']);
      prompter.resolveConfirmation(msg.requestId, 'allow');
      return p;
    };

    const callback = createProxyApprovalCallback(prompter, ctx);
    await callback(makeAskMissingCredentialRequest());
  });

  test('sends correct tool name for ask_unauthenticated decisions', async () => {
    const ctx = makeContext();
    const prompterSendToClient = mock(() => {});
    const prompter = new PermissionPrompter(prompterSendToClient);

    const originalPrompt = prompter.prompt.bind(prompter);
    prompter.prompt = async (...args) => {
      const p = originalPrompt(...args);
      await new Promise((r) => setTimeout(r, 10));
      const call = prompterSendToClient.mock.calls[0];
      const msg = call[0] as { requestId: string; toolName: string; input: Record<string, unknown>; riskLevel: string };
      expect(msg.toolName).toBe('proxy:unauthenticated');
      expect(msg.input).toHaveProperty('hostname', 'example.com');
      expect(msg.riskLevel).toBe('medium');
      prompter.resolveConfirmation(msg.requestId, 'deny');
      return p;
    };

    const callback = createProxyApprovalCallback(prompter, ctx);
    await callback(makeAskUnauthenticatedRequest());
  });

  test('uses high risk level for ask_missing_credential decisions', async () => {
    const ctx = makeContext();
    const prompterSendToClient = mock(() => {});
    const prompter = new PermissionPrompter(prompterSendToClient);

    const originalPrompt = prompter.prompt.bind(prompter);
    prompter.prompt = async (...args) => {
      const p = originalPrompt(...args);
      await new Promise((r) => setTimeout(r, 10));
      const call = prompterSendToClient.mock.calls[0];
      const msg = call[0] as { requestId: string; riskLevel: string };
      // Missing credential prompts are high risk — the target wants auth
      expect(msg.riskLevel).toBe('high');
      prompter.resolveConfirmation(msg.requestId, 'allow');
      return p;
    };

    const callback = createProxyApprovalCallback(prompter, ctx);
    await callback(makeAskMissingCredentialRequest());
  });

  test('includes port in allowlist option label when port is present', async () => {
    const ctx = makeContext();
    const prompterSendToClient = mock(() => {});
    const prompter = new PermissionPrompter(prompterSendToClient);

    const originalPrompt = prompter.prompt.bind(prompter);
    prompter.prompt = async (...args) => {
      const p = originalPrompt(...args);
      await new Promise((r) => setTimeout(r, 10));
      const call = prompterSendToClient.mock.calls[0];
      const msg = call[0] as { requestId: string; allowlistOptions: Array<{ label: string }> };
      // First option should include the port
      expect(msg.allowlistOptions[0].label).toBe('proxy:api.fal.ai:443');
      prompter.resolveConfirmation(msg.requestId, 'allow');
      return p;
    };

    const callback = createProxyApprovalCallback(prompter, ctx);
    await callback(makeAskMissingCredentialRequest());
  });

  test('omits port from allowlist option label when port is null', async () => {
    const ctx = makeContext();
    const prompterSendToClient = mock(() => {});
    const prompter = new PermissionPrompter(prompterSendToClient);

    const originalPrompt = prompter.prompt.bind(prompter);
    prompter.prompt = async (...args) => {
      const p = originalPrompt(...args);
      await new Promise((r) => setTimeout(r, 10));
      const call = prompterSendToClient.mock.calls[0];
      const msg = call[0] as { requestId: string; allowlistOptions: Array<{ label: string }> };
      // Port is null — label should not include ":null"
      expect(msg.allowlistOptions[0].label).toBe('proxy:example.com');
      prompter.resolveConfirmation(msg.requestId, 'deny');
      return p;
    };

    const callback = createProxyApprovalCallback(prompter, ctx);
    await callback(makeAskUnauthenticatedRequest());
  });

  // ── E2E persistence invariants (PR 32) ──────────────────────────────
  // These tests verify the proxy approval path CAN save persistent rules,
  // in contrast to the proxied bash activation path which CANNOT (tested
  // in tool-executor.test.ts).

  test('always_allow_high_risk persists rule with allowHighRisk flag', async () => {
    const ctx = makeContext();
    const prompterSendToClient = mock(() => {});
    const prompter = new PermissionPrompter(prompterSendToClient);

    const originalPrompt = prompter.prompt.bind(prompter);
    prompter.prompt = async (...args) => {
      const p = originalPrompt(...args);
      await new Promise((r) => setTimeout(r, 10));
      const call = prompterSendToClient.mock.calls[0];
      const msg = call[0] as { requestId: string };
      prompter.resolveConfirmation(msg.requestId, 'always_allow_high_risk', 'proxy:api.fal.ai', '/tmp/test-project');
      return p;
    };

    const callback = createProxyApprovalCallback(prompter, ctx);
    const result = await callback(makeAskMissingCredentialRequest());

    expect(result).toBe(true);
    expect(addRuleMock).toHaveBeenCalledWith(
      'proxy:missing_credential',
      'proxy:api.fal.ai',
      '/tmp/test-project',
      'allow',
      100,
      { allowHighRisk: true },
    );
  });

  test('one-time allow does NOT persist any rule', async () => {
    const ctx = makeContext();
    const prompterSendToClient = mock(() => {});
    const prompter = new PermissionPrompter(prompterSendToClient);

    const originalPrompt = prompter.prompt.bind(prompter);
    prompter.prompt = async (...args) => {
      const p = originalPrompt(...args);
      await new Promise((r) => setTimeout(r, 10));
      const call = prompterSendToClient.mock.calls[0];
      const msg = call[0] as { requestId: string };
      prompter.resolveConfirmation(msg.requestId, 'allow');
      return p;
    };

    const callback = createProxyApprovalCallback(prompter, ctx);
    const result = await callback(makeAskMissingCredentialRequest());

    expect(result).toBe(true);
    // One-time allow should NOT save any persistent rule
    expect(addRuleMock).not.toHaveBeenCalled();
  });

  test('one-time deny does NOT persist any rule', async () => {
    const ctx = makeContext();
    const prompterSendToClient = mock(() => {});
    const prompter = new PermissionPrompter(prompterSendToClient);

    const originalPrompt = prompter.prompt.bind(prompter);
    prompter.prompt = async (...args) => {
      const p = originalPrompt(...args);
      await new Promise((r) => setTimeout(r, 10));
      const call = prompterSendToClient.mock.calls[0];
      const msg = call[0] as { requestId: string };
      prompter.resolveConfirmation(msg.requestId, 'deny');
      return p;
    };

    const callback = createProxyApprovalCallback(prompter, ctx);
    const result = await callback(makeAskUnauthenticatedRequest());

    expect(result).toBe(false);
    expect(addRuleMock).not.toHaveBeenCalled();
  });

  test('always_allow without selectedPattern does not persist a rule', async () => {
    const ctx = makeContext();
    const prompterSendToClient = mock(() => {});
    const prompter = new PermissionPrompter(prompterSendToClient);

    const originalPrompt = prompter.prompt.bind(prompter);
    prompter.prompt = async (...args) => {
      const p = originalPrompt(...args);
      await new Promise((r) => setTimeout(r, 10));
      const call = prompterSendToClient.mock.calls[0];
      const msg = call[0] as { requestId: string };
      // Resolve with always_allow but NO pattern/scope
      prompter.resolveConfirmation(msg.requestId, 'always_allow');
      return p;
    };

    const callback = createProxyApprovalCallback(prompter, ctx);
    const result = await callback(makeAskMissingCredentialRequest());

    expect(result).toBe(true);
    // No pattern/scope -> cannot save a rule
    expect(addRuleMock).not.toHaveBeenCalled();
  });
});
