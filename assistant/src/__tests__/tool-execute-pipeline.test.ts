/**
 * Pipeline wrapper tests for `ToolExecutor.execute` (PR 16).
 *
 * Covers:
 * - The public `execute` method routes through `runPipeline("toolExecute",
 *   ...)` so `getMiddlewaresFor("toolExecute")` middleware participates.
 * - The default `toolExecute` plugin (passthrough) preserves the original
 *   execution path — result and side effects match the unwrapped executor.
 * - A spy middleware observes the full tool invocation (name, input, ctx).
 * - A short-circuit middleware intercepts the call and supplies a custom
 *   result without hitting the real tool.
 *
 * These tests reuse the same module mocks as `tool-executor.test.ts` so the
 * permission check, risk classifier, and tool registry are stubbed; the
 * focus here is the pipeline wrapper, not the internal execution body.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import type { ToolExecutionResult } from "../tools/types.js";

// ── Config mock ───────────────────────────────────────────────────────
const mockConfig = {
  provider: "anthropic",
  model: "test",
  maxTokens: 4096,
  dataDir: "/tmp",
  timeouts: {
    shellDefaultTimeoutSec: 120,
    shellMaxTimeoutSec: 600,
    permissionTimeoutSec: 300,
    toolExecutionTimeoutSec: 120,
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
  permissions: {
    mode: "workspace" as const,
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

// ── Logger mock ──────────────────────────────────────────────────────
// Bun's `mock.module` persists across test files until explicitly
// restored, so this mock can leak into `plugin-bootstrap.test.ts`. That
// file inspects `ctx.logger` (populated via `log.child({ plugin })`), so
// we return a Proxy whose `.child(...)` yields another Proxy with the
// same shape — the bootstrap test's `expect(ctx.logger).toBeDefined()`
// then passes regardless of test-file ordering.
function makeFakeLoggerProxy(): object {
  return new Proxy({} as Record<string, unknown>, {
    get: (_target, prop) => {
      if (prop === "child") return () => makeFakeLoggerProxy();
      return () => {};
    },
  });
}
mock.module("../util/logger.js", () => ({
  getLogger: (_name?: string) => makeFakeLoggerProxy(),
  truncateForLog: (value: string) => value,
}));

// ── Permission checker — always allow so execution reaches the tool ──
mock.module("../permissions/checker.js", () => ({
  classifyRisk: async () => ({ level: "low" }),
  check: async () => ({ decision: "allow", reason: "allowed" }),
  generateAllowlistOptions: () => [
    { label: "exact", description: "exact", pattern: "exact" },
  ],
  generateScopeOptions: () => [{ label: "/tmp", scope: "/tmp" }],
}));

// ── Tool usage store stub ────────────────────────────────────────────
mock.module("../memory/tool-usage-store.js", () => ({
  recordToolInvocation: () => {},
  getRecentInvocations: () => [],
  rotateToolInvocations: () => 0,
}));

// ── Tool registry: return a stub tool whose execute records the call ─
let lastToolCall: { name: string; input: Record<string, unknown> } | undefined;
let fakeToolResult: ToolExecutionResult = {
  content: "real tool output",
  isError: false,
};

mock.module("../tools/registry.js", () => ({
  getTool: (name: string) => {
    if (name === "unknown_tool") return undefined;
    return {
      name,
      description: "test tool",
      category: "test",
      defaultRiskLevel: "low",
      getDefinition: () => ({}),
      execute: async (input: Record<string, unknown>) => {
        lastToolCall = { name, input };
        return fakeToolResult;
      },
    };
  },
  getAllTools: () => [],
}));

mock.module("../tools/shared/filesystem/path-policy.js", () => ({
  sandboxPolicy: () => ({ ok: false }),
  hostPolicy: () => ({ ok: false }),
}));

mock.module("../tools/terminal/sandbox.js", () => ({
  wrapCommand: () => ({ command: "", sandboxed: false }),
}));

// ── Redaction + token manager so the executor's imports resolve ──────
mock.module("../security/redaction.js", () => ({
  redactSensitiveFields: (input: Record<string, unknown>) => input,
}));

mock.module("../security/token-manager.js", () => ({
  TokenExpiredError: class TokenExpiredError extends Error {},
}));

// ── Imports — after mock.module so the executor under test picks them up ──
import { PermissionPrompter } from "../permissions/prompter.js";
import { defaultToolExecutePlugin } from "../plugins/defaults/tool-execute.js";
import {
  getMiddlewaresFor,
  registerPlugin,
  resetPluginRegistryForTests,
} from "../plugins/registry.js";
import type {
  Middleware,
  Plugin,
  ToolExecuteArgs,
  ToolExecuteResult,
} from "../plugins/types.js";
import { ToolExecutor } from "../tools/executor.js";
import type { ToolContext } from "../tools/types.js";

function makeContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    workingDir: "/tmp/project",
    conversationId: "conversation-pipeline",
    trustClass: "guardian",
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

beforeEach(() => {
  resetPluginRegistryForTests();
  lastToolCall = undefined;
  fakeToolResult = { content: "real tool output", isError: false };
});

describe("ToolExecutor.execute → toolExecute pipeline", () => {
  test("default pipeline (no plugins) runs the same execution path", async () => {
    // With no plugins registered, the pipeline has an empty middleware
    // array and the terminal (executeInternal) runs directly. The
    // observable result must match the unwrapped behavior.
    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      "file_read",
      { path: "README.md" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(result.content).toBe("real tool output");
    expect(lastToolCall).toEqual({
      name: "file_read",
      input: { path: "README.md" },
    });
  });

  test("default tool-execute plugin: registering the passthrough preserves behavior", async () => {
    // The default plugin is a passthrough whose middleware forwards to
    // `next`. Registering it should not change observable behavior —
    // the terminal still runs and returns the real tool result.
    registerPlugin(defaultToolExecutePlugin);

    // Sanity: the registry now reports exactly one middleware for the
    // `toolExecute` slot, named `defaultToolExecute`.
    const middlewares = getMiddlewaresFor("toolExecute");
    expect(middlewares).toHaveLength(1);
    expect(middlewares[0]?.name).toBe("defaultToolExecute");

    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      "file_read",
      { path: "README.md" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(result.content).toBe("real tool output");
    expect(lastToolCall).toEqual({
      name: "file_read",
      input: { path: "README.md" },
    });
  });

  test("spy middleware observes the full tool invocation (name, input, ctx)", async () => {
    let observedArgs: ToolExecuteArgs | undefined;
    let observedTurnCtx:
      | { conversationId: string; requestId: string }
      | undefined;

    const spyMiddleware: Middleware<ToolExecuteArgs, ToolExecuteResult> =
      async function spy(args, next, ctx) {
        observedArgs = args;
        observedTurnCtx = {
          conversationId: ctx.conversationId,
          requestId: ctx.requestId,
        };
        return next(args);
      };

    const spyPlugin: Plugin = {
      manifest: {
        name: "spy-tool-execute",
        version: "0.0.1",
        requires: { pluginRuntime: "v1" },
      },
      middleware: { toolExecute: spyMiddleware },
    };
    registerPlugin(spyPlugin);

    const executor = new ToolExecutor(makePrompter());
    const ctx = makeContext({
      conversationId: "conv-spy",
      requestId: "req-spy",
    });
    const result = await executor.execute(
      "bash",
      { command: "echo hi", timeout_seconds: 10 },
      ctx,
    );

    // Spy observed the full args
    expect(observedArgs).toBeDefined();
    expect(observedArgs!.name).toBe("bash");
    expect(observedArgs!.input).toEqual({
      command: "echo hi",
      timeout_seconds: 10,
    });
    expect(observedArgs!.context).toBe(ctx);

    // Spy observed the synthesized TurnContext carrying conversation +
    // request IDs from the ToolContext.
    expect(observedTurnCtx).toEqual({
      conversationId: "conv-spy",
      requestId: "req-spy",
    });

    // Terminal still ran — result reflects the real tool output.
    expect(result.isError).toBe(false);
    expect(result.content).toBe("real tool output");
    expect(lastToolCall).toEqual({
      name: "bash",
      input: { command: "echo hi", timeout_seconds: 10 },
    });
  });

  test("short-circuit middleware intercepts and supplies a custom result", async () => {
    const syntheticResult: ToolExecuteResult = {
      content: "synthesized by middleware",
      isError: false,
    };

    const shortCircuit: Middleware<ToolExecuteArgs, ToolExecuteResult> =
      async function shortCircuitMw(_args, _next) {
        // Intentionally omit `next` — the terminal (real tool execution)
        // must not run.
        return syntheticResult;
      };

    const interceptPlugin: Plugin = {
      manifest: {
        name: "short-circuit-tool-execute",
        version: "0.0.1",
        requires: { pluginRuntime: "v1" },
      },
      middleware: { toolExecute: shortCircuit },
    };
    registerPlugin(interceptPlugin);

    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      "file_write",
      { path: "dangerous.txt", content: "should not run" },
      makeContext(),
    );

    expect(result).toEqual(syntheticResult);
    // The real tool execute must NOT have been called.
    expect(lastToolCall).toBeUndefined();
  });

  test("slow middleware does not trip a pipeline-level timeout", async () => {
    // Regression: the pipeline must NOT arm a timer — `executeWithTimeout`
    // inside `executeInternal` is the sole enforcer of the per-tool budget
    // and only wraps the actual tool call. Upstream phases (permission
    // checks, approval waits, middleware) must not race the tool budget,
    // because that would break the `execute()` never-throws contract when
    // a slow phase (e.g. a human clicking "allow") exceeds the budget.
    const slow: Middleware<ToolExecuteArgs, ToolExecuteResult> =
      async function slowMw(args, next) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return next(args);
      };
    registerPlugin({
      manifest: {
        name: "slow-tool-execute",
        version: "0.0.1",
        requires: { pluginRuntime: "v1" },
      },
      middleware: { toolExecute: slow },
    });

    const prev = mockConfig.timeouts.toolExecutionTimeoutSec;
    mockConfig.timeouts.toolExecutionTimeoutSec = 0.01;
    try {
      const executor = new ToolExecutor(makePrompter());
      const result = await executor.execute(
        "file_read",
        { path: "README.md" },
        makeContext(),
      );
      // Middleware phase (50ms) exceeds the per-tool budget (10ms), but
      // that budget is only enforced inside `executeWithTimeout` around
      // the tool invocation itself. The terminal runs and succeeds.
      expect(result.isError).toBe(false);
      expect(result.content).toBe("real tool output");
    } finally {
      mockConfig.timeouts.toolExecutionTimeoutSec = prev;
    }
  });

  test("multiple middlewares compose in registration order (outer-first)", async () => {
    const trace: string[] = [];

    const outer: Middleware<ToolExecuteArgs, ToolExecuteResult> =
      async function outerMw(args, next) {
        trace.push("outer:before");
        const result = await next(args);
        trace.push("outer:after");
        return result;
      };
    const inner: Middleware<ToolExecuteArgs, ToolExecuteResult> =
      async function innerMw(args, next) {
        trace.push("inner:before");
        const result = await next(args);
        trace.push("inner:after");
        return result;
      };

    registerPlugin({
      manifest: {
        name: "outer-tool-execute",
        version: "0.0.1",
        requires: { pluginRuntime: "v1" },
      },
      middleware: { toolExecute: outer },
    });
    registerPlugin({
      manifest: {
        name: "inner-tool-execute",
        version: "0.0.1",
        requires: { pluginRuntime: "v1" },
      },
      middleware: { toolExecute: inner },
    });

    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      "file_read",
      { path: "README.md" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    // Outer middleware wraps inner (registration order = onion order),
    // so the trace is outer:before → inner:before → terminal →
    // inner:after → outer:after.
    expect(trace).toEqual([
      "outer:before",
      "inner:before",
      "inner:after",
      "outer:after",
    ]);
  });
});
