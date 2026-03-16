/**
 * Tests for the tool preview lifecycle feature.
 *
 * Verifies:
 * - handleToolUsePreviewStart emits correct events
 * - handleToolUsePreviewStart emits activity state with "tool_running" phase
 * - handleInputJsonDelta includes toolUseId in emitted tool_input_delta
 * - handleToolResult includes toolUseId in emitted tool_result
 * - Event ordering: tool_use_preview_start → input_json_delta → tool_use
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Mock platform (must precede imports that read it) ─────────────────────────
mock.module("../util/platform.js", () => ({
  getSessionTokenPath: () => "/tmp/test-token",
  getRootDir: () => "/tmp/test",
  getDataDir: () => "/tmp/test",
  getWorkspaceDir: () => "/tmp/test/workspace",
  getWorkspaceSkillsDir: () => "/tmp/test/skills",
  getSandboxWorkingDir: () => "/tmp/test/sandbox",
  getTCPPort: () => undefined,
  getTCPHost: () => "127.0.0.1",
  isTCPEnabled: () => false,
  isMacOS: () => false,
  isLinux: () => true,
  isWindows: () => false,
  getPidPath: () => "/tmp/test.pid",
  getLogPath: () => "/tmp/test.log",
  getDbPath: () => "/tmp/test.db",
  ensureDataDir: () => {},
}));

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
      load: { extraDirs: [], watch: true, watchDebounceMs: 250 },
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

// ── Mock conversation-crud (used by handleToolResult/handleMessageComplete) ──
mock.module("../memory/conversation-crud.js", () => ({
  addMessage: () => ({ id: "mock-msg-id" }),
  getMessageById: () => null,
  updateMessageContent: () => {},
  provenanceFromTrustContext: () => ({}),
}));

mock.module("../memory/llm-request-log-store.js", () => ({
  recordRequestLog: () => {},
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────
import type {
  EventHandlerDeps,
  EventHandlerState,
} from "../daemon/conversation-agent-loop-handlers.js";
import {
  createEventHandlerState,
  handleInputJsonDelta,
  handleToolResult,
  handleToolUse,
  handleToolUsePreviewStart,
} from "../daemon/conversation-agent-loop-handlers.js";
import type { ServerMessage } from "../daemon/message-protocol.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function createMockDeps(
  overrides: Partial<EventHandlerDeps> = {},
): EventHandlerDeps {
  const emittedEvents: ServerMessage[] = [];
  const emittedActivityStates: Array<{
    phase: string;
    reason: string;
    anchor?: string;
    requestId?: string;
    statusText?: string;
  }> = [];

  return {
    ctx: {
      conversationId: "test-session-id",
      provider: { name: "anthropic" },
      traceEmitter: {
        emit: () => {},
      },
      streamThinking: false,
      emitActivityState: (
        phase: string,
        reason: string,
        anchor?: string,
        requestId?: string,
        statusText?: string,
      ) => {
        emittedActivityStates.push({
          phase,
          reason,
          anchor,
          requestId,
          statusText,
        });
      },
      markWorkspaceTopLevelDirty: () => {},
      currentTurnSurfaces: [],
    } as unknown as EventHandlerDeps["ctx"],
    onEvent: (msg: ServerMessage) => {
      emittedEvents.push(msg);
    },
    reqId: "test-req-id",
    isFirstMessage: false,
    shouldGenerateTitle: false,
    rlog: new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }) as unknown as EventHandlerDeps["rlog"],
    turnChannelContext: {
      userMessageChannel: "vellum",
      assistantMessageChannel: "vellum",
    } as EventHandlerDeps["turnChannelContext"],
    turnInterfaceContext: {
      userMessageInterface: "macos",
      assistantMessageInterface: "macos",
    } as EventHandlerDeps["turnInterfaceContext"],
    ...overrides,
  } as EventHandlerDeps;
}

/** Collect events by wrapping onEvent. */
function createEventCollector(): {
  events: ServerMessage[];
  activityStates: Array<{
    phase: string;
    reason: string;
    anchor?: string;
    requestId?: string;
    statusText?: string;
  }>;
  onEvent: (msg: ServerMessage) => void;
  emitActivityState: (
    phase: string,
    reason: string,
    anchor?: string,
    requestId?: string,
    statusText?: string,
  ) => void;
} {
  const events: ServerMessage[] = [];
  const activityStates: Array<{
    phase: string;
    reason: string;
    anchor?: string;
    requestId?: string;
    statusText?: string;
  }> = [];
  return {
    events,
    activityStates,
    onEvent: (msg: ServerMessage) => events.push(msg),
    emitActivityState: (phase, reason, anchor, requestId, statusText) =>
      activityStates.push({ phase, reason, anchor, requestId, statusText }),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("tool preview lifecycle", () => {
  let state: EventHandlerState;

  beforeEach(() => {
    state = createEventHandlerState();
  });

  describe("handleToolUsePreviewStart", () => {
    test("emits tool_use_preview_start message", () => {
      const collector = createEventCollector();
      const deps = createMockDeps({
        onEvent: collector.onEvent,
        ctx: {
          ...createMockDeps().ctx,
          emitActivityState: collector.emitActivityState,
        } as unknown as EventHandlerDeps["ctx"],
      });

      handleToolUsePreviewStart(state, deps, {
        type: "tool_use_preview_start",
        toolUseId: "toolu_abc123",
        toolName: "bash",
      });

      expect(collector.events).toHaveLength(1);
      const emitted = collector.events[0];
      expect(emitted.type).toBe("tool_use_preview_start");
      expect((emitted as any).toolUseId).toBe("toolu_abc123");
      expect((emitted as any).toolName).toBe("bash");
      expect((emitted as any).sessionId).toBe("test-session-id");
    });

    test("emits activity state with tool_running phase and preview_start reason", () => {
      const collector = createEventCollector();
      const deps = createMockDeps({
        onEvent: collector.onEvent,
        ctx: {
          ...createMockDeps().ctx,
          emitActivityState: collector.emitActivityState,
        } as unknown as EventHandlerDeps["ctx"],
      });

      handleToolUsePreviewStart(state, deps, {
        type: "tool_use_preview_start",
        toolUseId: "toolu_abc123",
        toolName: "web_search",
      });

      expect(collector.activityStates).toHaveLength(1);
      const activity = collector.activityStates[0];
      expect(activity.phase).toBe("tool_running");
      expect(activity.reason).toBe("preview_start");
      expect(activity.statusText).toMatch(/^Preparing/);
    });

    test("handleInputJsonDelta includes toolUseId", () => {
      const collector = createEventCollector();
      const deps = createMockDeps({ onEvent: collector.onEvent });

      handleInputJsonDelta(state, deps, {
        type: "input_json_delta",
        toolName: "bash",
        toolUseId: "toolu_delta456",
        accumulatedJson: '{"command": "ls"}',
      });

      expect(collector.events).toHaveLength(1);
      const emitted = collector.events[0];
      expect(emitted.type).toBe("tool_input_delta");
      expect((emitted as any).toolUseId).toBe("toolu_delta456");
      expect((emitted as any).toolName).toBe("bash");
      expect((emitted as any).content).toBe('{"command": "ls"}');
      expect((emitted as any).sessionId).toBe("test-session-id");
    });

    test("handleToolResult includes toolUseId", () => {
      const collector = createEventCollector();
      const deps = createMockDeps({
        onEvent: collector.onEvent,
        ctx: {
          ...createMockDeps().ctx,
          emitActivityState: collector.emitActivityState,
        } as unknown as EventHandlerDeps["ctx"],
      });

      // Pre-register the tool name mapping (normally done by handleToolUse)
      state.toolUseIdToName.set("toolu_result789", "bash");
      state.toolCallTimestamps.set("toolu_result789", {
        startedAt: Date.now(),
      });
      state.currentTurnToolUseIds.push("toolu_result789");

      handleToolResult(state, deps, {
        type: "tool_result",
        toolUseId: "toolu_result789",
        content: "file1.txt\nfile2.txt",
        isError: false,
      });

      const toolResultEvent = collector.events.find(
        (e) => e.type === "tool_result",
      );
      expect(toolResultEvent).toBeDefined();
      expect((toolResultEvent as any).toolUseId).toBe("toolu_result789");
      expect((toolResultEvent as any).sessionId).toBe("test-session-id");
    });
  });

  // ── Event ordering ────────────────────────────────────────────────────────

  describe("event ordering", () => {
    test("events are emitted in correct order: tool_use_preview_start → tool_input_delta → tool_use", () => {
      const collector = createEventCollector();
      const deps = createMockDeps({
        onEvent: collector.onEvent,
        ctx: {
          ...createMockDeps().ctx,
          emitActivityState: collector.emitActivityState,
        } as unknown as EventHandlerDeps["ctx"],
      });

      const toolUseId = "toolu_ordering_test";
      const toolName = "file_read";

      // Step 1: tool_use_preview_start (emitted by provider on content_block_start)
      handleToolUsePreviewStart(state, deps, {
        type: "tool_use_preview_start",
        toolUseId,
        toolName,
      });

      // Step 2: input_json_delta (emitted during streaming of tool input)
      handleInputJsonDelta(state, deps, {
        type: "input_json_delta",
        toolName,
        toolUseId,
        accumulatedJson: '{"path": "/test"}',
      });

      // Step 3: tool_use (emitted when tool execution begins after finalMessage)
      handleToolUse(state, deps, {
        type: "tool_use",
        id: toolUseId,
        name: toolName,
        input: { path: "/test" },
      });

      // Verify ordering
      const eventTypes = collector.events.map((e) => e.type);
      expect(eventTypes).toEqual([
        "tool_use_preview_start",
        "tool_input_delta",
        "tool_use_start",
      ]);

      // Verify all events carry the same toolUseId
      for (const event of collector.events) {
        expect((event as any).toolUseId).toBe(toolUseId);
      }
    });

    test("full lifecycle: preview_start → input_delta → tool_use → tool_result", () => {
      const collector = createEventCollector();
      const deps = createMockDeps({
        onEvent: collector.onEvent,
        ctx: {
          ...createMockDeps().ctx,
          emitActivityState: collector.emitActivityState,
        } as unknown as EventHandlerDeps["ctx"],
      });

      const toolUseId = "toolu_full_lifecycle";
      const toolName = "bash";

      // 1. Preview start
      handleToolUsePreviewStart(state, deps, {
        type: "tool_use_preview_start",
        toolUseId,
        toolName,
      });

      // 2. Input streaming
      handleInputJsonDelta(state, deps, {
        type: "input_json_delta",
        toolName,
        toolUseId,
        accumulatedJson: '{"command": "echo hello"}',
      });

      // 3. Tool use start (after finalMessage)
      handleToolUse(state, deps, {
        type: "tool_use",
        id: toolUseId,
        name: toolName,
        input: { command: "echo hello" },
      });

      // 4. Tool result
      handleToolResult(state, deps, {
        type: "tool_result",
        toolUseId,
        content: "hello",
        isError: false,
      });

      const eventTypes = collector.events.map((e) => e.type);
      expect(eventTypes).toEqual([
        "tool_use_preview_start",
        "tool_input_delta",
        "tool_use_start",
        "tool_result",
      ]);

      // Verify toolUseId consistency across all events
      for (const event of collector.events) {
        expect((event as any).toolUseId).toBe(toolUseId);
      }

      // Verify activity state transitions
      const activityPhases = collector.activityStates.map((a) => a.phase);
      expect(activityPhases).toContain("tool_running");
      expect(activityPhases).toContain("thinking");

      // Verify reasons include preview_start and tool_use_start
      const activityReasons = collector.activityStates.map((a) => a.reason);
      expect(activityReasons).toContain("preview_start");
      expect(activityReasons).toContain("tool_use_start");
      expect(activityReasons).toContain("tool_result_received");
    });
  });
});
