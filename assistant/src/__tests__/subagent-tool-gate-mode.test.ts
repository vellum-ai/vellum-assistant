/**
 * Tests for `subagentToolGateMode` — the execution-layer tool gating mode
 * used by cache-parity wakes (fork-based memory retrospectives).
 *
 * Covers:
 * - Resolver (`createResolveToolsCallback`): in `"execution"` mode the
 *   resolved tool definitions are NOT filtered by the subagent allowlist
 *   (the wire request keeps the conversation's full tool surface so the
 *   provider prompt-cache prefix stays byte-identical); in `"wire"` mode /
 *   absent, the definitions are filtered exactly as before (regression).
 * - Executor (`createToolExecutor`): in `"execution"` mode a call to a
 *   non-allowlisted tool returns an error tool_result WITHOUT invoking the
 *   tool's executor (safety invariant), while allowlisted calls execute
 *   normally. The gate also covers the `skill_execute` indirection by
 *   gating the resolved inner tool name, and runs BEFORE every in-executor
 *   interception — including `switch_inference_profile`, which must not be
 *   able to switch `ctx.toolRoutedProfile` mid-wake (allowlist bypass +
 *   per-model prompt-cache parity break).
 */

import { describe, expect, mock, test } from "bun:test";

import type { SkillProjectionCache } from "../daemon/conversation-skill-tools.js";
import type { SurfaceData, SurfaceType } from "../daemon/message-protocol.js";
import type { PermissionPrompter } from "../permissions/prompter.js";
import type { SecretPrompter } from "../permissions/secret-prompter.js";
import type { Message, ToolDefinition } from "../providers/types.js";
import type { ToolExecutor } from "../tools/executor.js";
import type { ToolContext, ToolExecutionResult } from "../tools/types.js";

// ---------------------------------------------------------------------------
// Module mocks (must precede the import of the module under test)
// ---------------------------------------------------------------------------

const baseConfig = {
  tools: { exclude: [] as string[] },
  timeouts: {
    shellDefaultTimeoutSec: 120,
    shellMaxTimeoutSec: 600,
    permissionTimeoutSec: 300,
    toolExecutionTimeoutSec: 600,
  },
  services: {},
  llm: { profiles: { speedy: { label: "Speedy" } } },
};

mock.module("../config/loader.js", () => ({
  getConfig: () => baseConfig,
  loadConfig: () => baseConfig,
  invalidateConfigCache: () => {},
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  getNestedValue: () => undefined,
  setNestedValue: () => {},
}));

mock.module("../runtime/assistant-event-hub.js", () => ({
  broadcastMessage: mock(() => {}),
  assistantEventHub: { listClientsByCapability: () => [] },
}));

mock.module("../daemon/conversation-surfaces.js", () => ({
  refreshSurfacesForApp: mock(() => {}),
  surfaceProxyResolver: mock(() =>
    Promise.resolve({ content: "", isError: false }),
  ),
}));

mock.module("../services/published-app-updater.js", () => ({
  updatePublishedAppDeployment: mock(() => Promise.resolve()),
}));

mock.module("../tools/browser/browser-screencast.js", () => ({
  registerConversationSender: mock(() => {}),
}));

mock.module("../memory/app-store.js", () => ({
  getApp: mock(() => null),
  getAppDirPath: mock(() => "/tmp/test-apps/dummy"),
  isMultifileApp: mock(() => false),
  getAppsDir: mock(() => "/tmp/test-apps"),
  resolveAppIdByDirName: mock(() => null),
  resolveAppIdFromPath: mock(() => null),
}));

// Controls the skill tools the projection reports per resolver call.
let projectedSkillToolNames: string[] = [];

mock.module("../daemon/conversation-skill-tools.js", () => ({
  projectSkillTools: mock(() => ({
    allowedToolNames: new Set(projectedSkillToolNames),
    toolDefinitions: [],
  })),
}));

// ---------------------------------------------------------------------------
// Imports after mocks are in place
// ---------------------------------------------------------------------------

import {
  createResolveToolsCallback,
  createToolExecutor,
  type SkillProjectionContext,
  type ToolSetupContext,
} from "../daemon/conversation-tool-setup.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EMPTY_HISTORY: Message[] = [];

function makeToolDef(name: string): ToolDefinition {
  return { name, description: `${name} tool`, input_schema: {} };
}

function makeProjectionCtx(
  overrides: Partial<SkillProjectionContext> = {},
): SkillProjectionContext {
  return {
    skillProjectionState: new Map(),
    skillProjectionCache: {} as SkillProjectionCache,
    coreToolNames: new Set(["remember", "tool_b"]),
    toolsDisabledDepth: 0,
    ...overrides,
  };
}

function makeSetupCtx(
  overrides: Partial<ToolSetupContext> = {},
): ToolSetupContext {
  return {
    conversationId: "conv-test",
    currentRequestId: "req-1",
    workingDir: "/tmp/test",
    abortController: null,
    traceEmitter: { emit: () => {} },
    sendToClient: mock(() => {}),
    pendingSurfaceActions: new Map(),
    lastSurfaceAction: new Map(),
    surfaceState: new Map<
      string,
      { surfaceType: SurfaceType; data: SurfaceData; title?: string }
    >(),
    surfaceUndoStacks: new Map(),
    accumulatedSurfaceState: new Map(),
    surfaceActionRequestIds: new Set<string>(),
    currentTurnSurfaces: [],
    isProcessing: () => false,
    enqueueMessage: () => ({ queued: false, requestId: "r" }),
    getQueueDepth: () => 0,
    processMessage: async () => "",
    withSurface: async <T>(_id: string, fn: () => T | Promise<T>) => fn(),
    ...overrides,
  };
}

/** Fake ToolExecutor that records every execute() invocation. */
function makeCapturingExecutor() {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const executor = {
    execute: async (
      name: string,
      input: Record<string, unknown>,
      _context: ToolContext,
    ): Promise<ToolExecutionResult> => {
      calls.push({ name, input });
      return { content: "ok", isError: false };
    },
  };
  return { executor: executor as unknown as ToolExecutor, calls };
}

const noopPrompter = {
  prompt: mock(async () => ({ decision: "allow" as const })),
} as unknown as PermissionPrompter;
const noopSecretPrompter = {
  prompt: mock(async () => ({ cancelled: true })),
} as unknown as SecretPrompter;

function makeToolFn(executor: ToolExecutor, ctx: ToolSetupContext) {
  return createToolExecutor(
    executor,
    noopPrompter,
    noopSecretPrompter,
    ctx,
    () => {},
  );
}

// ---------------------------------------------------------------------------
// Resolver — wire vs execution gate mode
// ---------------------------------------------------------------------------

describe("createResolveToolsCallback — subagentToolGateMode", () => {
  test("wire mode (default) filters resolved defs to the subagent allowlist (regression)", () => {
    projectedSkillToolNames = ["skill_tool_x"];
    const toolDefs = [makeToolDef("remember"), makeToolDef("tool_b")];
    const ctx = makeProjectionCtx({
      subagentAllowedTools: new Set(["remember"]),
    });
    const resolve = createResolveToolsCallback(toolDefs, ctx)!;

    const tools = resolve(EMPTY_HISTORY);

    expect(tools.map((t) => t.name)).toEqual(["remember"]);
    expect(ctx.allowedToolNames).toEqual(new Set(["remember"]));
  });

  test("execution mode keeps the full tool surface on the wire", () => {
    projectedSkillToolNames = ["skill_tool_x"];
    const toolDefs = [makeToolDef("remember"), makeToolDef("tool_b")];
    const ctx = makeProjectionCtx({
      subagentAllowedTools: new Set(["remember"]),
      subagentToolGateMode: "execution",
    });
    const resolve = createResolveToolsCallback(toolDefs, ctx)!;

    const tools = resolve(EMPTY_HISTORY);

    // Defs are NOT filtered by the allowlist — byte-identical to a turn
    // without any subagent allowlist.
    expect(tools.map((t) => t.name).sort()).toEqual(["remember", "tool_b"]);
    // Skill-projection availability is also not narrowed: the execution-layer
    // gate in the executor callback owns enforcement.
    expect(ctx.allowedToolNames).toEqual(
      new Set(["remember", "tool_b", "skill_tool_x"]),
    );
  });

  test("execution mode resolves the same defs as having no allowlist at all", () => {
    projectedSkillToolNames = [];
    const toolDefs = [makeToolDef("remember"), makeToolDef("tool_b")];

    const unscoped = createResolveToolsCallback(toolDefs, makeProjectionCtx())!(
      EMPTY_HISTORY,
    );
    const executionScoped = createResolveToolsCallback(
      toolDefs,
      makeProjectionCtx({
        subagentAllowedTools: new Set(["remember"]),
        subagentToolGateMode: "execution",
      }),
    )!(EMPTY_HISTORY);

    expect(executionScoped).toEqual(unscoped);
  });
});

// ---------------------------------------------------------------------------
// Resolver — toolContextPin (wire tool-surface parity for execution wakes)
// ---------------------------------------------------------------------------

describe("createResolveToolsCallback — toolContextPin", () => {
  // Core defs spanning each client-gated family: host proxy (host_bash),
  // dynamic UI (ui_show), connected-client (app_open), client-platform
  // (request_system_permission), plus the always-on remember.
  const CLIENT_GATED_DEFS = [
    makeToolDef("remember"),
    makeToolDef("host_bash"),
    makeToolDef("ui_show"),
    makeToolDef("app_open"),
    makeToolDef("request_system_permission"),
  ];

  /** Execution-gate ctx shaped like a clientless fork-retrospective wake. */
  function clientlessExecutionCtx(
    overrides: Partial<SkillProjectionContext> = {},
  ): SkillProjectionContext {
    return makeProjectionCtx({
      coreToolNames: new Set(CLIENT_GATED_DEFS.map((d) => d.name)),
      hasNoClient: true,
      subagentAllowedTools: new Set(["remember"]),
      subagentToolGateMode: "execution",
      ...overrides,
    });
  }

  test("control: without a pin, a clientless fork drops every client-gated tool from the wire", () => {
    projectedSkillToolNames = [];
    const resolve = createResolveToolsCallback(
      CLIENT_GATED_DEFS,
      clientlessExecutionCtx(),
    )!;

    expect(resolve(EMPTY_HISTORY).map((t) => t.name)).toEqual(["remember"]);
  });

  test("a desktop-source pin restores the host/UI/client tool defs on the wire", () => {
    projectedSkillToolNames = [];
    const resolve = createResolveToolsCallback(
      CLIENT_GATED_DEFS,
      clientlessExecutionCtx({
        toolContextPin: { hasNoClient: false, transportInterface: "macos" },
      }),
    )!;

    const names = resolve(EMPTY_HISTORY)
      .map((t) => t.name)
      .sort();
    // request_system_permission stays out: it keys on
    // channelCapabilities.clientOS, which desktop HTTP live turns never set
    // either — exclusion IS parity there.
    expect(names).toEqual(["app_open", "host_bash", "remember", "ui_show"]);
  });

  test("the pin REPLACES the live context — absent pin fields do not fall through", () => {
    projectedSkillToolNames = [];
    // Live ctx claims an interactive macOS client; the pin says clientless.
    // Client-gated tools must drop, proving pinned-undefined beats live.
    const resolve = createResolveToolsCallback(
      CLIENT_GATED_DEFS,
      clientlessExecutionCtx({
        hasNoClient: false,
        transportInterface: "macos",
        toolContextPin: { hasNoClient: true },
      }),
    )!;

    expect(resolve(EMPTY_HISTORY).map((t) => t.name)).toEqual(["remember"]);
  });

  test("invariant: a pinned-in tool is on the wire but can never execute", async () => {
    projectedSkillToolNames = [];
    const pin = { hasNoClient: false, transportInterface: "macos" as const };
    const resolve = createResolveToolsCallback(
      CLIENT_GATED_DEFS,
      clientlessExecutionCtx({ toolContextPin: pin }),
    )!;
    expect(resolve(EMPTY_HISTORY).map((t) => t.name)).toContain("host_bash");

    // The pin affects tool-DEFINITION resolution only: the executor-level
    // gate never reads it, so the pinned-in host tool is rejected before
    // any executor dispatch.
    const { executor, calls } = makeCapturingExecutor();
    const toolFn = makeToolFn(
      executor,
      makeSetupCtx({
        hasNoClient: true,
        subagentAllowedTools: new Set(["remember"]),
        subagentToolGateMode: "execution",
      }),
    );

    const result = await toolFn("host_bash", { command: "echo hi" });

    expect(result).toEqual({
      content: "This background pass may only use: remember.",
      isError: true,
    });
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Executor — execution-layer allowlist gate
// ---------------------------------------------------------------------------

describe("createToolExecutor — execution-layer allowlist gate", () => {
  test("execution mode: non-allowlisted call returns an error tool_result and never invokes the executor", async () => {
    const { executor, calls } = makeCapturingExecutor();
    const toolFn = makeToolFn(
      executor,
      makeSetupCtx({
        subagentAllowedTools: new Set(["remember"]),
        subagentToolGateMode: "execution",
      }),
    );

    const result = await toolFn("bash", { command: "echo hi" });

    expect(result).toEqual({
      content: "This background pass may only use: remember.",
      isError: true,
    });
    // Safety invariant: the non-allowlisted tool's executor must never run.
    expect(calls).toHaveLength(0);
  });

  test("execution mode: allowlisted call executes normally", async () => {
    const { executor, calls } = makeCapturingExecutor();
    const toolFn = makeToolFn(
      executor,
      makeSetupCtx({
        subagentAllowedTools: new Set(["remember"]),
        subagentToolGateMode: "execution",
      }),
    );

    const result = await toolFn("remember", { content: "a fact" });

    expect(result).toEqual({ content: "ok", isError: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("remember");
  });

  test("execution mode: skill_execute gates the resolved inner tool, executor never invoked", async () => {
    const { executor, calls } = makeCapturingExecutor();
    const toolFn = makeToolFn(
      executor,
      makeSetupCtx({
        subagentAllowedTools: new Set(["remember"]),
        subagentToolGateMode: "execution",
      }),
    );

    const rejected = await toolFn("skill_execute", {
      tool: "bash",
      input: { command: "echo hi" },
    });
    expect(rejected).toEqual({
      content: "This background pass may only use: remember.",
      isError: true,
    });
    expect(calls).toHaveLength(0);

    const allowed = await toolFn("skill_execute", {
      tool: "remember",
      input: { content: "a fact" },
    });
    expect(allowed).toEqual({ content: "ok", isError: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("remember");
  });

  test("execution mode: multi-entry allowlist renders sorted in the rejection message", async () => {
    const { executor, calls } = makeCapturingExecutor();
    const toolFn = makeToolFn(
      executor,
      makeSetupCtx({
        subagentAllowedTools: new Set(["remember", "file_read"]),
        subagentToolGateMode: "execution",
      }),
    );

    const result = await toolFn("bash", {});

    expect(result).toEqual({
      content: "This background pass may only use: file_read, remember.",
      isError: true,
    });
    expect(calls).toHaveLength(0);
  });

  test("execution mode: switch_inference_profile is rejected BEFORE its interception runs", async () => {
    const { executor, calls } = makeCapturingExecutor();
    const ctx = makeSetupCtx({
      subagentAllowedTools: new Set(["remember"]),
      subagentToolGateMode: "execution",
    });
    const toolFn = makeToolFn(executor, ctx);

    const result = await toolFn("switch_inference_profile", {
      profile: "speedy",
    });

    // The gate must fire before the interception: the rejection tool_result
    // comes back (NOT the interception's "Switched to ..." / "not found"
    // responses) and the routed profile is untouched — switching it mid-wake
    // would bypass the allowlist and break per-model prompt-cache parity.
    expect(result).toEqual({
      content: "This background pass may only use: remember.",
      isError: true,
    });
    expect(ctx.toolRoutedProfile).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  test("switch_inference_profile interception still works when the gate is inert (regression)", async () => {
    // No execution-mode allowlist (wire mode) — the interception must keep
    // its historical behavior: switch the routed profile without ever
    // touching the tool executor pipeline.
    const { executor, calls } = makeCapturingExecutor();
    const ctx = makeSetupCtx({
      subagentAllowedTools: new Set(["remember"]),
      subagentToolGateMode: "wire",
    });
    const toolFn = makeToolFn(executor, ctx);

    const result = await toolFn("switch_inference_profile", {
      profile: "speedy",
    });

    expect(result).toEqual({
      content: "Switched to Speedy profile. Continue with your response.",
      isError: false,
    });
    expect(ctx.toolRoutedProfile).toBe("speedy");
    expect(calls).toHaveLength(0);
  });

  test("execution mode: allowlisted switch_inference_profile still reaches the interception", async () => {
    // When the orchestrator explicitly allowlists the routing tool, the gate
    // passes and the interception behaves normally.
    const { executor, calls } = makeCapturingExecutor();
    const ctx = makeSetupCtx({
      subagentAllowedTools: new Set(["remember", "switch_inference_profile"]),
      subagentToolGateMode: "execution",
    });
    const toolFn = makeToolFn(executor, ctx);

    const result = await toolFn("switch_inference_profile", {
      profile: "speedy",
    });

    expect(result).toEqual({
      content: "Switched to Speedy profile. Continue with your response.",
      isError: false,
    });
    expect(ctx.toolRoutedProfile).toBe("speedy");
    expect(calls).toHaveLength(0);
  });

  test("wire mode (and absent mode) leaves the executor path unchanged (regression)", async () => {
    // In wire mode the allowlist is enforced by filtering the wire defs (and
    // by the executor pipeline's own allowedToolNames gate) — the new
    // execution-layer rejection must stay inert.
    for (const subagentToolGateMode of ["wire", undefined] as const) {
      const { executor, calls } = makeCapturingExecutor();
      const toolFn = makeToolFn(
        executor,
        makeSetupCtx({
          subagentAllowedTools: new Set(["remember"]),
          subagentToolGateMode,
        }),
      );

      const result = await toolFn("bash", { command: "echo hi" });

      expect(result).toEqual({ content: "ok", isError: false });
      expect(calls).toHaveLength(1);
    }
  });

  test("execution mode without an allowlist gates nothing", async () => {
    const { executor, calls } = makeCapturingExecutor();
    const toolFn = makeToolFn(
      executor,
      makeSetupCtx({ subagentToolGateMode: "execution" }),
    );

    const result = await toolFn("bash", { command: "echo hi" });

    expect(result).toEqual({ content: "ok", isError: false });
    expect(calls).toHaveLength(1);
  });
});
