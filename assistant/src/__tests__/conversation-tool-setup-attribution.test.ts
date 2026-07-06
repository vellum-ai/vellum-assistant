/**
 * Tests for conversation model attribution threading in
 * conversation-tool-setup.ts: `resolveConversationAttribution` must mirror
 * the agent-loop usage path (the current turn's call site — defaulting to
 * mainAgent — plus the per-turn override profile), `createToolExecutor`
 * must stamp the snapshot onto the ToolContext handed to the executor, and
 * attribution resolution failures must never break tool execution.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { ToolSetupContext } from "../daemon/conversation-tool-setup.js";
import type { SurfaceData, SurfaceType } from "../daemon/message-protocol.js";
import type { PermissionPrompter } from "../permissions/prompter.js";
import type { SecretPrompter } from "../permissions/secret-prompter.js";
import type { ToolExecutor } from "../tools/executor.js";
import type { ToolContext, ToolExecutionResult } from "../tools/types.js";

// ---------------------------------------------------------------------------
// Module mocks (must precede the import of the module under test)
// ---------------------------------------------------------------------------

let mockLlmConfig: Record<string, unknown> = {};
let configThrows = false;

// Non-llm fields used by other conversation-tool-setup consumers (e.g.
// createResolveToolsCallback reads `tools.exclude`), so test files sharing
// this process keep working against the mocked loader.
const baseConfig = {
  tools: { exclude: [] as string[] },
  timeouts: {
    shellDefaultTimeoutSec: 120,
    shellMaxTimeoutSec: 600,
    permissionTimeoutSec: 300,
    toolExecutionTimeoutSec: 600,
  },
  services: {},
};

function mockGetConfig() {
  if (configThrows) throw new Error("config unavailable");
  return { ...baseConfig, llm: mockLlmConfig };
}

mock.module("../config/loader.js", () => ({
  getConfig: mockGetConfig,
  loadConfig: mockGetConfig,
  invalidateConfigCache: () => {},
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  getNestedValue: () => undefined,
  setNestedValue: () => {},
}));

mock.module("../runtime/assistant-event-hub.js", () => ({
  broadcastMessage: mock(() => {}),
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
  isMultifileApp: mock(() => false),
  getAppsDir: mock(() => "/tmp/test-apps"),
  resolveAppIdByDirName: mock(() => null),
  resolveAppIdFromPath: mock(() => null),
}));

// Controls the conversation binding returned to the channel-permission
// channel-ID population in createToolExecutor. Kept as a module mock so
// these tests need no live external_conversation_bindings table.
let mockBindingExternalChatId: string | null = null;
const bindingLookups: string[] = [];
mock.module("../persistence/external-conversation-store.js", () => ({
  getBindingByConversation: (conversationId: string) => {
    bindingLookups.push(conversationId);
    return mockBindingExternalChatId
      ? { conversationId, externalChatId: mockBindingExternalChatId }
      : null;
  },
}));

// ---------------------------------------------------------------------------
// Imports after mocks are in place
// ---------------------------------------------------------------------------

import { LLMSchema } from "../config/schemas/llm.js";
import {
  createToolExecutor,
  resolveConversationAttribution,
} from "../daemon/conversation-tool-setup.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setLlmConfig(raw: unknown): void {
  mockLlmConfig = LLMSchema.parse(raw) as Record<string, unknown>;
}

/** Build a minimal ToolSetupContext stub. */
function makeCtx(overrides: Partial<ToolSetupContext> = {}): ToolSetupContext {
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

/** Fake ToolExecutor that captures the context of each execute() call. */
function makeCapturingExecutor() {
  const calls: Array<{ name: string; context: ToolContext }> = [];
  const executor = {
    execute: async (
      name: string,
      _input: Record<string, unknown>,
      context: ToolContext,
    ): Promise<ToolExecutionResult> => {
      calls.push({ name, context });
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

// The module mock outlives this file when multiple test files share a
// process, so leave the config in a working (non-throwing) state.
afterEach(() => {
  configThrows = false;
});

beforeEach(() => {
  configThrows = false;
  setLlmConfig({
    default: { provider: "anthropic", model: "model-default" },
    profiles: {
      active: { provider: "openai", model: "model-active" },
      pinned: { provider: "gemini", model: "model-pinned" },
    },
    activeProfile: "active",
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// Precedence semantics (override/active/call-site/default) are owned by
// resolveUsageAttribution and covered in usage-attribution.test.ts; the
// tests here only exercise what the wrapper adds on top.
describe("resolveConversationAttribution", () => {
  test("falls back to the workspace active profile when no override is set", () => {
    const snapshot = resolveConversationAttribution({
      conversationId: "conv-test",
    });

    expect(snapshot).toMatchObject({
      callSite: "mainAgent",
      overrideProfile: null,
      appliedProfile: "active",
      profileSource: "active",
      resolvedProvider: "openai",
      resolvedModel: "model-active",
    });
  });

  test("attributes non-main turns to the turn call site like the usage path (voice callAgent)", () => {
    setLlmConfig({
      default: { provider: "anthropic", model: "model-default" },
      profiles: {
        active: { provider: "openai", model: "model-active" },
        pinned: { provider: "gemini", model: "model-pinned" },
      },
      activeProfile: "active",
      callSites: { callAgent: { profile: "pinned" } },
    });

    const snapshot = resolveConversationAttribution({
      conversationId: "conv-test",
      currentCallSite: "callAgent",
    });

    // Matches resolveUsageAttribution semantics for non-main call sites:
    // the call-site profile wins (profileSource "call_site"), not the
    // workspace active profile the mainAgent path would report.
    expect(snapshot).toMatchObject({
      callSite: "callAgent",
      activeProfile: "active",
      callSiteProfile: "pinned",
      appliedProfile: "pinned",
      profileSource: "call_site",
      resolvedProvider: "gemini",
      resolvedModel: "model-pinned",
    });
  });

  test("returns null instead of throwing when resolution fails", () => {
    configThrows = true;

    expect(
      resolveConversationAttribution({ conversationId: "conv-test" }),
    ).toBeNull();
  });
});

describe("createToolExecutor attribution threading", () => {
  test("stamps the attribution snapshot onto the ToolContext for direct tool calls", async () => {
    const { executor, calls } = makeCapturingExecutor();
    const toolFn = makeToolFn(
      executor,
      makeCtx({ currentTurnOverrideProfile: "pinned" }),
    );

    const result = await toolFn("file_read", { path: "/tmp/a" });

    expect(result).toMatchObject({ content: "ok", isError: false });
    expect(calls).toHaveLength(1);
    expect(calls[0].context.attribution).toMatchObject({
      callSite: "mainAgent",
      appliedProfile: "pinned",
      profileSource: "conversation",
      resolvedProvider: "gemini",
      resolvedModel: "model-pinned",
    });
  });

  test("threads a non-main turn call site (voice callAgent) into the snapshot", async () => {
    setLlmConfig({
      default: { provider: "anthropic", model: "model-default" },
      profiles: {
        active: { provider: "openai", model: "model-active" },
        pinned: { provider: "gemini", model: "model-pinned" },
      },
      activeProfile: "active",
      callSites: { callAgent: { profile: "pinned" } },
    });

    const { executor, calls } = makeCapturingExecutor();
    const toolFn = makeToolFn(
      executor,
      makeCtx({ currentCallSite: "callAgent" }),
    );

    await toolFn("file_read", { path: "/tmp/a" });

    expect(calls).toHaveLength(1);
    expect(calls[0].context.attribution).toMatchObject({
      callSite: "callAgent",
      appliedProfile: "pinned",
      profileSource: "call_site",
      resolvedProvider: "gemini",
      resolvedModel: "model-pinned",
    });
  });

  test("stamps the attribution snapshot onto skill_execute dispatches", async () => {
    const { executor, calls } = makeCapturingExecutor();
    const toolFn = makeToolFn(executor, makeCtx());

    await toolFn("skill_execute", {
      tool: "file_read",
      input: { path: "/tmp/a" },
      activity: "testing",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("file_read");
    expect(calls[0].context.attribution).toMatchObject({
      callSite: "mainAgent",
      appliedProfile: "active",
      profileSource: "active",
    });
  });

  test("attribution resolution failure yields null and does not break tool execution", async () => {
    configThrows = true;

    const { executor, calls } = makeCapturingExecutor();
    const toolFn = makeToolFn(executor, makeCtx());

    const result = await toolFn("file_read", { path: "/tmp/a" });

    expect(result).toMatchObject({ content: "ok", isError: false });
    expect(calls).toHaveLength(1);
    expect(calls[0].context.attribution).toBeNull();
  });
});

describe("createToolExecutor isInteractive threading", () => {
  test("uses the resolved turn-level interactivity over live client state", async () => {
    // A scheduled/background turn (currentTurnIsNonInteractive=true) must read
    // as non-interactive even when a client is attached (hasNoClient=false), so
    // ask_question short-circuits instead of parking on the response backstop.
    const { executor, calls } = makeCapturingExecutor();
    const toolFn = makeToolFn(
      executor,
      makeCtx({ currentTurnIsNonInteractive: true, hasNoClient: false }),
    );

    await toolFn("file_read", { path: "/tmp/a" });

    expect(calls[0].context.isInteractive).toBe(false);
  });

  test("reflects an interactive turn as interactive", async () => {
    const { executor, calls } = makeCapturingExecutor();
    const toolFn = makeToolFn(
      executor,
      makeCtx({ currentTurnIsNonInteractive: false }),
    );

    await toolFn("file_read", { path: "/tmp/a" });

    expect(calls[0].context.isInteractive).toBe(true);
  });

  test("falls back to live client state when no turn value is set", async () => {
    // No in-flight turn resolution (e.g. tool execution outside runAgentLoop):
    // derive interactivity from whether a client is connected.
    const noClient = makeCapturingExecutor();
    await makeToolFn(
      noClient.executor,
      makeCtx({ currentTurnIsNonInteractive: undefined, hasNoClient: true }),
    )("file_read", { path: "/tmp/a" });
    expect(noClient.calls[0].context.isInteractive).toBe(false);

    const withClient = makeCapturingExecutor();
    await makeToolFn(
      withClient.executor,
      makeCtx({ currentTurnIsNonInteractive: undefined, hasNoClient: false }),
    )("file_read", { path: "/tmp/a" });
    expect(withClient.calls[0].context.isInteractive).toBe(true);
  });
});

describe("createToolExecutor channel-permission coordinate threading", () => {
  beforeEach(() => {
    mockBindingExternalChatId = null;
    bindingLookups.length = 0;
  });

  test("stamps the binding's external chat id for any external channel adapter", async () => {
    // The channel tier of permission-matrix cell resolution keys on this id
    // for every channel adapter — a Telegram turn must carry its chat id
    // exactly like a Slack turn, or a strict channel-scoped cell can never
    // match its own channel.
    mockBindingExternalChatId = "-1001234500000";
    const { executor, calls } = makeCapturingExecutor();
    await makeToolFn(
      executor,
      makeCtx({
        conversationId: "conv-tg",
        currentTurnTrustContext: {
          sourceChannel: "telegram",
          trustClass: "trusted_contact",
          conversationType: "private",
        },
      }),
    )("file_read", { path: "/tmp/a" });

    expect(calls[0].context.channelPermissionChannelId).toBe("-1001234500000");
    expect(calls[0].context.channelConversationType).toBe("private");
    expect(bindingLookups).toEqual(["conv-tg"]);
  });

  test("internal turns carry no channel id and skip the binding lookup", async () => {
    // "vellum" is the internal control-plane channel (and the fallback trust
    // context); it never has an external conversation binding.
    mockBindingExternalChatId = "should-not-appear";
    const { executor, calls } = makeCapturingExecutor();
    await makeToolFn(
      executor,
      makeCtx({
        currentTurnTrustContext: {
          sourceChannel: "vellum",
          trustClass: "guardian",
        },
      }),
    )("file_read", { path: "/tmp/a" });

    expect(calls[0].context.channelPermissionChannelId).toBeUndefined();
    expect(bindingLookups).toEqual([]);
  });
});
