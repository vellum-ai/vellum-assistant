import { describe, expect, mock, test } from "bun:test";

// ── Module mocks (must come before any imports that transitively load these) ──

// Mock conversation-crud before importing tool executors that depend on it.
mock.module("../persistence/conversation-crud.js", () => ({
  setConversationProcessingStartedAt: () => {},
  isConversationProcessing: () => false,
  setConversationOriginChannelIfUnset: () => {},
  updateConversationContextWindow: () => {},
  deleteMessageById: () => {},
  updateConversationTitle: () => {},
  updateConversationUsage: () => {},
  addMessage: () => ({ id: "mock-msg-id" }),
  getConversation: () => ({
    id: "conv-1",
    contextSummary: null,
    contextCompactedMessageCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalEstimatedCost: 0,
    title: null,
  }),
  provenanceFromTrustContext: () => ({
    source: "user",
    trustContext: undefined,
  }),
  getConversationOriginInterface: () => null,
  getConversationOriginChannel: () => null,
  getMessages: () => null,
  createConversation: () => ({ id: "mock-conv" }),
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
}));

/**
 * Captured messages from injectMessageIntoParent → findConversation → enqueueMessage.
 * Each test can read this after triggering a notification.
 */
const capturedMessages: string[] = [];

/** Parent conversation ids that a notification was routed to (findConversation). */
const capturedParentIds: string[] = [];

const capturedEnqueueCronRunIds: (string | null | undefined)[] = [];
const capturedQueueOptions: {
  queueWhenIdle: boolean;
  metadata?: Record<string, unknown>;
}[] = [];
const drainedParents: string[] = [];
let parentAcceptsEnqueue = true;

// Live subagent conversations, keyed by conversationId. notifyParentFromChild
// routes to the parent recorded here (the non-writable in-process source), so
// tests register a child before expecting a notification to route.
const liveSubagents = new Map<
  string,
  {
    parentConversationId: string;
    subagentSuppressParentNotifications?: boolean;
  }
>();

mock.module("../daemon/conversation-registry.js", () => ({
  findConversation: (id: string) => {
    capturedParentIds.push(id);
    return {
      isStale: () => false,
      hasInFlightWork: () => false,
      enqueueMessage: (options: {
        content: string;
        queueWhenIdle: boolean;
        metadata?: Record<string, unknown>;
        cronRunId?: string | null;
      }) => {
        capturedMessages.push(options.content);
        capturedQueueOptions.push(options);
        capturedEnqueueCronRunIds.push(options.cronRunId);
        return { queued: parentAcceptsEnqueue };
      },
      kickDrainQueue: async () => {
        drainedParents.push(id);
      },
    };
  },
  findConversationOrSubagent: (id: string) => {
    const live = liveSubagents.get(id);
    return live ? { ...live } : undefined;
  },
}));

// notifyParentFromChild reads cosmetic label/fork/objective from the durable
// record. Routing does NOT come from here (see liveSubagents above), so a
// tampered record can only mislabel, never redirect.
const records = new Map<string, SubagentRecord>();
mock.module("../persistence/subagent-store.js", () => ({
  getSubagentRecordByConversationId: (conversationId: string) =>
    records.get(conversationId),
}));

mock.module("../runtime/assistant-event-hub.js", () => ({
  broadcastMessage: () => {},
}));

import type { Conversation } from "../daemon/conversation.js";
import { isToolActiveForContext } from "../daemon/conversation-tool-setup.js";
import { beginTurnFinalization } from "../daemon/turn-finalization.js";
import { setLiveVoiceSessionManagerForTesting } from "../live-voice/live-voice-manager.js";
import { LiveVoiceSessionManager } from "../live-voice/live-voice-session-manager.js";
import type { SubagentRecord } from "../persistence/subagent-store.js";
import {
  injectMessageIntoParent,
  notifyParentFromChild,
} from "../subagent/notify.js";
import type { SubagentParentNotification } from "../subagent/parent-notification.js";
import {
  executeSubagentNotifyParent,
  notifyParentTool,
} from "../tools/subagent/notify-parent.js";

// ── Shared helpers ──────────────────────────────────────────────────

/**
 * Register a subagent so `notifyParentFromChild` (and the `notify_parent` tool)
 * treat `conversationId` as a live subagent: a live child conversation (the
 * routing source) plus a durable record (cosmetic label/fork/objective).
 * Defaults to a running general subagent; pass overrides for status, label,
 * fork, etc. By default the live parent matches the record's parent; pass
 * `liveParentConversationId` to diverge them (models a tampered record).
 */
function seedSubagent(
  conversationId: string,
  overrides: Partial<SubagentRecord> = {},
  liveParentConversationId?: string,
): void {
  const record: SubagentRecord = {
    id: `sub-${conversationId}`,
    parentConversationId: `parent-${conversationId}`,
    conversationId,
    label: "Test",
    objective: "test",
    role: "builder",
    isFork: false,
    sendResultToUser: null,
    parentToolUseId: null,
    status: "running",
    error: null,
    createdAt: 0,
    startedAt: null,
    completedAt: null,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCost: 0,
    ...overrides,
  };
  records.set(conversationId, record);
  liveSubagents.set(conversationId, {
    parentConversationId:
      liveParentConversationId ?? record.parentConversationId,
  });
}

function makeContext(
  conversationId: string,
  extras: Record<string, unknown> = {},
) {
  return {
    workingDir: "/tmp",
    conversationId,
    trustClass: "guardian" as const,
    ...extras,
  } as import("../tools/types.js").ToolContext;
}

/** Drain capturedMessages and return the latest one. */
function lastCapturedMessage(): string {
  return capturedMessages[capturedMessages.length - 1] ?? "";
}

function clearCaptured(): void {
  capturedMessages.length = 0;
  capturedEnqueueCronRunIds.length = 0;
  capturedQueueOptions.length = 0;
  drainedParents.length = 0;
  parentAcceptsEnqueue = true;
}

// ── Tool definition ────────────────────────────────────────────────

describe("voice parent notification routing", () => {
  test("only the matching active call claims task updates, without starting a generic parent turn", async () => {
    clearCaptured();
    const received: SubagentParentNotification[] = [];
    let finishClose: (() => void) | undefined;
    const manager = new LiveVoiceSessionManager({
      createSession: (context) => ({
        start: async () => {
          await context.sendFrame({
            type: "ready",
            sessionId: context.sessionId,
            conversationId: "parent-voice",
          });
        },
        handleClientFrame: () => {},
        handleBinaryAudio: () => {},
        close: () =>
          new Promise<void>((resolve) => {
            finishClose = resolve;
          }),
        receiveSubagentNotification: (notification) => {
          received.push(notification);
          return true;
        },
      }),
    });
    setLiveVoiceSessionManagerForTesting(manager);
    const metadata = {
      subagentNotification: {
        subagentId: "task-1",
        status: "completed",
        conversationId: "child-1",
      },
    };
    try {
      await manager.startSession(
        {
          type: "start",
          audio: { mimeType: "audio/pcm", sampleRate: 24_000, channels: 1 },
        },
        { sendFrame: () => {} },
      );
      injectMessageIntoParent("parent-voice", "Task completed", metadata, {
        cronRunId: "run-123",
      });
      expect(received).toEqual([
        {
          taskId: "child-1",
          message: "Task completed",
          metadata,
          cronRunId: "run-123",
        },
      ]);
      expect(capturedMessages).toEqual([]);
      expect(drainedParents).toEqual([]);

      injectMessageIntoParent("parent-other", "Other task completed", metadata);
      injectMessageIntoParent("parent-voice", "Generic event");
      injectMessageIntoParent("parent-voice", "Hang-up fallback", metadata, {
        bypassLiveVoice: true,
        cronRunId: "run-123",
      });
      expect(received).toHaveLength(1);
      expect(capturedMessages).toEqual([
        "Other task completed",
        "Generic event",
        "Hang-up fallback",
      ]);
      expect(capturedEnqueueCronRunIds.at(-1)).toBe("run-123");

      const closing = manager.endActiveSession("manager_shutdown");
      injectMessageIntoParent(
        "parent-voice",
        "Finished during hang-up",
        metadata,
      );
      expect(received.at(-1)?.message).toBe("Finished during hang-up");
      expect(capturedMessages).not.toContain("Finished during hang-up");
      finishClose?.();
      await closing;
      injectMessageIntoParent(
        "parent-voice",
        "Finished after hang-up",
        metadata,
      );
      expect(capturedMessages.at(-1)).toBe("Finished after hang-up");
    } finally {
      finishClose?.();
      await manager.endActiveSession("manager_shutdown");
      setLiveVoiceSessionManagerForTesting(null);
      clearCaptured();
    }
  });
});

describe("notify_parent tool definition", () => {
  test("has correct core tool definition", () => {
    const def = notifyParentTool;
    const schema = def.input_schema as Record<string, unknown>;
    expect(def.name).toBe("notify_parent");
    expect(schema.required).toContain("message");
    expect(
      (schema.properties as Record<string, Record<string, unknown>>).urgency
        .enum,
    ).toEqual(["info", "important", "blocked"]);
    expect(notifyParentTool.category).toBe("orchestration");
  });

  test("is hidden from non-subagent context", () => {
    const ctx = {
      isSubagent: false,
      preactivatedSkillIds: [],
      skillProjectionState: new Map(),
      skillProjectionCache: new Map(),
      toolsDisabledDepth: 0,
    } as unknown as Conversation;
    expect(isToolActiveForContext("notify_parent", ctx)).toBe(false);
  });

  test("is hidden when isSubagent is undefined", () => {
    const ctx = {
      preactivatedSkillIds: [],
      skillProjectionState: new Map(),
      skillProjectionCache: new Map(),
      toolsDisabledDepth: 0,
    } as unknown as Conversation;
    expect(isToolActiveForContext("notify_parent", ctx)).toBe(false);
  });

  test("is visible to subagent context", () => {
    const ctx = {
      isSubagent: true,
      preactivatedSkillIds: [],
      skillProjectionState: new Map(),
      skillProjectionCache: new Map(),
      toolsDisabledDepth: 0,
    } as unknown as Conversation;
    expect(isToolActiveForContext("notify_parent", ctx)).toBe(true);
  });
});

// ── executeSubagentNotifyParent ────────────────────────────────────

describe("executeSubagentNotifyParent", () => {
  test("rejects calls from non-subagent conversations", async () => {
    const result = await executeSubagentNotifyParent(
      { message: "Found something important" },
      makeContext("not-a-subagent-conv"),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Could not notify parent");
    expect(result.content).toContain("only available to subagents");
  });

  test("succeeds when called from a subagent conversation", async () => {
    clearCaptured();
    const conversationId = "conv-notify-sub-1";
    seedSubagent(conversationId);

    const result = await executeSubagentNotifyParent(
      { message: "Found key results", urgency: "important" },
      makeContext(conversationId),
    );
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.sent).toBe(true);
    expect(parsed.urgency).toBe("important");
    expect(lastCapturedMessage()).toContain("Found key results");
  });

  test("formats message with label and urgency", async () => {
    clearCaptured();
    const conversationId = "conv-notify-format-1";
    seedSubagent(conversationId, {
      label: "Research Task",
      objective: "research",
    });

    await executeSubagentNotifyParent(
      { message: "Preliminary findings ready", urgency: "info" },
      makeContext(conversationId),
    );
    expect(lastCapturedMessage()).toBe(
      '[Subagent "Research Task" — info] Preliminary findings ready',
    );
  });

  test("returns error when message is empty", async () => {
    const result = await executeSubagentNotifyParent(
      { message: "" },
      makeContext("some-conv"),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('"message" is required');
  });

  test("returns error when message is missing", async () => {
    const result = await executeSubagentNotifyParent(
      {},
      makeContext("some-conv"),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('"message" is required');
  });

  test("defaults urgency to info when not provided", async () => {
    const conversationId = "conv-notify-default-urg-1";
    seedSubagent(conversationId);

    const result = await executeSubagentNotifyParent(
      { message: "Progress update" },
      makeContext(conversationId),
    );
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.urgency).toBe("info");
  });

  test("appends guidance hint for blocked urgency", async () => {
    clearCaptured();
    const conversationId = "conv-notify-blocked-1";
    seedSubagent(conversationId);

    await executeSubagentNotifyParent(
      { message: "Need API key to proceed", urgency: "blocked" },
      makeContext(conversationId),
    );
    expect(lastCapturedMessage()).toContain("Need API key to proceed");
    expect(lastCapturedMessage()).toContain(
      "Use subagent_message to send guidance to this subagent.",
    );
  });
});

// ── notifyParentFromChild ──────────────────────────────────────────

describe("notifyParentFromChild", () => {
  test("returns false when the conversation is not a subagent", () => {
    expect(notifyParentFromChild("unknown-conversation", "hi", "info")).toBe(
      false,
    );
  });

  test("returns false for terminal subagents", () => {
    for (const status of ["completed", "failed", "aborted"] as const) {
      const conversationId = `conv-terminal-${status}`;
      seedSubagent(conversationId, { status });
      expect(
        notifyParentFromChild(conversationId, "Should not arrive", "info"),
      ).toBe(false);
    }
  });

  test("returns true for a running subagent and injects into the parent", () => {
    clearCaptured();
    const conversationId = "conv-running-1";
    seedSubagent(conversationId);

    expect(notifyParentFromChild(conversationId, "Test message", "info")).toBe(
      true,
    );
    expect(lastCapturedMessage()).toContain("Test message");
  });

  test("returns false for a synchronous child that suppresses parent notifications", () => {
    clearCaptured();
    const conversationId = "conv-suppressed-1";
    seedSubagent(conversationId);
    // spawnAndAwait children carry this flag: the awaiting caller is their
    // only parent channel, so a mid-run injection must not reach the parent.
    const live = liveSubagents.get(conversationId);
    if (live) {
      live.subagentSuppressParentNotifications = true;
    }

    expect(
      notifyParentFromChild(conversationId, "Should not arrive", "info"),
    ).toBe(false);
    expect(capturedMessages).toHaveLength(0);
  });

  test("labels forks as Fork", () => {
    clearCaptured();
    const conversationId = "conv-fork-1";
    seedSubagent(conversationId, { isFork: true, label: "Explore" });

    notifyParentFromChild(conversationId, "branch result", "info");
    expect(lastCapturedMessage()).toBe('[Fork "Explore" — info] branch result');
  });

  test("routes to the live parent, ignoring a tampered record parent", () => {
    clearCaptured();
    capturedParentIds.length = 0;
    const conversationId = "conv-tamper-1";
    // The durable record claims a victim conversation as parent; the live
    // child's real parent differs. Routing must follow the live child.
    seedSubagent(
      conversationId,
      { parentConversationId: "victim-conversation" },
      "real-parent-conversation",
    );

    expect(notifyParentFromChild(conversationId, "injected", "info")).toBe(
      true,
    );
    expect(capturedParentIds).toContain("real-parent-conversation");
    expect(capturedParentIds).not.toContain("victim-conversation");
  });
});

describe("notify_parent — model-input schema validation (LUM-2857)", () => {
  test("rejects a non-string message", async () => {
    const result = await executeSubagentNotifyParent(
      { message: 42 },
      makeContext("conv-notify-schema-1"),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Invalid input for tool "notify_parent"');
  });

  test("degrades a malformed urgency to info instead of forwarding it", async () => {
    const conversationId = "conv-notify-schema-2";
    seedSubagent(conversationId);
    const result = await executeSubagentNotifyParent(
      { message: "found something", urgency: 42 },
      makeContext(conversationId),
    );
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content) as { urgency: string };
    expect(parsed.urgency).toBe("info");
  });
});

// ── Cron attribution on the injected parent turn ───────────────────

describe("injectMessageIntoParent cron attribution", () => {
  test("the queued delivery path carries the firing's run id", () => {
    clearCaptured();

    injectMessageIntoParent("parent-cron", "notification", undefined, {
      cronRunId: "cron-run-7",
    });

    // The drain runs after the enqueuing turn has ended, so the id has to
    // travel on the queued message for the continuation's spend to land on
    // the firing rather than on a null `cron_run_id`.
    expect(capturedEnqueueCronRunIds).toEqual(["cron-run-7"]);
  });

  test("queues simultaneous idle-parent deliveries until turn finalization", async () => {
    clearCaptured();
    const finalize = beginTurnFinalization("parent-handoff");
    try {
      injectMessageIntoParent("parent-handoff", "first result", undefined, {
        bypassLiveVoice: true,
      });
      injectMessageIntoParent("parent-handoff", "second result", undefined, {
        bypassLiveVoice: true,
      });
      expect(capturedMessages).toEqual(["first result", "second result"]);
      expect(capturedQueueOptions).toEqual([
        expect.objectContaining({
          queueWhenIdle: true,
          metadata: { scripted: true },
        }),
        expect.objectContaining({
          queueWhenIdle: true,
          metadata: { scripted: true },
        }),
      ]);
      expect(drainedParents).toEqual([]);
    } finally {
      finalize();
    }
    await Promise.resolve();
    expect(drainedParents).toEqual(["parent-handoff", "parent-handoff"]);
  });

  test("does not start an unqueued turn when the parent queue rejects delivery", () => {
    clearCaptured();
    parentAcceptsEnqueue = false;
    injectMessageIntoParent("parent-full", "notification");
    expect(drainedParents).toEqual([]);
  });

  test("an unscheduled notification carries no run id", () => {
    clearCaptured();
    injectMessageIntoParent("parent-plain", "notification");
    expect(capturedEnqueueCronRunIds).toEqual([undefined]);
    expect(drainedParents).toEqual(["parent-plain"]);
  });
});
