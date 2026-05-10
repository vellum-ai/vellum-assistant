/**
 * Tests for `annotatePersistedAssistantMessage` persisting the 3 risk-option
 * arrays alongside the existing `_risk*` scalars.
 *
 * Phase B of the conflation track. Without these annotations, the Rule Editor
 * Modal's chip ladder loses its scope/allowlist/directory options on chat-
 * history reload and falls back to the synthesized `*` allowlist.
 *
 * The test exercises the full populate → annotate → persist round-trip:
 *   handleToolResult(event with 3 arrays)
 *     → state.toolRiskOutcomes captures them
 *     → annotatePersistedAssistantMessage writes _risk*Options onto the row
 *     → updateMessageContent receives the JSON-serialized output
 *
 * Read-side coverage (renderHistoryContent in handlers/shared.ts) lives in
 * server-history-render.test.ts.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Mock platform (must precede imports that read it) ─────────────────────────
mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    skills: {
      entries: {},
      load: { extraDirs: [], watch: false, watchDebounceMs: 0 },
      install: { nodeManager: "npm" },
      allowBundled: null,
      remoteProviders: {
        skillssh: { enabled: true },
        clawhub: { enabled: true },
      },
      remotePolicy: {
        blockSuspicious: true,
        blockMalware: true,
        maxSkillsShRisk: "medium",
      },
    },
  }),
  loadConfig: () => ({}),
}));

let mockedRowContent = "";
const updates: Array<{ id: string; content: string }> = [];

mock.module("../memory/conversation-crud.js", () => ({
  addMessage: () => ({ id: "mock-msg-id" }),
  getMessageById: (id: string) =>
    mockedRowContent ? { id, content: mockedRowContent } : null,
  updateMessageContent: (id: string, content: string) => {
    updates.push({ id, content });
  },
  provenanceFromTrustContext: () => ({}),
}));

mock.module("../memory/llm-request-log-store.js", () => ({
  recordRequestLog: () => {},
  backfillMessageIdOnLogs: () => {},
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────
import type {
  EventHandlerDeps,
  EventHandlerState,
} from "../daemon/conversation-agent-loop-handlers.js";
import {
  createEventHandlerState,
  handleToolResult,
} from "../daemon/conversation-agent-loop-handlers.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDeps(): EventHandlerDeps {
  return {
    ctx: {
      conversationId: "test-conv",
      provider: { name: "anthropic" },
      traceEmitter: { emit: () => {} },
      streamThinking: false,
      emitActivityState: () => {},
      markWorkspaceTopLevelDirty: () => {},
      currentTurnSurfaces: [],
    } as unknown as EventHandlerDeps["ctx"],
    onEvent: () => {},
    reqId: "test-req",
    isFirstMessage: false,
    shouldGenerateTitle: false,
    rlog: new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }) as unknown as EventHandlerDeps["rlog"],
    turnChannelContext: {
      userMessageChannel: "vellum",
      assistantMessageChannel: "vellum",
    } as unknown as EventHandlerDeps["turnChannelContext"],
    turnInterfaceContext: {
      userMessageInterface: "web",
      assistantMessageInterface: "web",
    } as unknown as EventHandlerDeps["turnInterfaceContext"],
  };
}

function setupState(toolUseId: string): EventHandlerState {
  const state = createEventHandlerState();
  state.lastAssistantMessageId = "msg-1";
  state.toolUseIdToName.set(toolUseId, "bash");
  state.toolCallTimestamps.set(toolUseId, { startedAt: Date.now() });
  state.currentTurnToolUseIds.push(toolUseId);
  return state;
}

function findPersistedToolUse(
  rawContent: string,
  toolUseId: string,
): Record<string, unknown> {
  const parsed = JSON.parse(rawContent) as Array<Record<string, unknown>>;
  const block = parsed.find(
    (b) => b.type === "tool_use" && b.id === toolUseId,
  );
  if (!block) throw new Error(`tool_use block ${toolUseId} not found`);
  return block;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("annotatePersistedAssistantMessage — risk-option arrays (Phase B)", () => {
  beforeEach(() => {
    updates.length = 0;
    mockedRowContent = "";
  });

  test("persists all 3 risk-option arrays from the live tool_result event", () => {
    const toolUseId = "tu_persist_full";
    const state = setupState(toolUseId);

    mockedRowContent = JSON.stringify([
      {
        type: "tool_use",
        id: toolUseId,
        name: "bash",
        input: { command: "rm -rf /tmp" },
      },
    ]);

    const scopeOptions = [
      { pattern: "exact", label: "exact: rm -rf /tmp" },
      { pattern: "by-program", label: "All rm" },
    ];
    const allowlistOptions = [
      { label: "exact", description: "exact match", pattern: "rm -rf /tmp" },
      { label: "All rm", description: "All rm commands", pattern: "rm *" },
    ];
    const directoryScopeOptions = [
      { scope: "/Users/me/code", label: "in code/" },
      { scope: "everywhere", label: "Everywhere" },
    ];

    handleToolResult(state, makeDeps(), {
      type: "tool_result",
      toolUseId,
      content: "ok",
      isError: false,
      riskLevel: "high",
      riskReason: "Modifies state",
      matchedTrustRuleId: "rule_42",
      riskScopeOptions: scopeOptions,
      riskAllowlistOptions: allowlistOptions,
      riskDirectoryScopeOptions: directoryScopeOptions,
      approvalMode: "prompted",
      approvalReason: "user_approved",
      riskThreshold: "relaxed",
    });

    expect(updates).toHaveLength(1);
    const block = findPersistedToolUse(updates[0].content, toolUseId);
    // Existing scalars still flow through.
    expect(block._riskLevel).toBe("high");
    expect(block._riskReason).toBe("Modifies state");
    expect(block._matchedTrustRuleId).toBe("rule_42");
    expect(block._approvalMode).toBe("prompted");
    expect(block._approvalReason).toBe("user_approved");
    expect(block._riskThreshold).toBe("relaxed");
    // New: 3 risk-option arrays persisted verbatim.
    expect(block._riskScopeOptions).toEqual(scopeOptions);
    expect(block._riskAllowlistOptions).toEqual(allowlistOptions);
    expect(block._riskDirectoryScopeOptions).toEqual(directoryScopeOptions);
  });

  test("omits empty arrays from the persisted block (saves DB space)", () => {
    const toolUseId = "tu_persist_empty";
    const state = setupState(toolUseId);

    mockedRowContent = JSON.stringify([
      {
        type: "tool_use",
        id: toolUseId,
        name: "bash",
        input: { command: "ls" },
      },
    ]);

    handleToolResult(state, makeDeps(), {
      type: "tool_result",
      toolUseId,
      content: "ok",
      isError: false,
      riskLevel: "low",
      riskScopeOptions: [],
      riskAllowlistOptions: [],
      riskDirectoryScopeOptions: [],
    });

    expect(updates).toHaveLength(1);
    const block = findPersistedToolUse(updates[0].content, toolUseId);
    expect(block._riskLevel).toBe("low");
    expect(block._riskScopeOptions).toBeUndefined();
    expect(block._riskAllowlistOptions).toBeUndefined();
    expect(block._riskDirectoryScopeOptions).toBeUndefined();
  });

  test("omits absent (undefined) arrays from the persisted block", () => {
    // Mirrors classic bash/file tools that don't always emit all 3 arrays —
    // e.g. recall, file_read with riskLevel=low and no allowlist coverage.
    const toolUseId = "tu_persist_absent";
    const state = setupState(toolUseId);

    mockedRowContent = JSON.stringify([
      {
        type: "tool_use",
        id: toolUseId,
        name: "recall",
        input: { query: "anything" },
      },
    ]);

    handleToolResult(state, makeDeps(), {
      type: "tool_result",
      toolUseId,
      content: "ok",
      isError: false,
      riskLevel: "low",
      // No risk-option arrays passed at all.
    });

    expect(updates).toHaveLength(1);
    const block = findPersistedToolUse(updates[0].content, toolUseId);
    expect(block._riskLevel).toBe("low");
    expect(block._riskScopeOptions).toBeUndefined();
    expect(block._riskAllowlistOptions).toBeUndefined();
    expect(block._riskDirectoryScopeOptions).toBeUndefined();
  });

  test("partial coverage — only allowlist options present (e.g. tools with classifier but no scope ladder)", () => {
    const toolUseId = "tu_partial";
    const state = setupState(toolUseId);

    mockedRowContent = JSON.stringify([
      {
        type: "tool_use",
        id: toolUseId,
        name: "file_write",
        input: { path: "/tmp/foo.txt" },
      },
    ]);

    const allowlistOptions = [
      { label: "exact", description: "exact match", pattern: "/tmp/foo.txt" },
    ];

    handleToolResult(state, makeDeps(), {
      type: "tool_result",
      toolUseId,
      content: "ok",
      isError: false,
      riskLevel: "medium",
      riskAllowlistOptions: allowlistOptions,
    });

    expect(updates).toHaveLength(1);
    const block = findPersistedToolUse(updates[0].content, toolUseId);
    expect(block._riskLevel).toBe("medium");
    expect(block._riskAllowlistOptions).toEqual(allowlistOptions);
    expect(block._riskScopeOptions).toBeUndefined();
    expect(block._riskDirectoryScopeOptions).toBeUndefined();
  });
});
