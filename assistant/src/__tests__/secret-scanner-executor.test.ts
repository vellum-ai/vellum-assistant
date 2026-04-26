import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  ToolExecutionResult,
  ToolLifecycleEvent,
  ToolLifecycleEventHandler,
} from "../tools/types.js";

// ---------------------------------------------------------------------------
// Mocks — MUST be declared before importing executor
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
  rateLimit: { maxRequestsPerMinute: 0 },
  secretDetection: {
    enabled: true,
    action: "warn" as "redact" | "warn" | "block",
    entropyThreshold: 4.0,
  },
};

let fakeToolResult: ToolExecutionResult = { content: "ok", isError: false };
const recordedInvocations: unknown[] = [];

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
}));

mock.module("../permissions/checker.js", () => ({
  classifyRisk: () => ({ level: "low" }),
  check: () => ({ decision: "allow" }),
  generateAllowlistOptions: () => [],
  generateScopeOptions: () => [],
}));

// Mock every export so downstream test files that dynamically import modules
// with a static `from "../memory/tool-usage-store.js"` still see all symbols.
mock.module("../memory/tool-usage-store.js", () => ({
  recordToolInvocation: (inv: unknown) => {
    recordedInvocations.push(inv);
  },
  getRecentInvocations: () => [],
  rotateToolInvocations: () => 0,
}));

mock.module("../tools/registry.js", () => ({
  getTool: (name: string) => {
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
}));

mock.module("../tools/shared/filesystem/path-policy.js", () => ({
  sandboxPolicy: () => ({ ok: false }),
  hostPolicy: () => ({ ok: false }),
}));
mock.module("../tools/terminal/sandbox.js", () => ({
  wrapCommand: () => ({ command: "", sandboxed: false }),
}));
// NOTE: fuzzy-match.js and trust-store.js are intentionally NOT mocked here.
// fuzzy-match.js is a pure-function module (no side effects) that doesn't
// need mocking, and mocking it would leak stubs into fuzzy-match.test.ts.
// trust-store.js is not exercised here (the mock checker always returns 'allow').
// Mocking either here would break their respective test files via Bun's
// process-global mock.module.

// Now import the module under test — mocks are already in place
import { createToolAuditListener } from "../events/tool-audit-listener.js";
import { PermissionPrompter } from "../permissions/prompter.js";
import { ToolExecutor } from "../tools/executor.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(
  overrides?: Partial<{
    onToolLifecycleEvent: ToolLifecycleEventHandler;
  }>,
) {
  const auditListener = createToolAuditListener();
  return {
    workingDir: "/tmp",
    conversationId: "test-conversation",
    trustClass: "guardian" as const,
    onToolLifecycleEvent: (event: ToolLifecycleEvent) => {
      auditListener(event);
      return overrides?.onToolLifecycleEvent?.(event);
    },
  };
}

function getSecretEvents(events: ToolLifecycleEvent[]) {
  return events.filter(
    (
      event,
    ): event is Extract<ToolLifecycleEvent, { type: "secret_detected" }> =>
      event.type === "secret_detected",
  );
}

function makeMockPrompter() {
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

describe("Secret scanner executor integration", () => {
  let executor: ToolExecutor;

  beforeEach(() => {
    executor = new ToolExecutor(makeMockPrompter());
    recordedInvocations.length = 0;
    mockConfig.secretDetection = {
      enabled: true,
      action: "warn",
      entropyThreshold: 4.0,
    };
  });

  // -----------------------------------------------------------------------
  // warn mode
  // -----------------------------------------------------------------------
  test("warn mode: passes through content unchanged and emits secret_detected lifecycle event", async () => {
    mockConfig.secretDetection.action = "warn";
    const secret = "AKIAIOSFODNN7REALKEY"; // 20-char AWS key
    fakeToolResult = { content: `Found key: ${secret}`, isError: false };

    const lifecycleEvents: ToolLifecycleEvent[] = [];
    const ctx = makeContext({
      onToolLifecycleEvent: (event) => {
        lifecycleEvents.push(event);
      },
    });

    const result = await executor.execute("file_read", {}, ctx);

    // Content should be unchanged in warn mode
    expect(result.content).toContain(secret);
    expect(result.isError).toBe(false);

    const secretEvents = getSecretEvents(lifecycleEvents);
    expect(secretEvents).toHaveLength(1);
    expect(secretEvents[0].toolName).toBe("file_read");
    expect(secretEvents[0].action).toBe("warn");
    expect(secretEvents[0].matches.length).toBeGreaterThan(0);
    expect(secretEvents[0].matches[0].type).toBe("AWS Access Key");
  });

  // -----------------------------------------------------------------------
  // redact mode
  // -----------------------------------------------------------------------
  test("redact mode: replaces secrets with <redacted> markers", async () => {
    mockConfig.secretDetection.action = "redact";
    const secret = "AKIAIOSFODNN7REALKEY";
    fakeToolResult = { content: `Found key: ${secret}`, isError: false };

    const lifecycleEvents: ToolLifecycleEvent[] = [];
    const ctx = makeContext({
      onToolLifecycleEvent: (event) => {
        lifecycleEvents.push(event);
      },
    });

    const result = await executor.execute("file_read", {}, ctx);

    expect(result.content).not.toContain(secret);
    expect(result.content).toContain('<redacted type="AWS Access Key" />');
    expect(result.isError).toBe(false);
    expect(getSecretEvents(lifecycleEvents)).toHaveLength(1);
  });

  // -----------------------------------------------------------------------
  // block mode
  // -----------------------------------------------------------------------
  test("block mode: returns error and does not pass through content", async () => {
    mockConfig.secretDetection.action = "block";
    const secret = "AKIAIOSFODNN7REALKEY";
    fakeToolResult = { content: `Found key: ${secret}`, isError: false };

    const lifecycleEvents: ToolLifecycleEvent[] = [];
    const ctx = makeContext({
      onToolLifecycleEvent: (event) => {
        lifecycleEvents.push(event);
      },
    });

    const result = await executor.execute("file_read", {}, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("blocked");
    expect(result.content).toContain("AWS Access Key");
    // Lifecycle notification should still fire so session listeners can notify the user
    expect(getSecretEvents(lifecycleEvents)).toHaveLength(1);
    // Invocation should be recorded for audit trail
    expect(recordedInvocations).toHaveLength(1);
    const inv = recordedInvocations[0] as Record<string, unknown>;
    expect(inv.toolName).toBe("file_read");
    expect(inv.conversationId).toBe("test-conversation");
    expect(inv.result as string).toContain("blocked");
  });

  // -----------------------------------------------------------------------
  // disabled
  // -----------------------------------------------------------------------
  test("disabled: does not scan or emit secret_detected event", async () => {
    mockConfig.secretDetection.enabled = false;
    fakeToolResult = {
      content: "Found key: AKIAIOSFODNN7REALKEY",
      isError: false,
    };

    const lifecycleEvents: ToolLifecycleEvent[] = [];
    const ctx = makeContext({
      onToolLifecycleEvent: (event) => {
        lifecycleEvents.push(event);
      },
    });

    const result = await executor.execute("file_read", {}, ctx);

    expect(result.content).toContain("AKIAIOSFODNN7REALKEY");
    expect(getSecretEvents(lifecycleEvents)).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // error results are not scanned
  // -----------------------------------------------------------------------
  test("does not scan error results", async () => {
    mockConfig.secretDetection.action = "redact";
    fakeToolResult = { content: "Error: AKIAIOSFODNN7REALKEY", isError: true };

    const lifecycleEvents: ToolLifecycleEvent[] = [];
    const ctx = makeContext({
      onToolLifecycleEvent: (event) => {
        lifecycleEvents.push(event);
      },
    });

    const result = await executor.execute("file_read", {}, ctx);

    // Error results should pass through without scanning
    expect(result.content).toContain("AKIAIOSFODNN7REALKEY");
    expect(getSecretEvents(lifecycleEvents)).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // diff content is scanned
  // -----------------------------------------------------------------------
  test("redact mode: scans and redacts diff content", async () => {
    mockConfig.secretDetection.action = "redact";
    const secret = "AKIAIOSFODNN7REALKEY";
    fakeToolResult = {
      content: "File written",
      isError: false,
      diff: {
        filePath: "/tmp/test.txt",
        oldContent: "",
        newContent: `API_KEY=${secret}`,
        isNewFile: true,
      },
    };

    const lifecycleEvents: ToolLifecycleEvent[] = [];
    const ctx = makeContext({
      onToolLifecycleEvent: (event) => {
        lifecycleEvents.push(event);
      },
    });

    const result = await executor.execute("file_write", {}, ctx);

    expect(result.diff).toBeDefined();
    expect(result.diff!.newContent).not.toContain(secret);
    expect(result.diff!.newContent).toContain(
      '<redacted type="AWS Access Key" />',
    );
    expect(getSecretEvents(lifecycleEvents)).toHaveLength(1);
  });

  // -----------------------------------------------------------------------
  // no secrets: no secret-detected event emitted
  // -----------------------------------------------------------------------
  test("no secrets: does not emit secret_detected event", async () => {
    fakeToolResult = { content: "Hello, world!", isError: false };

    const lifecycleEvents: ToolLifecycleEvent[] = [];
    const ctx = makeContext({
      onToolLifecycleEvent: (event) => {
        lifecycleEvents.push(event);
      },
    });

    const result = await executor.execute("file_read", {}, ctx);

    expect(result.content).toBe("Hello, world!");
    expect(getSecretEvents(lifecycleEvents)).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // no lifecycle handler: does not throw
  // -----------------------------------------------------------------------
  test("works without onToolLifecycleEvent handler", async () => {
    mockConfig.secretDetection.action = "warn";
    fakeToolResult = {
      content: "Found key: AKIAIOSFODNN7REALKEY",
      isError: false,
    };

    const ctx = {
      workingDir: "/tmp",
      conversationId: "test-conversation",
      trustClass: "guardian" as const,
    };

    const result = await executor.execute("file_read", {}, ctx);

    // Should not throw, content unchanged in warn mode
    expect(result.content).toContain("AKIAIOSFODNN7REALKEY");
  });

  // -----------------------------------------------------------------------
  // multiple secrets
  // -----------------------------------------------------------------------
  test("detects multiple secrets in one output", async () => {
    mockConfig.secretDetection.action = "warn";
    const aws = "AKIAIOSFODNN7REALKEY";
    const ghToken = "ghp_ABCDEFghijklMN0123456789abcdefghijkl";
    fakeToolResult = {
      content: `AWS: ${aws}\nGitHub: ${ghToken}`,
      isError: false,
    };

    const lifecycleEvents: ToolLifecycleEvent[] = [];
    const ctx = makeContext({
      onToolLifecycleEvent: (event) => {
        lifecycleEvents.push(event);
      },
    });

    await executor.execute("file_read", {}, ctx);

    const secretEvents = getSecretEvents(lifecycleEvents);
    expect(secretEvents).toHaveLength(1);
    expect(secretEvents[0].matches.length).toBe(2);
    const types = secretEvents[0].matches.map((m) => m.type);
    expect(types).toContain("AWS Access Key");
    expect(types).toContain("GitHub Token");
  });

  // -----------------------------------------------------------------------
  // sensitive output directive extraction runs before secret detection
  // -----------------------------------------------------------------------
  test("sensitive output directives are stripped and replaced with placeholders before secret scanning", async () => {
    mockConfig.secretDetection.action = "redact";
    const rawToken = "xK9mP2vL4nR7wQ3j";
    fakeToolResult = {
      content: `<vellum-sensitive-output kind="invite_code" value="${rawToken}" />\nhttps://t.me/bot?start=iv_${rawToken}`,
      isError: false,
    };

    const lifecycleEvents: ToolLifecycleEvent[] = [];
    const ctx = makeContext({
      onToolLifecycleEvent: (event) => {
        lifecycleEvents.push(event);
      },
    });

    const result = await executor.execute("bash", {}, ctx);

    // The raw token should NOT appear in the result content
    expect(result.content).not.toContain(rawToken);
    // The directive tag should be fully stripped
    expect(result.content).not.toContain("<vellum-sensitive-output");
    // A placeholder should be present instead
    expect(result.content).toMatch(/VELLUM_ASSISTANT_INVITE_CODE_[A-Z0-9]{8}/);
    // Sensitive bindings should be attached for downstream substitution
    expect(result.sensitiveBindings).toBeDefined();
    expect(result.sensitiveBindings).toHaveLength(1);
    expect(result.sensitiveBindings![0].value).toBe(rawToken);
    expect(result.sensitiveBindings![0].kind).toBe("invite_code");
  });

  test("sensitive output bindings are NOT present in lifecycle event result", async () => {
    mockConfig.secretDetection.action = "warn";
    const rawToken = "testToken999";
    fakeToolResult = {
      content: `<vellum-sensitive-output kind="invite_code" value="${rawToken}" />\nhttps://t.me/bot?start=iv_${rawToken}`,
      isError: false,
    };

    const lifecycleEvents: ToolLifecycleEvent[] = [];
    const ctx = makeContext({
      onToolLifecycleEvent: (event) => {
        lifecycleEvents.push(event);
      },
    });

    await executor.execute("bash", {}, ctx);

    // Find the 'executed' lifecycle event
    const executedEvents = lifecycleEvents.filter(
      (e): e is Extract<ToolLifecycleEvent, { type: "executed" }> =>
        e.type === "executed",
    );
    expect(executedEvents).toHaveLength(1);
    // The emitted result must NOT contain sensitiveBindings
    expect(
      (executedEvents[0].result as unknown as Record<string, unknown>)
        .sensitiveBindings,
    ).toBeUndefined();
  });
});
