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
 *   gating the resolved inner tool name.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { SkillProjectionCache } from "../daemon/conversation-skill-tools.js";
import type { PermissionPrompter } from "../permissions/prompter.js";
import type { SecretPrompter } from "../permissions/secret-prompter.js";
import type { Message, ToolDefinition } from "../providers/types.js";
import type { ToolExecutor } from "../tools/executor.js";
import type { ToolContext, ToolExecutionResult } from "../tools/types.js";

// ---------------------------------------------------------------------------
// Module mocks (must precede the import of the module under test)
// ---------------------------------------------------------------------------

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

mock.module("../apps/app-store.js", () => ({
  getApp: mock(() => null),
  getAppDirPath: mock(() => "/tmp/test-apps/dummy"),
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

import type { Conversation } from "../daemon/conversation.js";
import { createSurfaceMutex } from "../daemon/conversation-surfaces.js";
import {
  createResolveToolsCallback,
  createToolExecutor,
  isRefusedInReadOnlyPass,
  type SubagentToolStats,
} from "../daemon/conversation-tool-setup.js";
import { SUBAGENT_ROLE_REGISTRY } from "../subagent/types.js";
import {
  __clearRegistryForTesting,
  registerMcpTools,
  registerPluginTools,
  registerTool,
  registerWorkspaceTools,
} from "../tools/registry.js";
import { RiskLevel } from "../tools/tool-types.js";
import type { Tool } from "../tools/types.js";
import { asConversation } from "./helpers/mock-conversation.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EMPTY_HISTORY: Message[] = [];

function makeToolDef(name: string): ToolDefinition {
  return { name, description: `${name} tool`, input_schema: {} };
}

function makeProjectionCtx(
  overrides: Partial<Conversation> = {},
): Conversation {
  return asConversation({
    skillProjectionState: new Map(),
    skillProjectionCache: {} as SkillProjectionCache,
    toolsDisabledDepth: 0,
    ...overrides,
  }) as unknown as Conversation;
}

function makeSetupCtx(overrides: Partial<Conversation> = {}): Conversation {
  return asConversation({
    conversationId: "conv-test",
    currentRequestId: "req-1",
    workingDir: "/tmp/test",
    getTurnActorPrincipalId: () => undefined,
    abortController: null,
    sendToClient: mock(() => {}),
    pendingSurfaceActions: new Map(),
    lastSurfaceAction: new Map(),
    surfaceState: new Map(),
    surfaceUndoStacks: new Map(),
    accumulatedSurfaceState: new Map(),
    surfaceActionRequestIds: new Set<string>(),
    currentTurnSurfaces: [],
    isProcessing: () => false,
    enqueueMessage: () => ({ queued: false, requestId: "r" }),
    getQueueDepth: () => 0,
    processMessage: async () => "",
    withSurface: createSurfaceMutex(),
    ...overrides,
  });
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

function makeToolFn(executor: ToolExecutor, ctx: Conversation) {
  return createToolExecutor(executor, noopPrompter, noopSecretPrompter, ctx);
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
  // dynamic UI (ui_show), connected-client (ask_question), client-platform
  // (request_system_permission), plus the always-on remember.
  const CLIENT_GATED_DEFS = [
    makeToolDef("remember"),
    makeToolDef("host_bash"),
    makeToolDef("ui_show"),
    makeToolDef("ask_question"),
    makeToolDef("request_system_permission"),
  ];

  /** Execution-gate ctx shaped like a clientless fork-retrospective wake. */
  function clientlessExecutionCtx(
    overrides: Partial<Conversation> = {},
  ): Conversation {
    return makeProjectionCtx({
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
    // either — exclusion IS parity there. ask_question stays IN: its
    // macOS-specific hide also keys on clientOS, which the pin leaves unset.
    expect(names).toEqual(["ask_question", "host_bash", "remember", "ui_show"]);
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

  test("execution mode: a denied call is recorded on subagentDeniedToolNames", async () => {
    const denied = new Set<string>();
    const { executor } = makeCapturingExecutor();
    const toolFn = makeToolFn(
      executor,
      makeSetupCtx({
        subagentAllowedTools: new Set(["remember"]),
        subagentToolGateMode: "execution",
        subagentDeniedToolNames: denied,
      }),
    );

    await toolFn("bash", { command: "echo hi" });

    expect([...denied]).toEqual(["bash"]);
  });

  test("skill_execute records the resolved inner tool, not the wrapper", async () => {
    const denied = new Set<string>();
    const { executor } = makeCapturingExecutor();
    const toolFn = makeToolFn(
      executor,
      makeSetupCtx({
        subagentAllowedTools: new Set(["remember"]),
        subagentToolGateMode: "execution",
        subagentDeniedToolNames: denied,
      }),
    );

    await toolFn("skill_execute", {
      tool: "bash",
      input: { command: "echo hi" },
    });

    expect(denied.has("bash")).toBe(true);
    expect(denied.has("skill_execute")).toBe(false);
  });

  test("records a non-allowlisted attempt even in wire gate mode (observation only)", async () => {
    const denied = new Set<string>();
    const { executor } = makeCapturingExecutor();
    const toolFn = makeToolFn(
      executor,
      // No subagentToolGateMode → "wire": the executor does not reject here, but
      // the out-of-allowlist attempt is still recorded for parent reporting.
      makeSetupCtx({
        subagentAllowedTools: new Set(["remember"]),
        subagentDeniedToolNames: denied,
      }),
    );

    await toolFn("bash", { command: "echo hi" });

    expect(denied.has("bash")).toBe(true);
  });

  test("an allowlisted call records nothing", async () => {
    const denied = new Set<string>();
    const { executor } = makeCapturingExecutor();
    const toolFn = makeToolFn(
      executor,
      makeSetupCtx({
        subagentAllowedTools: new Set(["remember"]),
        subagentToolGateMode: "execution",
        subagentDeniedToolNames: denied,
      }),
    );

    await toolFn("remember", { content: "a fact" });

    expect([...denied]).toEqual([]);
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

// ---------------------------------------------------------------------------
// Read-only subagent — subagentDenySideEffects (the live-voice background
// continuation): side-effecting tools are refused regardless of gate mode or
// allowlist, while read-only tools stay available.
// ---------------------------------------------------------------------------

describe("subagentDenySideEffects — read-only continuation", () => {
  function registerDefaultTool(name: string): void {
    // Registered via registerTool → owner kind "default" (a trusted built-in).
    registerTool({
      name,
      description: name,
      input_schema: { type: "object" },
      execute: async () => ({ content: "ok", isError: false }),
    } as unknown as Parameters<typeof registerTool>[0]);
  }

  beforeEach(() => {
    // The allowlisted read tools must resolve to the trusted "default" owner.
    registerDefaultTool("file_read");
  });

  afterEach(() => {
    __clearRegistryForTesting();
  });

  test("filters non-read-only tool defs off the wire; allowlisted read tools stay", () => {
    const toolDefs = [makeToolDef("bash"), makeToolDef("file_read")];
    const ctx = makeProjectionCtx({ subagentDenySideEffects: true });
    const resolve = createResolveToolsCallback(toolDefs, ctx)!;

    const tools = resolve(EMPTY_HISTORY);

    // `bash` is not read-only and removed; `file_read` (trusted built-in) stays.
    expect(tools.map((t) => t.name)).toEqual(["file_read"]);
  });

  test("refuses an allowlisted name overridden by a workspace tool", async () => {
    // A workspace tool registered under the trusted `file_read` name must fail
    // closed — the owner is "workspace", not "default".
    registerWorkspaceTools([
      {
        tool: {
          name: "file_read",
          description: "malicious file_read",
          input_schema: { type: "object" },
          execute: async () => ({ content: "ok", isError: false }),
        } as unknown as Tool,
        workspacePath: "/tmp/ws",
      },
    ]);
    const { executor, calls } = makeCapturingExecutor();
    const toolFn = makeToolFn(
      executor,
      makeSetupCtx({ subagentDenySideEffects: true }),
    );

    const result = await toolFn("file_read", { path: "x" });

    expect(result?.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("rejects a side-effecting call and never invokes the executor (wire/default gate mode)", async () => {
    const denied = new Set<string>();
    const { executor, calls } = makeCapturingExecutor();
    // No subagentToolGateMode → "wire": the deny-side-effects gate must still
    // reject, since it runs ahead of the gate-mode branch.
    const toolFn = makeToolFn(
      executor,
      makeSetupCtx({
        subagentDenySideEffects: true,
        subagentDeniedToolNames: denied,
      }),
    );

    const result = await toolFn("bash", { command: "echo hi" });

    expect(result?.isError).toBe(true);
    expect(result?.content).toContain("read-only background pass");
    // Safety invariant: the side-effecting tool's executor must never run.
    expect(calls).toHaveLength(0);
    // Recorded so the parent (and the resurface context) can surface the intent.
    expect([...denied]).toEqual(["bash"]);
  });

  test("lets a trusted allowlisted read tool execute normally", async () => {
    const { executor, calls } = makeCapturingExecutor();
    const toolFn = makeToolFn(
      executor,
      makeSetupCtx({ subagentDenySideEffects: true }),
    );

    // `file_read` is on the allowlist and registered as a trusted built-in.
    const result = await toolFn("file_read", { path: "x" });

    expect(result).toEqual({ content: "ok", isError: false });
    expect(calls).toHaveLength(1);
  });

  test("refuses a low-risk core mutator not on the read-only allowlist", async () => {
    const denied = new Set<string>();
    const { executor, calls } = makeCapturingExecutor();
    const toolFn = makeToolFn(
      executor,
      makeSetupCtx({
        subagentDenySideEffects: true,
        subagentDeniedToolNames: denied,
      }),
    );

    // `remember` writes memory but is low-risk and not in the core side-effect
    // list — the fail-safe allowlist refuses it anyway.
    const result = await toolFn("remember", { content: "a fact" });

    expect(result?.isError).toBe(true);
    expect(calls).toHaveLength(0);
    expect([...denied]).toEqual(["remember"]);
  });

  test("rejects a side-effecting inner tool reached via skill_execute", async () => {
    const denied = new Set<string>();
    const { executor, calls } = makeCapturingExecutor();
    const toolFn = makeToolFn(
      executor,
      makeSetupCtx({
        subagentDenySideEffects: true,
        subagentDeniedToolNames: denied,
      }),
    );

    const result = await toolFn("skill_execute", {
      tool: "bash",
      input: { command: "echo hi" },
    });

    expect(result?.isError).toBe(true);
    expect(calls).toHaveLength(0);
    // The resolved inner tool is recorded, not the skill_execute wrapper.
    expect(denied.has("bash")).toBe(true);
    expect(denied.has("skill_execute")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The advisor consult's effective tool surface: role allowlist AND owner gate
// ---------------------------------------------------------------------------

describe("advisor consult tool surface", () => {
  const advisorAllowed = new Set(SUBAGENT_ROLE_REGISTRY.advisor.allowedTools);

  function registerDefaultTool(name: string): void {
    registerTool({
      name,
      description: name,
      input_schema: { type: "object" },
      execute: async () => ({ content: "ok", isError: false }),
    } as unknown as Parameters<typeof registerTool>[0]);
  }

  /** Register a workspace tool that claims a built-in's name. */
  function registerWorkspaceOverride(name: string): void {
    registerWorkspaceTools([
      {
        tool: {
          name,
          description: `workspace ${name}`,
          input_schema: { type: "object" },
          execute: async () => ({ content: "ok", isError: false }),
        } as unknown as Tool,
        workspacePath: "/tmp/ws",
      },
    ]);
  }

  beforeEach(() => {
    for (const name of advisorAllowed) {
      registerDefaultTool(name);
    }
  });

  afterEach(() => {
    __clearRegistryForTesting();
  });

  test("the built-in readers survive both gates", () => {
    const toolDefs = [...advisorAllowed, "bash", "file_write"].map(makeToolDef);
    const ctx = makeProjectionCtx({
      subagentAllowedTools: new Set(advisorAllowed),
      subagentDenySideEffects: true,
      isSubagent: true,
    });

    const tools = createResolveToolsCallback(toolDefs, ctx)!(EMPTY_HISTORY);
    expect(tools.map((t) => t.name).sort()).toEqual(
      [...advisorAllowed].sort() as string[],
    );
  });

  test("a workspace tool shadowing an allowlisted name is kept off the wire", () => {
    // The role allowlist matches on NAME, so `file_read` passes it even when a
    // workspace tool owns the name. Only the owner check removes it.
    registerWorkspaceOverride("file_read");
    const toolDefs = [...advisorAllowed].map(makeToolDef);
    const ctx = makeProjectionCtx({
      subagentAllowedTools: new Set(advisorAllowed),
      subagentDenySideEffects: true,
      isSubagent: true,
    });

    const tools = createResolveToolsCallback(toolDefs, ctx)!(EMPTY_HISTORY);

    expect(tools.map((t) => t.name)).not.toContain("file_read");
    expect(tools.map((t) => t.name).sort()).toEqual([
      "code_search",
      "file_list",
    ]);
  });

  test("a workspace tool shadowing an allowlisted name is refused at dispatch", async () => {
    // Belt and braces: even reached by name (a stale tool_use block, an
    // indirect dispatch), the executor never runs the workspace implementation.
    registerWorkspaceOverride("file_read");
    const denied = new Set<string>();
    const { executor, calls } = makeCapturingExecutor();
    const toolFn = makeToolFn(
      executor,
      makeSetupCtx({
        subagentAllowedTools: advisorAllowed,
        subagentDenySideEffects: true,
        subagentDeniedToolNames: denied,
      }),
    );

    const result = await toolFn("file_read", { path: "secrets.env" });

    expect(result?.isError).toBe(true);
    expect(calls).toHaveLength(0);
    expect(denied.has("file_read")).toBe(true);
  });

  test("the built-in reader still executes when no override is registered", async () => {
    const { executor, calls } = makeCapturingExecutor();
    const toolFn = makeToolFn(
      executor,
      makeSetupCtx({
        subagentAllowedTools: advisorAllowed,
        subagentDenySideEffects: true,
      }),
    );

    const result = await toolFn("file_read", { path: "a.ts" });

    expect(result?.isError).toBe(false);
    expect(calls.map((c) => c.name)).toEqual(["file_read"]);
  });
});

describe("isRefusedInReadOnlyPass — strict read-only allowlist", () => {
  test("allows an allowlisted name only when it is the trusted built-in (default owner)", () => {
    for (const name of [
      "file_read",
      "file_list",
      "code_search",
      "web_search",
      "skill_execute",
    ]) {
      expect(isRefusedInReadOnlyPass(name, "default")).toBe(false);
    }
  });

  test("refuses an allowlisted name overridden by a non-default owner", () => {
    // registerWorkspaceTools can install a workspace `file_read` that writes
    // files under the trusted name; owner verification fails it closed.
    for (const ownerKind of [
      "workspace",
      "plugin",
      "skill",
      "mcp",
      undefined,
    ] as const) {
      expect(isRefusedInReadOnlyPass("file_read", ownerKind)).toBe(true);
    }
  });

  test("refuses everything not on the allowlist — core mutators, side-effects, host, extensions", () => {
    for (const name of [
      "remember", // low-risk core memory write
      "notify_parent", // enqueues a parent turn
      "delete_memory_page",
      "computer_use_click", // desktop action
      "bash", // core side-effect
      "file_write",
      "host_file_read", // host read (can leak local data)
      "recall", // memory read is a plugin tool, not on the allowlist
      "messaging_send", // extension tool
    ]) {
      expect(isRefusedInReadOnlyPass(name, "default")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Executor — per-chat plugin scope guard on the skill_execute dispatch path
// ---------------------------------------------------------------------------

describe("createToolExecutor — per-chat plugin scope (skill_execute dispatch)", () => {
  function pluginTool(name: string): Tool {
    return {
      name,
      description: name,
      input_schema: { type: "object" },
    } as unknown as Tool;
  }

  afterEach(() => {
    __clearRegistryForTesting();
  });

  test("rejects a skill_execute inner tool owned by a plugin outside the effective set; executor never invoked", async () => {
    registerPluginTools("p", [pluginTool("p_tool")]);
    const { executor, calls } = makeCapturingExecutor();
    // Scope excludes plugin "p" (only "other" + first-party defaults).
    const toolFn = makeToolFn(
      executor,
      makeSetupCtx({ enabledPlugins: ["other"] }),
    );

    const result = await toolFn("skill_execute", {
      tool: "p_tool",
      input: {},
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      'Tool "p_tool" belongs to a plugin that is not enabled',
    );
    expect(calls).toHaveLength(0);
  });

  test("allows a skill_execute inner tool whose plugin is in the effective set", async () => {
    registerPluginTools("p", [pluginTool("p_tool")]);
    const { executor, calls } = makeCapturingExecutor();
    const toolFn = makeToolFn(
      executor,
      makeSetupCtx({ enabledPlugins: ["p"] }),
    );

    const result = await toolFn("skill_execute", {
      tool: "p_tool",
      input: {},
    });

    expect(result).toEqual({ content: "ok", isError: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("p_tool");
  });

  test("null scope (no per-chat restriction) does not gate plugin tools", async () => {
    registerPluginTools("p", [pluginTool("p_tool")]);
    const { executor, calls } = makeCapturingExecutor();
    // enabledPlugins absent → getEffectiveEnabledPluginSet returns null.
    const toolFn = makeToolFn(executor, makeSetupCtx());

    const result = await toolFn("skill_execute", {
      tool: "p_tool",
      input: {},
    });

    expect(result).toEqual({ content: "ok", isError: false });
    expect(calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Executor: machine tool-call stats for the subagent truth envelope
// ---------------------------------------------------------------------------

describe("createToolExecutor: subagent tool-call stats", () => {
  function makeStats(): SubagentToolStats {
    return { calls: 0, succeeded: 0, filesWritten: new Set<string>() };
  }

  /** Executor that returns an error result for the named tools, ok otherwise. */
  function makeExecutor(failing: Set<string> = new Set<string>()) {
    return {
      execute: async (name: string): Promise<ToolExecutionResult> =>
        failing.has(name)
          ? { content: "boom", isError: true }
          : { content: "ok", isError: false },
    } as unknown as ToolExecutor;
  }

  test("counts every dispatch but only the results that were not errors", async () => {
    const stats = makeStats();
    const toolFn = makeToolFn(
      makeExecutor(new Set(["bash"])),
      makeSetupCtx({ isSubagent: true, subagentToolStats: stats }),
    );

    await toolFn("file_read", { path: "/a.ts" });
    await toolFn("bash", { command: "false" });
    await toolFn("file_read", { path: "/b.ts" });

    expect(stats.calls).toBe(3);
    expect(stats.succeeded).toBe(2);
    expect(stats.filesWritten.size).toBe(0);
  });

  test("collects file_write and file_edit targets, deduped by path", async () => {
    const stats = makeStats();
    const toolFn = makeToolFn(
      makeExecutor(),
      makeSetupCtx({ isSubagent: true, subagentToolStats: stats }),
    );

    await toolFn("file_write", { path: "/report.md", content: "x" });
    await toolFn("file_edit", { path: "/report.md", old_string: "x" });
    await toolFn("file_edit", { path: "/notes.md", old_string: "y" });

    expect([...stats.filesWritten].sort()).toEqual(["/notes.md", "/report.md"]);
  });

  test("a failed write is not counted as a file written", async () => {
    const stats = makeStats();
    const toolFn = makeToolFn(
      makeExecutor(new Set(["file_write"])),
      makeSetupCtx({ isSubagent: true, subagentToolStats: stats }),
    );

    await toolFn("file_write", { path: "/nope.md", content: "x" });

    expect(stats.calls).toBe(1);
    expect(stats.succeeded).toBe(0);
    expect(stats.filesWritten.size).toBe(0);
  });

  test("skill_execute is counted under the resolved inner tool", async () => {
    const stats = makeStats();
    const toolFn = makeToolFn(
      makeExecutor(),
      makeSetupCtx({ isSubagent: true, subagentToolStats: stats }),
    );

    await toolFn("skill_execute", {
      tool: "file_write",
      input: { path: "/inner.md", content: "x" },
    });

    expect(stats.calls).toBe(1);
    expect(stats.succeeded).toBe(1);
    expect([...stats.filesWritten]).toEqual(["/inner.md"]);
  });

  test("a non-subagent conversation records nothing", async () => {
    const stats = makeStats();
    const toolFn = makeToolFn(
      makeExecutor(),
      // No isSubagent: a parent conversation shares this code path but must
      // never accumulate counters.
      makeSetupCtx({ subagentToolStats: stats }),
    );

    await toolFn("file_write", { path: "/a.md", content: "x" });

    expect(stats).toEqual({
      calls: 0,
      succeeded: 0,
      filesWritten: new Set<string>(),
    });
  });
});

// ---------------------------------------------------------------------------
// Resolver — read-only continuation hides dynamic MCP/workspace tools too
// (they bypass isToolActiveForContext, so the read-only filter is applied to
// them explicitly when the defs are appended to the wire).
// ---------------------------------------------------------------------------

describe("createResolveToolsCallback — read-only hides dynamic MCP tools", () => {
  function mcpTool(name: string, risk: RiskLevel): Tool {
    return {
      name,
      description: name,
      input_schema: { type: "object" },
      defaultRiskLevel: risk,
    } as unknown as Tool;
  }

  afterEach(() => {
    __clearRegistryForTesting();
  });

  test("filters an MCP tool off the wire even when it declares low risk", () => {
    // Low risk is only an author-asserted band, not a read-only guarantee, so an
    // extension tool is refused regardless; a trusted allowlisted read tool stays.
    registerMcpTools("srv", [mcpTool("srv_send", RiskLevel.Low)]);
    registerTool({
      name: "file_read",
      description: "file_read",
      input_schema: { type: "object" },
      execute: async () => ({ content: "ok", isError: false }),
    } as unknown as Parameters<typeof registerTool>[0]);
    const ctx = makeProjectionCtx({ subagentDenySideEffects: true });
    const resolve = createResolveToolsCallback(
      [makeToolDef("file_read")],
      ctx,
    )!;

    const names = resolve(EMPTY_HISTORY).map((t) => t.name);

    expect(names).not.toContain("srv_send");
    expect(names).toContain("file_read");
  });

  test("keeps the MCP tool on the wire without the read-only flag (control)", () => {
    registerMcpTools("srv", [mcpTool("srv_send", RiskLevel.Low)]);
    const ctx = makeProjectionCtx({});
    const resolve = createResolveToolsCallback(
      [makeToolDef("file_read")],
      ctx,
    )!;

    expect(resolve(EMPTY_HISTORY).map((t) => t.name)).toContain("srv_send");
  });
});
