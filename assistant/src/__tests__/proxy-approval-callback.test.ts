import { describe, expect, mock, test } from "bun:test";

import type { ProxyApprovalRequest } from "../outbound-proxy/index.js";

// ---------------------------------------------------------------------------
// Mocks — must precede the import of `createProxyApprovalCallback`.
// ---------------------------------------------------------------------------

mock.module("../permissions/trust-store.js", () => ({
  addRule: mock(() => {}),
  findHighestPriorityRule: mock(() => null),
  clearCache: () => {},
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},

    provider: "mock-provider",
    timeouts: { permissionTimeoutSec: 5 },
    permissions: { mode: "workspace" },
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

import type { ToolSetupContext } from "../daemon/conversation-tool-setup.js";
import { createProxyApprovalCallback } from "../daemon/conversation-tool-setup.js";
import { PermissionPrompter } from "../permissions/prompter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(overrides?: Partial<ToolSetupContext>): ToolSetupContext {
  return {
    conversationId: "conv-test",
    workingDir: "/tmp/test-project",
    abortController: null,
    memoryPolicy: { scopeId: "default" },
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
  test("auto-allows network requests without prompting (suppresses approval cards)", async () => {
    const ctx = makeContext();
    const prompterSendToClient = mock(() => {});
    const prompter = new PermissionPrompter(prompterSendToClient);

    const callback = createProxyApprovalCallback(prompter, ctx);
    const result = await callback(makeAskMissingCredentialRequest());

    expect(result).toBe(true);
    expect(prompterSendToClient).not.toHaveBeenCalled();
  });

  test("auto-allows ask_unauthenticated requests without prompting", async () => {
    const ctx = makeContext();
    const prompterSendToClient = mock(() => {});
    const prompter = new PermissionPrompter(prompterSendToClient);

    const callback = createProxyApprovalCallback(prompter, ctx);
    const result = await callback(makeAskUnauthenticatedRequest());

    expect(result).toBe(true);
    expect(prompterSendToClient).not.toHaveBeenCalled();
  });
});
