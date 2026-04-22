/**
 * Integration tests: ToolExecutor → real checker.js → real shell-identity → real tree-sitter parser.
 *
 * Unlike tool-executor.test.ts, this file does NOT mock ../permissions/checker.js,
 * so generateAllowlistOptions and generateScopeOptions run through the actual
 * implementation (buildShellAllowlistOptions → analyzeShellCommand → tree-sitter
 * WASM parser). This validates the full e2e chain from executor to parser-derived
 * allowlist options.
 */
import { beforeAll, describe, expect, mock, test } from "bun:test";

import { PermissionPrompter } from "../permissions/prompter.js";
import type { AllowlistOption, ScopeOption } from "../permissions/types.js";
import type { ToolContext } from "../tools/types.js";

// ── Config mock ──────────────────────────────────────────────────────
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
    action: "warn" as const,
    entropyThreshold: 4.0,
  },
  permissions: { mode: "strict" as const },
  skills: {
    entries: {},
    load: { extraDirs: [], watch: false, watchDebounceMs: 250 },
    install: { nodeManager: "npm" },
    allowBundled: null,
  },
};

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

// ── Logger mock (must accept name argument — checker.ts calls getLogger('checker')) ──
mock.module("../util/logger.js", () => ({
  getLogger: (_name?: string) =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
  truncateForLog: (value: string) => value,
}));

// ── Tool registry mock — returns medium-risk tools so check() returns prompt ──
mock.module("../tools/registry.js", () => ({
  getTool: (name: string) => ({
    name,
    description: "test tool",
    category: "test",
    defaultRiskLevel: "medium",
    getDefinition: () => ({}),
    execute: async () => ({ content: "ok", isError: false }),
  }),
  getAllTools: () => [],
}));

// ── Trust store — no matching rules so check() returns prompt for medium-risk ──
mock.module("../permissions/trust-store.js", () => ({
  findHighestPriorityRule: () => null,
  addRule: () => ({ id: "test-rule" }),
  getRules: () => [],
  removeRule: () => {},
}));

// ── Tool usage store ──
// Mock every export so downstream test files that dynamically import modules
// with a static `from "../memory/tool-usage-store.js"` still see all symbols.
mock.module("../memory/tool-usage-store.js", () => ({
  recordToolInvocation: () => {},
  getRecentInvocations: () => [],
  rotateToolInvocations: () => 0,
}));

// ── Path policy ──
mock.module("../tools/shared/filesystem/path-policy.js", () => ({
  sandboxPolicy: () => ({ ok: false }),
  hostPolicy: () => ({ ok: false }),
}));

// ── Sandbox ──
mock.module("../tools/terminal/sandbox.js", () => ({
  wrapCommand: () => ({ command: "", sandboxed: false }),
}));

// ── Ephemeral permissions ──
mock.module("../tasks/ephemeral-permissions.js", () => ({
  getTaskRunRules: () => [],
}));

// ── Secret scanner ──
mock.module("../security/secret-scanner.js", () => ({
  scanText: () => [],
  redactSecrets: (text: string) => text,
}));

// ── Redaction ──
mock.module("../security/redaction.js", () => ({
  redactSensitiveFields: (input: Record<string, unknown>) => input,
}));

// ── Token manager ──
mock.module("../security/token-manager.js", () => ({
  TokenExpiredError: class TokenExpiredError extends Error {},
}));

// IMPORTANT: Do NOT mock ../permissions/checker.js — that's the whole point.
// Also do NOT mock ../permissions/shell-identity.js or ../tools/terminal/parser.js.

// ── Import executor AFTER mocks are set up ──
import { ToolExecutor } from "../tools/executor.js";
import { parse } from "../tools/terminal/parser.js";

function makeContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    workingDir: "/tmp/project",
    conversationId: "conversation-integration",
    trustClass: "guardian",
    ...overrides,
  };
}

/**
 * Capturing prompter that intercepts the allowlist and scope options
 * passed to the prompter by the executor, then allows the tool.
 */
function makeCapturingPrompter() {
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

  return {
    prompter,
    getAllowlist: () => capturedAllowlist,
    getScopes: () => capturedScopes,
  };
}

// ── Warm up WASM parser before tests ─────────────────────────────────
beforeAll(async () => {
  await parse("echo warmup");
});

describe("ToolExecutor → real shell allowlist integration", () => {
  test("simple command produces parser-derived action keys", async () => {
    const { prompter, getAllowlist, getScopes } = makeCapturingPrompter();
    const executor = new ToolExecutor(prompter);

    await executor.execute(
      "bash",
      { command: "npm install express" },
      makeContext(),
    );

    const allowlist = getAllowlist();
    expect(allowlist).toBeDefined();
    expect(allowlist!.length).toBeGreaterThan(1);

    const patterns = allowlist!.map((o: AllowlistOption) => o.pattern);

    // Should contain the exact command
    expect(patterns).toContain("npm install express");

    // Should contain action keys derived by the parser
    expect(patterns).toContain("action:npm install");
    expect(patterns).toContain("action:npm");

    // Every option should have label, description, and pattern
    for (const opt of allowlist!) {
      expect(opt).toHaveProperty("label");
      expect(opt).toHaveProperty("description");
      expect(opt).toHaveProperty("pattern");
    }

    // Verify scope options are also real (not the canned mock)
    const scopes = getScopes();
    expect(scopes).toBeDefined();
    expect(scopes!.length).toBeGreaterThanOrEqual(2);
    expect(scopes!.some((s: ScopeOption) => s.scope === "/tmp/project")).toBe(
      true,
    );
    expect(scopes!.some((s: ScopeOption) => s.scope === "everywhere")).toBe(
      true,
    );
  });

  test("compound command produces only exact compound option (no action keys)", async () => {
    const { prompter, getAllowlist } = makeCapturingPrompter();
    const executor = new ToolExecutor(prompter);

    await executor.execute(
      "bash",
      { command: 'git add . && git commit -m "fix"' },
      makeContext(),
    );

    const allowlist = getAllowlist();
    expect(allowlist).toBeDefined();

    // Compound commands with two non-setup actions get only the exact compound option
    expect(allowlist!.length).toBe(1);
    expect(allowlist![0].pattern).toBe('git add . && git commit -m "fix"');
    expect(allowlist![0].description).toContain("compound");
  });

  test("setup prefix + action produces canonical primary command and action keys", async () => {
    const { prompter, getAllowlist } = makeCapturingPrompter();
    const executor = new ToolExecutor(prompter);

    await executor.execute(
      "bash",
      { command: "cd /repo && gh pr view 123" },
      makeContext(),
    );

    const allowlist = getAllowlist();
    expect(allowlist).toBeDefined();
    expect(allowlist!.length).toBeGreaterThan(1);

    const patterns = allowlist!.map((o: AllowlistOption) => o.pattern);

    // Should contain the full original command as the exact option
    expect(patterns).toContain("cd /repo && gh pr view 123");

    // Should contain action keys: cd is a setup prefix, so gh is the primary action
    expect(patterns).toContain("action:gh pr view");
    expect(patterns).toContain("action:gh pr");
    expect(patterns).toContain("action:gh");

    // Should NOT contain action keys for the setup prefix (cd)
    expect(patterns).not.toContain("action:cd");
  });

  test("scope options include project directory and everywhere", async () => {
    const { prompter, getScopes } = makeCapturingPrompter();
    const executor = new ToolExecutor(prompter);

    await executor.execute(
      "bash",
      { command: "echo hello" },
      makeContext({ workingDir: "/Users/test/my-project" }),
    );

    const scopes = getScopes();
    expect(scopes).toBeDefined();
    expect(scopes!.length).toBeGreaterThanOrEqual(2);

    const scopeValues = scopes!.map((s: ScopeOption) => s.scope);

    // Project-scoped option
    expect(scopeValues).toContain("/Users/test/my-project");
    // Parent directory option
    expect(scopeValues).toContain("/Users/test");
    // Global everywhere option
    expect(scopeValues).toContain("everywhere");

    // Every option has a label and scope
    for (const opt of scopes!) {
      expect(opt).toHaveProperty("label");
      expect(opt).toHaveProperty("scope");
    }
  });

  test("host_bash command also produces real parser-derived options", async () => {
    const { prompter, getAllowlist } = makeCapturingPrompter();
    const executor = new ToolExecutor(prompter);

    await executor.execute(
      "host_bash",
      { command: "git status" },
      makeContext(),
    );

    const allowlist = getAllowlist();
    expect(allowlist).toBeDefined();
    expect(allowlist!.length).toBeGreaterThan(1);

    const patterns = allowlist!.map((o: AllowlistOption) => o.pattern);

    // Should contain exact command and action keys
    expect(patterns).toContain("git status");
    expect(patterns).toContain("action:git status");
    expect(patterns).toContain("action:git");
  });

  test("pipeline command produces exact + action-key options", async () => {
    const { prompter, getAllowlist } = makeCapturingPrompter();
    const executor = new ToolExecutor(prompter);

    await executor.execute(
      "bash",
      { command: "cat file.txt | grep error" },
      makeContext(),
    );

    const allowlist = getAllowlist();
    expect(allowlist).toBeDefined();

    // Pipelines now produce exact option + action key options
    expect(allowlist!.length).toBeGreaterThanOrEqual(2);
    expect(allowlist![0].pattern).toBe("cat file.txt | grep error");
    expect(allowlist![0].description).toContain("compound");
    // Action keys from the first segment before the pipe
    expect(allowlist!.some((o) => o.pattern.startsWith("action:"))).toBe(true);
  });
});
