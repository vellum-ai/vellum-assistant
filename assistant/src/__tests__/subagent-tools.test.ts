import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, mock, test } from "bun:test";

import { setConfig } from "./helpers/set-config.js";

// Seed the non-catalog inference profiles these tests exercise: `disabled`
// drives the "profile is disabled" spawn error, `frontier` is the advisor
// consult's default `advisorProfile`, and the two model-pinned profiles stand
// on either side of the catalog's tool-use verdict (`no-tool-model` is a
// catalog model declared `supportsToolUse: false`, `byok-unknown-model` is a
// model the catalog has never heard of). The catalog profiles (balanced,
// cost-optimized, quality-optimized) always resolve through the code catalog,
// so they need no seeding.
// Exported as a constant so a test that needs an extra `llm` key (a call-site
// pin, say) can re-seed the whole block and restore this baseline afterwards.
const BASE_LLM_CONFIG = {
  profiles: {
    disabled: { status: "disabled" },
    frontier: {},
    "no-tool-model": {
      provider: "openrouter",
      model: "minimax/minimax-01",
    },
    "byok-unknown-model": {
      provider: "openrouter",
      model: "acme/private-llm-9",
    },
  },
  advisorProfile: "frontier",
};
setConfig("llm", BASE_LLM_CONFIG);

// Mock conversation-crud before importing tool executors that depend on it.
let mockGetMessages: (
  conversationId: string,
) => Array<{ role: string; content: unknown }> | null = () => null;

// The profile pinned on the parent conversation, as the spawn tool's
// inheritance rung reads it.
let mockConversationOverrideProfile: string | undefined = undefined;

// Mock the conversation registry so the advisor consult can resolve a fake
// parent conversation (snapshot messages + system prompt) without a live
// Conversation. Other executors in this suite never call `findConversation`.
let mockFindConversation: (conversationId: string) =>
  | {
      messages: Array<{ role: string; content: unknown[] }>;
      getCurrentSystemPrompt: () => string;
    }
  | undefined = () => undefined;
mock.module("../daemon/conversation-registry.js", () => ({
  findConversation: (conversationId: string) =>
    mockFindConversation(conversationId),
}));
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
  getMessages: (conversationId: string) => mockGetMessages(conversationId),
  getConversationOverrideProfile: () => mockConversationOverrideProfile,
  createConversation: () => ({ id: "mock-conv" }),
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
}));

import { getDb } from "../persistence/db-connection.js";
import { resolveMessageContentBlocks } from "../persistence/message-content-file.js";
import { migrateCreateSubagentsTable } from "../persistence/migrations/311-create-subagents-table.js";
import { migrateAddSubagentParentToolUseId } from "../persistence/migrations/356-add-subagent-parent-tool-use-id.js";
import {
  type SubagentRecord,
  upsertSubagentRecord,
} from "../persistence/subagent-store.js";
import { getSubagentManager } from "../subagent/index.js";
import {
  buildSubagentSystemPrompt,
  SubagentAbortedError,
  SubagentManager,
} from "../subagent/manager.js";
import {
  SUBAGENT_READ_STILL_PROCESSING,
  SUBAGENT_ROLE_REGISTRY,
  type SubagentState,
} from "../subagent/types.js";
import { executeSubagentAbort } from "../tools/subagent/abort.js";
import { executeSubagentMessage } from "../tools/subagent/message.js";
import { executeSubagentRead } from "../tools/subagent/read.js";
import { executeSubagentSpawn } from "../tools/subagent/spawn.js";
import { executeSubagentStatus } from "../tools/subagent/status.js";

// The tools fall back to the durable table for a subagent the manager does not
// hold, so every executor here reaches it. Idempotent; the table may already
// exist from a prior run.
migrateCreateSubagentsTable();
migrateAddSubagentParentToolUseId(getDb());

// Load tool definitions from the bundled skill TOOLS.json
const toolsJson = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "../config/bundled-skills/subagent/TOOLS.json"),
    "utf-8",
  ),
);
const findTool = (name: string) =>
  toolsJson.tools.find((t: { name: string }) => t.name === name);

// ── Shared helpers ──────────────────────────────────────────────────

/**
 * Inject a fake subagent into the singleton manager so tool executors
 * can find it. Uses the same private-internals trick as the notify tests.
 *
 * `rehydrated` is a manager-entry property rather than a state field, so it is
 * passed alongside the state overrides and applied to the entry.
 */
function injectSubagent(
  manager: SubagentManager,
  subagentId: string,
  parentConversationId: string,
  status: SubagentState["status"] = "running",
  overrides: Partial<SubagentState> & { rehydrated?: boolean } = {},
): SubagentState {
  const internals = manager as unknown as {
    subagents: Map<
      string,
      {
        conversation: unknown;
        state: SubagentState;
        parentSendToClient: () => void;
        rehydrated?: boolean;
      }
    >;
    parentToChildren: Map<string, Set<string>>;
    labelIndex: Map<string, string>;
  };
  const { rehydrated, ...stateOverrides } = overrides;
  const state: SubagentState = {
    config: {
      id: subagentId,
      parentConversationId,
      label: "Test",
      objective: "test",
    },
    status,
    conversationId: `conv-${subagentId}`,
    isFork: false,
    createdAt: Date.now(),
    usage: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
    ...stateOverrides,
  };
  const fakeConversation = {
    abort: () => {},
    dispose: () => {},
    messages: [],
    sendToClient: () => {},
    usageStats: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
    enqueueMessage: () => ({ queued: false }),
    persistUserMessage: async () => ({ id: "msg-1", deduplicated: false }),
    runAgentLoop: async () => {},
    // The live counters a retained conversation keeps, seeded to agree with
    // any injected `stats`: in production that field is only ever a reading of
    // THIS conversation's counters, and readers re-read them while the
    // conversation is around.
    subagentToolStats: {
      calls: state.stats?.calls ?? 0,
      succeeded: state.stats?.succeeded ?? 0,
      filesWritten: new Set(
        Array.from(
          { length: state.stats?.filesWritten ?? 0 },
          (_unused, i) => `/written-${i}.ts`,
        ),
      ),
    },
    // Drain state, as the queued-turn settle wait observes it. Idle here, so
    // an injected subagent reads as having nothing left to run; a test that
    // wants a follow-up turn in flight drives it through `queuedFollowUpTurn`.
    processing: false,
    queueDepth: 0,
    isProcessing(): boolean {
      return this.processing;
    },
    hasQueuedMessages(): boolean {
      return this.queueDepth > 0;
    },
    async waitForIdle({ timeoutMs }: { timeoutMs: number }): Promise<boolean> {
      // Resolve in slices rather than sitting on the caller's whole budget, so
      // the settle loop re-observes and a turn a test ends on a timer is
      // picked up promptly.
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(timeoutMs, 5)),
      );
      return !this.processing;
    },
  };
  // A rehydrated entry is metadata rebuilt from the durable row, so it never
  // has a live conversation behind it.
  internals.subagents.set(subagentId, {
    conversation: rehydrated ? null : fakeConversation,
    state,
    parentSendToClient: () => {},
    ...(rehydrated ? { rehydrated: true } : {}),
  });
  if (!internals.parentToChildren.has(parentConversationId)) {
    internals.parentToChildren.set(parentConversationId, new Set());
  }
  internals.parentToChildren.get(parentConversationId)!.add(subagentId);

  // Populate label index so label-based lookups work in tests.
  const label = state.config.label;
  internals.labelIndex.set(
    `${parentConversationId}:${label.toLowerCase().trim()}`,
    subagentId,
  );

  return state;
}

/**
 * The live tool-call counters behind an injected subagent's fake conversation,
 * so a test can move them the way a queued follow-up turn does after the run's
 * own harvest.
 */
function liveToolStats(
  manager: SubagentManager,
  subagentId: string,
): { calls: number; succeeded: number; filesWritten: Set<string> } {
  const internals = manager as unknown as {
    subagents: Map<
      string,
      {
        conversation: {
          subagentToolStats: {
            calls: number;
            succeeded: number;
            filesWritten: Set<string>;
          };
        } | null;
      }
    >;
  };
  return internals.subagents.get(subagentId)!.conversation!.subagentToolStats;
}

/** The drain state a test drives to stand in for a queued follow-up turn. */
interface QueuedTurnDrainState {
  /** Messages waiting in the child's queue. */
  queueDepth: number;
  /** Whether the child is mid-turn. */
  processing: boolean;
}

/**
 * Put an injected subagent into the window that opens when guidance is queued
 * during its run: the subagent is terminal because its own run returned, but
 * the queued turn is still ahead of it on a conversation the manager retains.
 *
 * Returns the drain state so the test can move the turn through it. Queued and
 * not yet dispatched to start with, which is where the drain sits at the
 * moment the parent is told to read.
 */
function queuedFollowUpTurn(
  manager: SubagentManager,
  subagentId: string,
): QueuedTurnDrainState {
  const internals = manager as unknown as {
    subagents: Map<
      string,
      {
        conversation: QueuedTurnDrainState | null;
        hadEnqueuedMessages?: boolean;
      }
    >;
  };
  const managed = internals.subagents.get(subagentId)!;
  managed.hadEnqueuedMessages = true;
  const drain = managed.conversation!;
  drain.queueDepth = 1;
  return drain;
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

// ── Tool definitions ────────────────────────────────────────────────

describe("Subagent tool definitions", () => {
  test("spawn tool has correct definition", () => {
    const def = findTool("subagent_spawn");
    expect(def).toBeDefined();
    expect(def.input_schema.required).toEqual(["label", "objective"]);
    expect(def.input_schema.properties.inference_profile).toBeDefined();
    expect(def.input_schema.properties.confirm_repeat.type).toBe("boolean");
  });

  test("abort tool has correct definition", () => {
    const def = findTool("subagent_abort");
    expect(def).toBeDefined();
    expect(def.input_schema.required).toEqual([]);
    expect(def.input_schema.properties.label).toBeDefined();
  });

  test("message tool has correct definition", () => {
    const def = findTool("subagent_message");
    expect(def).toBeDefined();
    expect(def.input_schema.required).toEqual(["content"]);
    expect(def.input_schema.properties.label).toBeDefined();
  });

  test("read tool has correct definition", () => {
    const def = findTool("subagent_read");
    expect(def).toBeDefined();
    expect(def.input_schema.required).toEqual([]);
    expect(def.input_schema.properties.label).toBeDefined();
    expect(def.input_schema.properties.last_n.type).toBe("integer");
    expect(def.description).toContain("NOT a file reader");
    expect(def.description).toContain("file_read");
  });

  test("status tool has correct definition", () => {
    const def = findTool("subagent_status");
    expect(def).toBeDefined();
    expect(def.input_schema.required).toEqual([]);
    expect(def.input_schema.properties.label).toBeDefined();
  });
});

// ── Input validation ────────────────────────────────────────────────

describe("Subagent tool execute validation", () => {
  test("spawn returns error when no sendToClient", async () => {
    const result = await executeSubagentSpawn(
      { label: "test", objective: "do something" },
      makeContext("sess-1"),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("No client connected");
  });

  test("spawn returns error when missing label", async () => {
    const result = await executeSubagentSpawn(
      { objective: "do something" },
      makeContext("sess-1", { sendToClient: () => {} }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("required");
  });

  test("spawn returns error when missing objective", async () => {
    const result = await executeSubagentSpawn(
      { label: "test" },
      makeContext("sess-1", { sendToClient: () => {} }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("required");
  });

  test("spawn returns error when both label and objective missing", async () => {
    const result = await executeSubagentSpawn(
      {},
      makeContext("sess-1", { sendToClient: () => {} }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("required");
  });

  test("status returns empty when no subagents", async () => {
    const result = await executeSubagentStatus(
      {},
      makeContext("nonexistent-session"),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("No subagents found");
  });

  test("status returns error for unknown subagent_id", async () => {
    const result = await executeSubagentStatus(
      { subagent_id: "nonexistent-id" },
      makeContext("sess-1"),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("No subagent found");
  });

  test("abort returns error for unknown subagent_id", async () => {
    const result = await executeSubagentAbort(
      { subagent_id: "nonexistent-id" },
      makeContext("sess-1"),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Could not abort");
  });

  test("abort returns error when missing subagent_id", async () => {
    const result = await executeSubagentAbort({}, makeContext("sess-1"));
    expect(result.isError).toBe(true);
    expect(result.content).toContain("required");
  });

  test("message returns error for unknown subagent_id", async () => {
    const result = await executeSubagentMessage(
      { subagent_id: "nonexistent-id", content: "hello" },
      makeContext("sess-1"),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Could not send");
  });

  test("message returns error when missing required fields", async () => {
    const result = await executeSubagentMessage(
      { subagent_id: "some-id" },
      makeContext("sess-1"),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("required");
  });

  test("message returns error when missing subagent_id and label", async () => {
    const result = await executeSubagentMessage(
      { content: "hello" },
      makeContext("sess-1"),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("required");
  });

  test("read returns error when missing subagent_id", async () => {
    const result = await executeSubagentRead({}, makeContext("sess-1"));
    expect(result.isError).toBe(true);
    expect(result.content).toContain("required");
  });

  test("read returns error for unknown subagent_id", async () => {
    const result = await executeSubagentRead(
      { subagent_id: "nonexistent-id" },
      makeContext("sess-1"),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("No subagent found");
  });
});

// ── Ownership validation ────────────────────────────────────────────

describe("Subagent tool ownership validation", () => {
  const ownerConversation = "owner-sess";
  const otherConversation = "other-sess";
  const subagentId = "owned-sub-1";

  const manager = getSubagentManager();
  injectSubagent(manager, subagentId, ownerConversation);

  test("status rejects non-owner conversation", async () => {
    const result = await executeSubagentStatus(
      { subagent_id: subagentId },
      makeContext(otherConversation),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("No subagent found");
  });

  test("status succeeds for owner conversation", async () => {
    const result = await executeSubagentStatus(
      { subagent_id: subagentId },
      makeContext(ownerConversation),
    );
    expect(result.isError).toBe(false);
  });

  test("message rejects non-owner conversation", async () => {
    const result = await executeSubagentMessage(
      { subagent_id: subagentId, content: "hello" },
      makeContext(otherConversation),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Could not send");
  });

  test("read rejects non-owner conversation", async () => {
    const result = await executeSubagentRead(
      { subagent_id: subagentId },
      makeContext(otherConversation),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("No subagent found");
  });

  test("abort rejects non-owner conversation", async () => {
    const result = await executeSubagentAbort(
      { subagent_id: subagentId },
      makeContext(otherConversation),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Could not abort");
  });

  test("abort succeeds for owner conversation", async () => {
    const result = await executeSubagentAbort(
      { subagent_id: subagentId },
      makeContext(ownerConversation),
    );
    expect(result.isError).toBe(false);
  });
});

// ── Spawn success/failure paths ─────────────────────────────────────

describe("Subagent spawn success and failure", () => {
  test("spawn returns subagentId and pending status on success", async () => {
    const manager = getSubagentManager();
    const originalSpawn = manager.spawn.bind(manager);
    manager.spawn = async () => "mock-subagent-id";

    try {
      const result = await executeSubagentSpawn(
        { label: "Research task", objective: "Find pricing data" },
        makeContext("sess-spawn-1", { sendToClient: () => {} }),
      );
      expect(result.isError).toBe(false);
      const parsed = JSON.parse(result.content);
      expect(parsed.subagentId).toBe("mock-subagent-id");
      expect(parsed.label).toBe("Research task");
      expect(parsed.status).toBe("pending");
      expect(parsed.message).toContain("spawned");
    } finally {
      manager.spawn = originalSpawn;
    }
  });

  test("spawn returns error when manager.spawn throws", async () => {
    const manager = getSubagentManager();
    const originalSpawn = manager.spawn.bind(manager);
    manager.spawn = async () => {
      throw new Error("Cannot spawn subagent: parent is itself a subagent");
    };

    try {
      const result = await executeSubagentSpawn(
        { label: "Nested spawn", objective: "Should fail" },
        makeContext("sess-spawn-2", { sendToClient: () => {} }),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Failed to spawn subagent");
      expect(result.content).toContain("parent is itself a subagent");
    } finally {
      manager.spawn = originalSpawn;
    }
  });

  test("spawn passes context to manager", async () => {
    const manager = getSubagentManager();
    const originalSpawn = manager.spawn.bind(manager);
    let capturedConfig: Record<string, unknown> | undefined;

    manager.spawn = async (config: Record<string, unknown>) => {
      capturedConfig = config;
      return "ctx-subagent-id";
    };

    try {
      await executeSubagentSpawn(
        {
          label: "Context test",
          objective: "Do it",
          context: "Extra info here",
        },
        makeContext("sess-spawn-3", { sendToClient: () => {} }),
      );
      expect(capturedConfig).toBeDefined();
      expect(capturedConfig!.label).toBe("Context test");
      expect(capturedConfig!.objective).toBe("Do it");
      expect(capturedConfig!.context).toBe("Extra info here");
      expect(capturedConfig!.parentConversationId).toBe("sess-spawn-3");
    } finally {
      manager.spawn = originalSpawn;
    }
  });

  test("spawn passes explicit inference_profile to manager over inherited override", async () => {
    const manager = getSubagentManager();
    const originalSpawn = manager.spawn.bind(manager);
    let capturedConfig: Record<string, unknown> | undefined;

    manager.spawn = async (config: Record<string, unknown>) => {
      capturedConfig = config;
      return "profile-subagent-id";
    };

    try {
      const result = await executeSubagentSpawn(
        {
          label: "Profile test",
          objective: "Do it with a chosen model profile",
          inference_profile: "quality-optimized",
        },
        makeContext("sess-spawn-profile", {
          sendToClient: () => {},
          overrideProfile: "balanced",
        }),
      );

      expect(result.isError).toBe(false);
      expect(capturedConfig).toBeDefined();
      expect(capturedConfig!.overrideProfile).toBe("quality-optimized");
      expect(capturedConfig!.forceOverrideProfile).toBe(true);
    } finally {
      manager.spawn = originalSpawn;
    }
  });

  test("spawn passes no override, landing the child on the subagentSpawn default", async () => {
    const manager = getSubagentManager();
    const originalSpawn = manager.spawn.bind(manager);
    let capturedConfig: Record<string, unknown> | undefined;

    manager.spawn = async (config: Record<string, unknown>) => {
      capturedConfig = config;
      return "inherit-default-id";
    };

    try {
      const result = await executeSubagentSpawn(
        { label: "Inherit default", objective: "Do it" },
        makeContext("sess-inherit-default", {
          sendToClient: () => {},
          invokingCallSite: "mainAgent",
        }),
      );

      expect(result.isError).toBe(false);
      // No override travels with the spawn. The child runs its loop under
      // `callSite: "subagentSpawn"` and resolves that call site's own profile,
      // which also keeps its usage attribution off `conversation`.
      expect(capturedConfig!.overrideProfile).toBeUndefined();
      expect(capturedConfig!.forceOverrideProfile).toBeUndefined();
    } finally {
      manager.spawn = originalSpawn;
    }
  });

  test("a non-main invoker's call-site default does not reach the child", async () => {
    const manager = getSubagentManager();
    const originalSpawn = manager.spawn.bind(manager);
    let capturedConfig: Record<string, unknown> | undefined;

    manager.spawn = async (config: Record<string, unknown>) => {
      capturedConfig = config;
      return "inherit-heartbeat-id";
    };

    try {
      const result = await executeSubagentSpawn(
        { label: "Heartbeat child", objective: "Do it" },
        makeContext("sess-inherit-heartbeat", {
          sendToClient: () => {},
          invokingCallSite: "heartbeatAgent",
        }),
      );

      expect(result.isError).toBe(false);
      // A subagent spawned from a heartbeat turn does not pick up
      // heartbeatAgent's cost-optimized default. Delegated work is priced by
      // where it runs, not by which call site happened to delegate it.
      expect(capturedConfig!.overrideProfile).toBeUndefined();
    } finally {
      manager.spawn = originalSpawn;
    }
  });

  test("a per-turn override profile does not reach the child", async () => {
    const manager = getSubagentManager();
    const originalSpawn = manager.spawn.bind(manager);
    let capturedConfig: Record<string, unknown> | undefined;

    manager.spawn = async (config: Record<string, unknown>) => {
      capturedConfig = config;
      return "inherit-override-id";
    };

    try {
      const result = await executeSubagentSpawn(
        { label: "Override child", objective: "Do it" },
        makeContext("sess-inherit-override", {
          sendToClient: () => {},
          invokingCallSite: "mainAgent",
          overrideProfile: "quality-optimized",
        }),
      );

      expect(result.isError).toBe(false);
      // A profile switched mid-conversation is a choice about that
      // conversation, not about the work it delegates, so it stops at the
      // spawn boundary.
      expect(capturedConfig!.overrideProfile).toBeUndefined();
      expect(capturedConfig!.forceOverrideProfile).toBeUndefined();
    } finally {
      manager.spawn = originalSpawn;
    }
  });

  test("spawn still forces an explicit inference_profile over the invoker default", async () => {
    const manager = getSubagentManager();
    const originalSpawn = manager.spawn.bind(manager);
    let capturedConfig: Record<string, unknown> | undefined;

    manager.spawn = async (config: Record<string, unknown>) => {
      capturedConfig = config;
      return "inherit-explicit-id";
    };

    try {
      const result = await executeSubagentSpawn(
        {
          label: "Explicit child",
          objective: "Do it",
          inference_profile: "cost-optimized",
        },
        makeContext("sess-inherit-explicit", {
          sendToClient: () => {},
          invokingCallSite: "mainAgent",
        }),
      );

      expect(result.isError).toBe(false);
      expect(capturedConfig!.overrideProfile).toBe("cost-optimized");
      expect(capturedConfig!.forceOverrideProfile).toBe(true);
    } finally {
      manager.spawn = originalSpawn;
    }
  });

  test("spawn returns error for unknown inference_profile", async () => {
    const manager = getSubagentManager();
    const originalSpawn = manager.spawn.bind(manager);
    let spawnCalled = false;

    manager.spawn = async () => {
      spawnCalled = true;
      return "profile-subagent-id";
    };

    try {
      const result = await executeSubagentSpawn(
        {
          label: "Bad profile",
          objective: "Do it",
          inference_profile: "does-not-exist",
        },
        makeContext("sess-spawn-bad-profile", { sendToClient: () => {} }),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain(
        'Inference profile "does-not-exist" is not defined',
      );
      expect(spawnCalled).toBe(false);
    } finally {
      manager.spawn = originalSpawn;
    }
  });

  test("spawn returns error for disabled inference_profile", async () => {
    const manager = getSubagentManager();
    const originalSpawn = manager.spawn.bind(manager);
    let spawnCalled = false;

    manager.spawn = async () => {
      spawnCalled = true;
      return "profile-subagent-id";
    };

    try {
      const result = await executeSubagentSpawn(
        {
          label: "Disabled profile",
          objective: "Do it",
          inference_profile: "disabled",
        },
        makeContext("sess-spawn-disabled-profile", {
          sendToClient: () => {},
        }),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain(
        'Inference profile "disabled" is disabled',
      );
      expect(spawnCalled).toBe(false);
    } finally {
      manager.spawn = originalSpawn;
    }
  });

  test("spawn handles non-Error throws gracefully", async () => {
    const manager = getSubagentManager();
    const originalSpawn = manager.spawn.bind(manager);
    manager.spawn = async () => {
      throw "string error";
    };

    try {
      const result = await executeSubagentSpawn(
        { label: "Bad spawn", objective: "Fail oddly" },
        makeContext("sess-spawn-4", { sendToClient: () => {} }),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Failed to spawn subagent");
      expect(result.content).toContain("string error");
    } finally {
      manager.spawn = originalSpawn;
    }
  });
});

// ── Profile isolation ───────────────────────────────────────────────

describe("Subagent spawn profile isolation", () => {
  /** Capture the config `executeSubagentSpawn` hands the manager. */
  async function spawnCapturingConfig(
    input: Record<string, unknown>,
    contextExtras: Record<string, unknown> = {},
  ): Promise<{
    result: { content: string; isError: boolean };
    config: Record<string, unknown>;
  }> {
    const manager = getSubagentManager();
    const originalSpawn = manager.spawn.bind(manager);
    let capturedConfig: Record<string, unknown> = {};
    manager.spawn = async (config: Record<string, unknown>) => {
      capturedConfig = config;
      return "isolation-subagent-id";
    };
    try {
      const result = await executeSubagentSpawn(
        input,
        makeContext("sess-isolation", {
          sendToClient: () => {},
          ...contextExtras,
        }),
      );
      return { result, config: capturedConfig };
    } finally {
      mockConversationOverrideProfile = undefined;
      manager.spawn = originalSpawn;
    }
  }

  test("keeps the conversation-pinned profile away from the child", async () => {
    mockConversationOverrideProfile = "quality-optimized";
    const { config } = await spawnCapturingConfig({
      label: "Pinned parent",
      objective: "Do it",
    });
    // No override travels with the spawn, which is what lands the child on
    // the subagentSpawn call site's own profile while leaving usage
    // attribution on `call_site` instead of reporting a pin nobody set.
    expect(config.overrideProfile).toBeUndefined();
    expect(config.forceOverrideProfile).toBeUndefined();
  });

  test("keeps the per-turn override profile away from the child", async () => {
    const { config } = await spawnCapturingConfig(
      { label: "Override parent", objective: "Do it" },
      { invokingCallSite: "mainAgent", overrideProfile: "quality-optimized" },
    );
    expect(config.overrideProfile).toBeUndefined();
  });

  test("still honors an explicit inference_profile", async () => {
    mockConversationOverrideProfile = "cost-optimized";
    const { result, config } = await spawnCapturingConfig({
      label: "Explicit",
      objective: "Do it",
      inference_profile: "quality-optimized",
    });
    expect(config.overrideProfile).toBe("quality-optimized");
    expect(config.forceOverrideProfile).toBe(true);
    expect(JSON.parse(result.content).note).toBeUndefined();
  });

  test("falls back with a note when the catalog denies tool use", async () => {
    const { result, config } = await spawnCapturingConfig({
      label: "No tools",
      objective: "Do it",
      inference_profile: "no-tool-model",
    });
    // Dropping the override is what redirects the child to the call site's
    // profile; naming it explicitly would re-file the spend as a pin.
    expect(config.overrideProfile).toBeUndefined();
    expect(config.forceOverrideProfile).toBeUndefined();
    const parsed = JSON.parse(result.content);
    expect(parsed.subagentId).toBe("isolation-subagent-id");
    expect(parsed.status).toBe("pending");
    expect(parsed.note).toBe(
      'requested profile "no-tool-model" is not verified for tool calling; ran on the default profile instead.',
    );
  });

  test("fails open for a model the catalog does not list", async () => {
    const { result, config } = await spawnCapturingConfig({
      label: "BYOK",
      objective: "Do it",
      inference_profile: "byok-unknown-model",
    });
    expect(config.overrideProfile).toBe("byok-unknown-model");
    expect(config.forceOverrideProfile).toBe(true);
    expect(JSON.parse(result.content).note).toBeUndefined();
  });
});

// ── Repeat-spawn guard ──────────────────────────────────────────────

describe("Subagent spawn repeat-loop guard", () => {
  const guardParent = "guard-parent";

  /** Seed a finished spawn of `objective`, the way the manager records one. */
  function seedSpawn(
    id: string,
    objective: string,
    over: Partial<SubagentRecord> = {},
  ): void {
    upsertSubagentRecord({
      id,
      parentConversationId: guardParent,
      conversationId: `conv-${id}`,
      label: id,
      objective,
      role: "builder",
      isFork: false,
      sendResultToUser: true,
      parentToolUseId: null,
      status: "completed",
      error: null,
      createdAt: Date.now(),
      startedAt: null,
      completedAt: Date.now(),
      inputTokens: 10,
      outputTokens: 20,
      estimatedCost: 1.25,
      ...over,
    });
  }

  /** Seed `count` finished spawns of one objective. */
  function seedSpawns(
    idPrefix: string,
    objective: string,
    count: number,
  ): void {
    for (let i = 0; i < count; i++) {
      seedSpawn(`${idPrefix}-${i}`, objective);
    }
  }

  /**
   * Run the spawn tool, reporting whether the manager was actually asked to
   * spawn.
   */
  async function spawnWithGuard(
    input: Record<string, unknown>,
    conversationId = guardParent,
  ) {
    const manager = getSubagentManager();
    const originalSpawn = manager.spawn.bind(manager);
    let spawned = false;
    manager.spawn = async () => {
      spawned = true;
      return "guard-subagent-id";
    };
    try {
      const result = await executeSubagentSpawn(
        input,
        makeContext(conversationId, { sendToClient: () => {} }),
      );
      return { result, spawned };
    } finally {
      manager.spawn = originalSpawn;
    }
  }

  test("a conversation under the threshold spawns normally", async () => {
    const objective = "Audit the under-threshold pipeline for drift";
    seedSpawns("guard-under", objective, 2);

    const { spawned } = await spawnWithGuard({
      label: "Repeat",
      objective,
    });

    expect(spawned).toBe(true);
  });

  test("a fourth repeat in one conversation is held for confirmation", async () => {
    const objective = "Audit the retention pipeline for drift";
    seedSpawns("guard-conv", objective, 3);

    const { result, spawned } = await spawnWithGuard({
      label: "Repeat",
      objective,
    });

    expect(spawned).toBe(false);
    expect(result.isError).toBe(false);
    expect(result.content).toContain(
      "3 near-identical subagents already completed in this conversation in the last 24 hours",
    );
    expect(result.content).toContain("about $3.75");
    expect(result.content).toContain("confirm_repeat: true");
  });

  test("the assistant-wide threshold catches a repeat spread across conversations", async () => {
    const objective = "Audit the fleet-wide pipeline for drift";
    for (let i = 0; i < 10; i++) {
      seedSpawn(`guard-wide-${i}`, objective, {
        parentConversationId: `guard-wide-parent-${i}`,
      });
    }

    const { result, spawned } = await spawnWithGuard(
      { label: "Repeat", objective },
      "guard-fresh-conversation",
    );

    expect(spawned).toBe(false);
    expect(result.content).toContain(
      "10 near-identical subagents already completed across this assistant in the last 24 hours",
    );
  });

  test("confirm_repeat spawns past the guard", async () => {
    const objective = "Audit the confirmed pipeline for drift";
    seedSpawns("guard-confirm", objective, 5);

    const { result, spawned } = await spawnWithGuard({
      label: "Repeat",
      objective,
      confirm_repeat: true,
    });

    expect(spawned).toBe(true);
    expect(JSON.parse(result.content).status).toBe("pending");
  });

  test("advisor consults are never guarded", async () => {
    const objective = "Audit the advisor pipeline for drift";
    seedSpawns("guard-advisor", objective, 6);

    const { result } = await spawnWithGuard({
      label: "Consult",
      objective,
      role: "advisor",
    });

    // The advisor branch runs and reports its own missing-parent notice, so the
    // guard never saw the repetition.
    expect(result.content).toContain("advisor unavailable");
    expect(result.content).not.toContain("confirm_repeat");
  });

  test("copies still running trip the guard before any of them completes", async () => {
    // The runaway shape the guard exists for: a burst issued faster than
    // anything can finish, which a completed-only count cannot see.
    const objective = "Audit the in-flight pipeline for drift";
    seedSpawn("guard-flight-0", objective, { status: "running" });
    seedSpawn("guard-flight-1", objective, { status: "pending" });

    const { result, spawned } = await spawnWithGuard({
      label: "Repeat",
      objective,
    });

    expect(spawned).toBe(false);
    expect(result.isError).toBe(false);
    expect(result.content).toContain(
      "2 near-identical subagents are already running in this conversation",
    );
    expect(result.content).toContain("none of them has returned yet");
    // Nothing has been produced, so the caller must not be sent reading.
    expect(result.content).not.toContain("subagent_read");
    expect(result.content).toContain("confirm_repeat: true");
  });

  test("a single in-flight copy is not a loop", async () => {
    const objective = "Audit the single-flight pipeline for drift";
    seedSpawn("guard-flight-solo", objective, { status: "running" });

    const { spawned } = await spawnWithGuard({
      label: "Repeat",
      objective,
    });

    expect(spawned).toBe(true);
  });

  test("the assistant-wide in-flight ceiling catches a burst across conversations", async () => {
    const objective = "Audit the fleet-wide in-flight pipeline for drift";
    for (let i = 0; i < 4; i++) {
      seedSpawn(`guard-flight-wide-${i}`, objective, {
        status: "running",
        parentConversationId: `guard-flight-parent-${i}`,
      });
    }

    const { result, spawned } = await spawnWithGuard(
      { label: "Repeat", objective },
      "guard-flight-fresh-conversation",
    );

    expect(spawned).toBe(false);
    expect(result.content).toContain(
      "4 near-identical subagents are already running in this assistant",
    );
  });

  test("completed runs are reported ahead of in-flight ones", async () => {
    // Both ceilings are met; the answer that already exists is the more
    // actionable thing to hand back.
    const objective = "Audit the mixed pipeline for drift";
    seedSpawns("guard-mixed", objective, 3);
    seedSpawn("guard-mixed-running-0", objective, { status: "running" });
    seedSpawn("guard-mixed-running-1", objective, { status: "running" });

    const { result, spawned } = await spawnWithGuard({
      label: "Repeat",
      objective,
    });

    expect(spawned).toBe(false);
    expect(result.content).toContain(
      "3 near-identical subagents already completed in this conversation",
    );
    expect(result.content).toContain("subagent_read");
  });

  test("confirm_repeat spawns past the in-flight guard too", async () => {
    const objective = "Audit the confirmed in-flight pipeline for drift";
    seedSpawns("guard-flight-confirm", objective, 0);
    for (let i = 0; i < 3; i++) {
      seedSpawn(`guard-flight-confirm-${i}`, objective, { status: "running" });
    }

    const { spawned } = await spawnWithGuard({
      label: "Repeat",
      objective,
      confirm_repeat: true,
    });

    expect(spawned).toBe(true);
  });

  test("runs that ended without an answer never trip either ceiling", async () => {
    const objective = "Audit the failed pipeline for drift";
    for (const status of ["failed", "aborted", "interrupted"]) {
      for (let i = 0; i < 4; i++) {
        seedSpawn(`guard-dead-${status}-${i}`, objective, { status });
      }
    }

    const { spawned } = await spawnWithGuard({
      label: "Retry",
      objective,
    });

    expect(spawned).toBe(true);
  });

  test("case and spacing differences count as the same objective", async () => {
    const objective = "Audit the normalized pipeline for drift";
    seedSpawn("guard-norm-0", objective.toUpperCase());
    seedSpawn("guard-norm-1", `  ${objective}  `);
    seedSpawn("guard-norm-2", objective.replace(/ /gu, "\n"));
    seedSpawn("guard-norm-3", objective.replace(/ /gu, "   "));

    const { result, spawned } = await spawnWithGuard({
      label: "Repeat",
      objective,
    });

    expect(spawned).toBe(false);
    expect(result.content).toContain("4 near-identical subagents");
  });

  test("a genuinely different objective is not a repeat", async () => {
    const objective = "Audit the distinct pipeline for drift";
    seedSpawns("guard-distinct", objective, 5);

    const { spawned } = await spawnWithGuard({
      label: "Different",
      objective: "Audit the payouts ledger for drift",
    });

    expect(spawned).toBe(true);
  });

  test("a retry after runs that produced no answer spawns normally", async () => {
    const objective = "Audit the flaky pipeline for drift";
    const unfinished = ["failed", "aborted", "interrupted"];
    unfinished.forEach((status, i) => {
      seedSpawn(`guard-retry-${i}`, objective, { status });
    });
    // Well past the assistant-wide limit too, so neither scope may count them.
    for (let i = 0; i < 12; i++) {
      seedSpawn(`guard-retry-wide-${i}`, objective, {
        parentConversationId: `guard-retry-parent-${i}`,
        status: unfinished[i % unfinished.length],
      });
    }

    const { spawned } = await spawnWithGuard({
      label: "Retry",
      objective,
    });

    expect(spawned).toBe(true);
  });

  test("runs still in flight do not count as answers already produced", async () => {
    // Two answers plus one copy still executing. Each ceiling is judged on its
    // own tally, so neither is reached; folding them into one count would hold
    // this spawn on work that has produced nothing.
    const objective = "Audit the mixed-tally pipeline for drift";
    seedSpawns("guard-inflight-done", objective, 2);
    seedSpawn("guard-inflight-0", objective, { status: "awaiting_input" });

    const { spawned } = await spawnWithGuard({
      label: "Repeat",
      objective,
    });

    expect(spawned).toBe(true);
  });

  test("objectives sharing a boilerplate prefix are distinct tasks", async () => {
    const preamble =
      "Review the module against every item in the team checklist, then write up " +
      "what you found and what should change, focusing on ";
    seedSpawns("guard-batch", `${preamble}the billing service`, 5);

    const { spawned } = await spawnWithGuard({
      label: "Next in batch",
      objective: `${preamble}the payouts service`,
    });

    expect(spawned).toBe(true);
  });

  test("the same long objective is still caught however long its preamble", async () => {
    const objective =
      "Review the module against every item in the team checklist, then write up " +
      "what you found and what should change, focusing on the ledger service";
    seedSpawns("guard-long", objective, 3);

    const { result, spawned } = await spawnWithGuard({
      label: "Repeat",
      objective,
    });

    expect(spawned).toBe(false);
    expect(result.content).toContain("3 near-identical subagents");
  });
});

// ── Message success path ────────────────────────────────────────────

describe("Subagent message success path", () => {
  const ownerConversation = "msg-owner-sess";
  const subagentId = "msg-sub-1";

  test("message succeeds for owner conversation with running subagent", async () => {
    const manager = getSubagentManager();
    injectSubagent(manager, subagentId, ownerConversation, "running");

    const result = await executeSubagentMessage(
      { subagent_id: subagentId, content: "Continue working on this" },
      makeContext(ownerConversation),
    );
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.subagentId).toBe(subagentId);
    expect(parsed.message).toContain("Message sent");
  });

  test("message fails for terminal-state subagent", async () => {
    const manager = getSubagentManager();
    const completedId = "msg-sub-completed";
    injectSubagent(manager, completedId, ownerConversation, "completed");

    const result = await executeSubagentMessage(
      { subagent_id: completedId, content: "Are you there?" },
      makeContext(ownerConversation),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Could not send");
  });
});

// ── Status detail responses ─────────────────────────────────────────

describe("Subagent status detail responses", () => {
  const ownerConversation = "status-owner-sess";

  test("individual status returns full detail fields", async () => {
    const manager = getSubagentManager();
    const subagentId = "status-detail-1";
    const now = Date.now();
    injectSubagent(manager, subagentId, ownerConversation, "running", {
      config: {
        id: subagentId,
        parentConversationId: ownerConversation,
        label: "Detail test",
        objective: "test obj",
      },
      createdAt: now,
      startedAt: now + 10,
      usage: { inputTokens: 500, outputTokens: 200, estimatedCost: 0.01 },
    });

    const result = await executeSubagentStatus(
      { subagent_id: subagentId },
      makeContext(ownerConversation),
    );
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.subagentId).toBe(subagentId);
    expect(parsed.label).toBe("Detail test");
    expect(parsed.status).toBe("running");
    expect(parsed.createdAt).toBe(now);
    expect(parsed.startedAt).toBe(now + 10);
    expect(parsed.usage.inputTokens).toBe(500);
    expect(parsed.usage.outputTokens).toBe(200);
  });

  test("list status returns summary of all children", async () => {
    const manager = getSubagentManager();
    const listConversation = "status-list-sess";
    injectSubagent(manager, "list-sub-1", listConversation, "running");
    injectSubagent(manager, "list-sub-2", listConversation, "completed");

    const result = await executeSubagentStatus(
      {},
      makeContext(listConversation),
    );
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
    const ids = parsed.map((s: { subagentId: string }) => s.subagentId);
    expect(ids).toContain("list-sub-1");
    expect(ids).toContain("list-sub-2");
  });

  test("individual status includes error field for failed subagent", async () => {
    const manager = getSubagentManager();
    const failedId = "status-failed-1";
    injectSubagent(manager, failedId, ownerConversation, "failed", {
      error: "Rate limit exceeded",
    });

    const result = await executeSubagentStatus(
      { subagent_id: failedId },
      makeContext(ownerConversation),
    );
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.status).toBe("failed");
    expect(parsed.error).toBe("Rate limit exceeded");
  });
});

// ── Read tool behavior ──────────────────────────────────────────────

describe("Subagent read tool", () => {
  const ownerConversation = "read-owner-sess";

  test("read returns wait message for non-terminal subagent", async () => {
    const manager = getSubagentManager();
    const subagentId = "read-running-1";
    injectSubagent(manager, subagentId, ownerConversation, "running");

    const result = await executeSubagentRead(
      { subagent_id: subagentId },
      makeContext(ownerConversation),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("still running");
    expect(result.content).toContain("Do not poll");
    expect(result.content).toContain(
      "you will be notified automatically when it completes",
    );
    // A deferred run is announced with a read pointer rather than an inlined
    // result, so the wait message must not promise the result itself.
    expect(result.content).not.toContain("including its result");
  });

  test("read returns wait message for pending subagent", async () => {
    const manager = getSubagentManager();
    const subagentId = "read-pending-1";
    injectSubagent(manager, subagentId, ownerConversation, "pending");

    const result = await executeSubagentRead(
      { subagent_id: subagentId },
      makeContext(ownerConversation),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("still pending");
  });

  test("read extracts text from JSON array content blocks", async () => {
    const manager = getSubagentManager();
    const subagentId = "read-json-array-1";
    injectSubagent(manager, subagentId, ownerConversation, "completed");

    mockGetMessages = (convId: string) => {
      if (convId !== `conv-${subagentId}`) {
        return null;
      }
      return [
        { role: "user", content: "Do the thing" },
        {
          role: "assistant",
          content: [{ type: "text", text: "Here is the result" }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "And more details" }],
        },
      ];
    };

    try {
      const result = await executeSubagentRead(
        { subagent_id: subagentId },
        makeContext(ownerConversation),
      );
      expect(result.isError).toBe(false);
      expect(result.content).toContain("Here is the result");
      expect(result.content).toContain("And more details");
    } finally {
      mockGetMessages = () => null;
    }
  });

  test("read handles plain text content", async () => {
    const manager = getSubagentManager();
    const subagentId = "read-plain-1";
    injectSubagent(manager, subagentId, ownerConversation, "completed");

    mockGetMessages = (convId: string) => {
      if (convId !== `conv-${subagentId}`) {
        return null;
      }
      return [
        {
          role: "assistant",
          content: resolveMessageContentBlocks("Plain text response"),
        },
      ];
    };

    try {
      const result = await executeSubagentRead(
        { subagent_id: subagentId },
        makeContext(ownerConversation),
      );
      expect(result.isError).toBe(false);
      expect(result.content).toBe("Plain text response");
    } finally {
      mockGetMessages = () => null;
    }
  });

  test("read handles string JSON content", async () => {
    const manager = getSubagentManager();
    const subagentId = "read-str-json-1";
    injectSubagent(manager, subagentId, ownerConversation, "completed");

    mockGetMessages = (convId: string) => {
      if (convId !== `conv-${subagentId}`) {
        return null;
      }
      return [
        {
          role: "assistant",
          content: resolveMessageContentBlocks(
            JSON.stringify("A JSON string value"),
          ),
        },
      ];
    };

    try {
      const result = await executeSubagentRead(
        { subagent_id: subagentId },
        makeContext(ownerConversation),
      );
      expect(result.isError).toBe(false);
      expect(result.content).toBe("A JSON string value");
    } finally {
      mockGetMessages = () => null;
    }
  });

  test("read skips non-text content blocks", async () => {
    const manager = getSubagentManager();
    const subagentId = "read-skip-blocks-1";
    injectSubagent(manager, subagentId, ownerConversation, "completed");

    mockGetMessages = (convId: string) => {
      if (convId !== `conv-${subagentId}`) {
        return null;
      }
      return [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "tool-1", name: "bash", input: {} },
            { type: "text", text: "Actual output" },
          ],
        },
      ];
    };

    try {
      const result = await executeSubagentRead(
        { subagent_id: subagentId },
        makeContext(ownerConversation),
      );
      expect(result.isError).toBe(false);
      expect(result.content).toBe("Actual output");
      expect(result.content).not.toContain("tool_use");
    } finally {
      mockGetMessages = () => null;
    }
  });

  test("read returns no-output message when only user/tool messages exist", async () => {
    const manager = getSubagentManager();
    const subagentId = "read-no-output-1";
    injectSubagent(manager, subagentId, ownerConversation, "completed");

    mockGetMessages = (convId: string) => {
      if (convId !== `conv-${subagentId}`) {
        return null;
      }
      return [
        { role: "user", content: "Do something" },
        { role: "tool", content: "tool result" },
      ];
    };

    try {
      const result = await executeSubagentRead(
        { subagent_id: subagentId },
        makeContext(ownerConversation),
      );
      expect(result.isError).toBe(false);
      expect(result.content).toContain("no text output");
    } finally {
      mockGetMessages = () => null;
    }
  });

  test("read returns error when no messages in DB", async () => {
    const manager = getSubagentManager();
    const subagentId = "read-empty-db-1";
    injectSubagent(manager, subagentId, ownerConversation, "completed");

    mockGetMessages = () => [];

    try {
      const result = await executeSubagentRead(
        { subagent_id: subagentId },
        makeContext(ownerConversation),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("No messages found");
    } finally {
      mockGetMessages = () => null;
    }
  });

  test("read returns error when getMessages returns null", async () => {
    const manager = getSubagentManager();
    const subagentId = "read-null-db-1";
    injectSubagent(manager, subagentId, ownerConversation, "completed");

    mockGetMessages = () => null;

    const result = await executeSubagentRead(
      { subagent_id: subagentId },
      makeContext(ownerConversation),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("No messages found");
  });

  test("read works for failed subagent (terminal state)", async () => {
    const manager = getSubagentManager();
    const subagentId = "read-failed-1";
    injectSubagent(manager, subagentId, ownerConversation, "failed");

    mockGetMessages = (convId: string) => {
      if (convId !== `conv-${subagentId}`) {
        return null;
      }
      return [
        {
          role: "assistant",
          content: [{ type: "text", text: "Partial output before failure" }],
        },
      ];
    };

    try {
      const result = await executeSubagentRead(
        { subagent_id: subagentId },
        makeContext(ownerConversation),
      );
      expect(result.isError).toBe(false);
      expect(result.content).toContain("Partial output before failure");
    } finally {
      mockGetMessages = () => null;
    }
  });

  test("read works for aborted subagent (terminal state)", async () => {
    const manager = getSubagentManager();
    const subagentId = "read-aborted-1";
    injectSubagent(manager, subagentId, ownerConversation, "aborted");

    mockGetMessages = (convId: string) => {
      if (convId !== `conv-${subagentId}`) {
        return null;
      }
      return [{ role: "assistant", content: "Output before abort" }];
    };

    try {
      const result = await executeSubagentRead(
        { subagent_id: subagentId },
        makeContext(ownerConversation),
      );
      expect(result.isError).toBe(false);
      expect(result.content).toBe("Output before abort");
    } finally {
      mockGetMessages = () => null;
    }
  });

  test("read with last_n: 1 returns only the last message", async () => {
    const manager = getSubagentManager();
    const subagentId = "read-last-n-1";
    injectSubagent(manager, subagentId, ownerConversation, "completed");

    mockGetMessages = (convId: string) => {
      if (convId !== `conv-${subagentId}`) {
        return null;
      }
      return [
        { role: "assistant", content: "First message" },
        { role: "assistant", content: "Second message" },
        { role: "assistant", content: "Third message" },
      ];
    };

    try {
      const result = await executeSubagentRead(
        { subagent_id: subagentId, last_n: 1 },
        makeContext(ownerConversation),
      );
      expect(result.isError).toBe(false);
      expect(result.content).toBe("Third message");
    } finally {
      mockGetMessages = () => null;
    }
  });

  test("read with last_n: 2 returns last 2 messages joined", async () => {
    const manager = getSubagentManager();
    const subagentId = "read-last-n-2";
    injectSubagent(manager, subagentId, ownerConversation, "completed");

    mockGetMessages = (convId: string) => {
      if (convId !== `conv-${subagentId}`) {
        return null;
      }
      return [
        { role: "assistant", content: "First message" },
        { role: "assistant", content: "Second message" },
        { role: "assistant", content: "Third message" },
      ];
    };

    try {
      const result = await executeSubagentRead(
        { subagent_id: subagentId, last_n: 2 },
        makeContext(ownerConversation),
      );
      expect(result.isError).toBe(false);
      expect(result.content).toBe("Second message\n\nThird message");
    } finally {
      mockGetMessages = () => null;
    }
  });

  test("read with last_n omitted returns all messages", async () => {
    const manager = getSubagentManager();
    const subagentId = "read-last-n-omit";
    injectSubagent(manager, subagentId, ownerConversation, "completed");

    mockGetMessages = (convId: string) => {
      if (convId !== `conv-${subagentId}`) {
        return null;
      }
      return [
        { role: "assistant", content: "First message" },
        { role: "assistant", content: "Second message" },
        { role: "assistant", content: "Third message" },
      ];
    };

    try {
      const result = await executeSubagentRead(
        { subagent_id: subagentId },
        makeContext(ownerConversation),
      );
      expect(result.isError).toBe(false);
      expect(result.content).toBe(
        "First message\n\nSecond message\n\nThird message",
      );
    } finally {
      mockGetMessages = () => null;
    }
  });

  test("read with last_n larger than available returns all messages", async () => {
    const manager = getSubagentManager();
    const subagentId = "read-last-n-large";
    injectSubagent(manager, subagentId, ownerConversation, "completed");

    mockGetMessages = (convId: string) => {
      if (convId !== `conv-${subagentId}`) {
        return null;
      }
      return [
        { role: "assistant", content: "First message" },
        { role: "assistant", content: "Second message" },
      ];
    };

    try {
      const result = await executeSubagentRead(
        { subagent_id: subagentId, last_n: 100 },
        makeContext(ownerConversation),
      );
      expect(result.isError).toBe(false);
      expect(result.content).toBe("First message\n\nSecond message");
    } finally {
      mockGetMessages = () => null;
    }
  });

  test("read concatenates multiple assistant messages", async () => {
    const manager = getSubagentManager();
    const subagentId = "read-multi-1";
    injectSubagent(manager, subagentId, ownerConversation, "completed");

    mockGetMessages = (convId: string) => {
      if (convId !== `conv-${subagentId}`) {
        return null;
      }
      return [
        { role: "assistant", content: "First response" },
        { role: "user", content: "Follow up question" },
        { role: "assistant", content: "Second response" },
        { role: "assistant", content: "Third response" },
      ];
    };

    try {
      const result = await executeSubagentRead(
        { subagent_id: subagentId },
        makeContext(ownerConversation),
      );
      expect(result.isError).toBe(false);
      expect(result.content).toContain("First response");
      expect(result.content).toContain("Second response");
      expect(result.content).toContain("Third response");
      // Messages are joined with double newline
      expect(result.content).toBe(
        "First response\n\nSecond response\n\nThird response",
      );
    } finally {
      mockGetMessages = () => null;
    }
  });

  test("read with last_n: 1 returns only the last message", async () => {
    const manager = getSubagentManager();
    const subagentId = "read-last-n-1";
    injectSubagent(manager, subagentId, ownerConversation, "completed");

    mockGetMessages = (convId: string) => {
      if (convId !== `conv-${subagentId}`) {
        return null;
      }
      return [
        { role: "assistant", content: "First response" },
        { role: "user", content: "Follow up" },
        { role: "assistant", content: "Second response" },
        { role: "assistant", content: "Third response" },
      ];
    };

    try {
      const result = await executeSubagentRead(
        { subagent_id: subagentId, last_n: 1 },
        makeContext(ownerConversation),
      );
      expect(result.isError).toBe(false);
      expect(result.content).toBe("Third response");
    } finally {
      mockGetMessages = () => null;
    }
  });

  test("read with last_n: 2 returns last two messages", async () => {
    const manager = getSubagentManager();
    const subagentId = "read-last-n-2";
    injectSubagent(manager, subagentId, ownerConversation, "completed");

    mockGetMessages = (convId: string) => {
      if (convId !== `conv-${subagentId}`) {
        return null;
      }
      return [
        { role: "assistant", content: "First response" },
        { role: "user", content: "Follow up" },
        { role: "assistant", content: "Second response" },
        { role: "assistant", content: "Third response" },
      ];
    };

    try {
      const result = await executeSubagentRead(
        { subagent_id: subagentId, last_n: 2 },
        makeContext(ownerConversation),
      );
      expect(result.isError).toBe(false);
      expect(result.content).toBe("Second response\n\nThird response");
    } finally {
      mockGetMessages = () => null;
    }
  });

  test("read without last_n returns all messages", async () => {
    const manager = getSubagentManager();
    const subagentId = "read-no-last-n-1";
    injectSubagent(manager, subagentId, ownerConversation, "completed");

    mockGetMessages = (convId: string) => {
      if (convId !== `conv-${subagentId}`) {
        return null;
      }
      return [
        { role: "assistant", content: "First response" },
        { role: "assistant", content: "Second response" },
        { role: "assistant", content: "Third response" },
      ];
    };

    try {
      const result = await executeSubagentRead(
        { subagent_id: subagentId },
        makeContext(ownerConversation),
      );
      expect(result.isError).toBe(false);
      expect(result.content).toBe(
        "First response\n\nSecond response\n\nThird response",
      );
    } finally {
      mockGetMessages = () => null;
    }
  });

  test("read with last_n larger than available messages returns all", async () => {
    const manager = getSubagentManager();
    const subagentId = "read-last-n-big-1";
    injectSubagent(manager, subagentId, ownerConversation, "completed");

    mockGetMessages = (convId: string) => {
      if (convId !== `conv-${subagentId}`) {
        return null;
      }
      return [
        { role: "assistant", content: "First response" },
        { role: "assistant", content: "Second response" },
      ];
    };

    try {
      const result = await executeSubagentRead(
        { subagent_id: subagentId, last_n: 100 },
        makeContext(ownerConversation),
      );
      expect(result.isError).toBe(false);
      expect(result.content).toBe("First response\n\nSecond response");
    } finally {
      mockGetMessages = () => null;
    }
  });
});

// ── Read stats footer (machine truth envelope) ──────────────────────

describe("Subagent read stats footer", () => {
  const ownerConversation = "read-stats-owner";

  function stubOutput(subagentId: string, text: string) {
    mockGetMessages = (convId: string) =>
      convId === `conv-${subagentId}`
        ? [{ role: "assistant", content: [{ type: "text", text }] }]
        : null;
  }

  test("reports what the subagent actually ran alongside its output", async () => {
    const manager = getSubagentManager();
    const subagentId = "read-stats-1";
    injectSubagent(manager, subagentId, ownerConversation, "completed", {
      stats: { calls: 5, succeeded: 4, filesWritten: 2 },
    });
    stubOutput(subagentId, "Refactored the parser.");

    try {
      const result = await executeSubagentRead(
        { subagent_id: subagentId },
        makeContext(ownerConversation),
      );
      expect(result.isError).toBe(false);
      expect(result.content).toBe(
        "Refactored the parser.\n\n[stats: 5 tool calls, 4 succeeded, files written via file_write/file_edit: 2]",
      );
    } finally {
      mockGetMessages = () => null;
    }
  });

  test("a zero-call subagent's output carries the unverified warning", async () => {
    const manager = getSubagentManager();
    const subagentId = "read-stats-zero";
    injectSubagent(manager, subagentId, ownerConversation, "completed", {
      stats: { calls: 0, succeeded: 0, filesWritten: 0 },
    });
    stubOutput(subagentId, "I ran the tests and they all passed.");

    try {
      const result = await executeSubagentRead(
        { subagent_id: subagentId },
        makeContext(ownerConversation),
      );
      expect(result.content).toContain("I ran the tests and they all passed.");
      expect(result.content).toContain(
        "[stats: no tools were used by this subagent; treat any claims of executed work as unverified]",
      );
    } finally {
      mockGetMessages = () => null;
    }
  });

  test("the footer also lands on a subagent that produced no text", async () => {
    const manager = getSubagentManager();
    const subagentId = "read-stats-silent";
    injectSubagent(manager, subagentId, ownerConversation, "completed", {
      stats: { calls: 3, succeeded: 3, filesWritten: 1 },
    });
    mockGetMessages = () => [{ role: "user", content: "go" }];

    try {
      const result = await executeSubagentRead(
        { subagent_id: subagentId },
        makeContext(ownerConversation),
      );
      expect(result.content).toContain("no text output");
      expect(result.content).toContain(
        "[stats: 3 tool calls, 3 succeeded, files written via file_write/file_edit: 1]",
      );
    } finally {
      mockGetMessages = () => null;
    }
  });

  test("a live subagent that never recorded a run claims nothing", async () => {
    const manager = getSubagentManager();
    const subagentId = "read-stats-none";
    injectSubagent(manager, subagentId, ownerConversation, "aborted");
    stubOutput(subagentId, "Partial output.");

    try {
      const result = await executeSubagentRead(
        { subagent_id: subagentId },
        makeContext(ownerConversation),
      );
      // No harvest ever happened, so there is nothing measured to report, and
      // nothing was lost either, so it must not claim the counters are gone.
      expect(result.content).toBe("Partial output.");
      expect(result.content).not.toContain("[stats:");
    } finally {
      mockGetMessages = () => null;
    }
  });

  test("a follow-up turn's tool calls land in the footer, not just the run's", async () => {
    const manager = getSubagentManager();
    const subagentId = "read-stats-queued";
    injectSubagent(manager, subagentId, ownerConversation, "completed", {
      stats: { calls: 2, succeeded: 2, filesWritten: 0 },
    });
    // Guidance queued during the run drains after the run harvested, into the
    // same retained conversation, so the counters keep moving past that
    // reading. The read has to look again rather than quote the harvest.
    const live = liveToolStats(manager, subagentId);
    live.calls += 3;
    live.succeeded += 2;
    live.filesWritten.add("/queued-turn.md");
    stubOutput(subagentId, "Applied the follow-up guidance.");

    try {
      const result = await executeSubagentRead(
        { subagent_id: subagentId },
        makeContext(ownerConversation),
      );
      expect(result.content).toBe(
        "Applied the follow-up guidance.\n\n[stats: 5 tool calls, 4 succeeded, files written via file_write/file_edit: 1]",
      );
    } finally {
      mockGetMessages = () => null;
    }
  });

  test("a subagent rebuilt from its row reports its counters unavailable", async () => {
    const manager = getSubagentManager();
    const subagentId = "read-stats-rehydrated";
    injectSubagent(manager, subagentId, ownerConversation, "completed", {
      rehydrated: true,
    });
    stubOutput(subagentId, "Output from before the restart.");

    try {
      const result = await executeSubagentRead(
        { subagent_id: subagentId },
        makeContext(ownerConversation),
      );
      // Being in the manager is not evidence of a live run: this entry was
      // rebuilt from the durable row, which carries no counters at all.
      expect(manager.getState(subagentId)).toBeDefined();
      expect(result.content).toBe(
        "Output from before the restart.\n\n[stats: unavailable (tool counters are not retained for this subagent)]",
      );
    } finally {
      mockGetMessages = () => null;
    }
  });
});

// ── Reads against a queued follow-up turn ───────────────────────────

describe("Subagent read while a queued follow-up turn is still in flight", () => {
  const ownerConversation = "read-queued-owner";

  function stubOutput(subagentId: string, texts: () => string[]) {
    mockGetMessages = (convId: string) =>
      convId === `conv-${subagentId}`
        ? texts().map((text) => ({
            role: "assistant",
            content: [{ type: "text", text }],
          }))
        : null;
  }

  test("waits for the queued turn rather than answering from the run before it", async () => {
    const manager = getSubagentManager();
    const subagentId = "read-queued-settles";
    injectSubagent(manager, subagentId, ownerConversation, "completed", {
      stats: { calls: 2, succeeded: 2, filesWritten: 0 },
    });
    const drain = queuedFollowUpTurn(manager, subagentId);
    const live = liveToolStats(manager, subagentId);
    let followUpLanded = false;
    stubOutput(subagentId, () =>
      followUpLanded
        ? ["Initial run output.", "Applied the follow-up guidance."]
        : ["Initial run output."],
    );

    // The drain picks the message up, runs the turn, and only then does the
    // transcript and the counters cover it.
    setTimeout(() => {
      drain.queueDepth = 0;
      drain.processing = true;
    }, 10);
    setTimeout(() => {
      live.calls += 3;
      live.succeeded += 3;
      live.filesWritten.add("/follow-up.md");
      followUpLanded = true;
      drain.processing = false;
    }, 30);

    try {
      const result = await executeSubagentRead(
        { subagent_id: subagentId },
        makeContext(ownerConversation),
      );
      expect(result.content).toBe(
        "Initial run output.\n\nApplied the follow-up guidance.\n\n" +
          "[stats: 5 tool calls, 5 succeeded, files written via file_write/file_edit: 1]",
      );
      expect(result.content).not.toContain("still processing");
    } finally {
      mockGetMessages = () => null;
    }
  });

  test("a queue the drain has taken but not yet started is not read as finished", async () => {
    const manager = getSubagentManager();
    const subagentId = "read-queued-dispatch-gap";
    injectSubagent(manager, subagentId, ownerConversation, "completed", {
      stats: { calls: 1, succeeded: 1, filesWritten: 0 },
    });
    const drain = queuedFollowUpTurn(manager, subagentId);
    let followUpLanded = false;
    stubOutput(subagentId, () =>
      followUpLanded ? ["Guidance applied."] : ["Initial run output."],
    );

    // The gap between the drain shifting the message off the queue and the
    // turn taking the processing lock: nothing is queued and nothing is
    // running, yet the turn is on its way.
    drain.queueDepth = 0;
    drain.processing = false;
    setTimeout(() => {
      drain.processing = true;
    }, 15);
    setTimeout(() => {
      followUpLanded = true;
      drain.processing = false;
    }, 40);

    try {
      const result = await executeSubagentRead(
        { subagent_id: subagentId },
        makeContext(ownerConversation),
      );
      expect(result.content).toContain("Guidance applied.");
      expect(result.content).not.toContain("Initial run output.");
    } finally {
      mockGetMessages = () => null;
    }
  });

  test("a turn still running at the deadline is reported as unfinished, not as the result", async () => {
    const manager = getSubagentManager();
    const subagentId = "read-queued-still-running";
    injectSubagent(manager, subagentId, ownerConversation, "completed", {
      stats: { calls: 2, succeeded: 2, filesWritten: 1 },
    });
    const drain = queuedFollowUpTurn(manager, subagentId);
    // The guidance turn outlives the read's patience, as a real one does.
    drain.queueDepth = 0;
    drain.processing = true;
    stubOutput(subagentId, () => ["Initial run output."]);

    try {
      const result = await executeSubagentRead(
        { subagent_id: subagentId },
        makeContext(ownerConversation),
      );
      expect(result.isError).toBe(false);
      // What there is so far, said to be what there is so far: the counts
      // are an interim reading and the parent is told to come back.
      expect(result.content).toBe(
        "Initial run output.\n\n" +
          `${SUBAGENT_READ_STILL_PROCESSING}\n\n` +
          "[stats: 2 tool calls, 2 succeeded, files written via file_write/file_edit: 1]",
      );
    } finally {
      drain.processing = false;
      mockGetMessages = () => null;
    }
  }, 15_000);

  test("a subagent that had nothing queued is read without waiting", async () => {
    const manager = getSubagentManager();
    const subagentId = "read-queued-none";
    injectSubagent(manager, subagentId, ownerConversation, "completed", {
      stats: { calls: 1, succeeded: 1, filesWritten: 0 },
    });
    stubOutput(subagentId, () => ["Ran to completion."]);

    try {
      const startedAt = Date.now();
      const result = await executeSubagentRead(
        { subagent_id: subagentId },
        makeContext(ownerConversation),
      );
      expect(Date.now() - startedAt).toBeLessThan(500);
      expect(result.content).toBe(
        "Ran to completion.\n\n[stats: 1 tool call, 1 succeeded, files written via file_write/file_edit: 0]",
      );
    } finally {
      mockGetMessages = () => null;
    }
  });
});

// ── Abort success path details ──────────────────────────────────────

describe("Subagent abort success responses", () => {
  test("abort returns subagentId and aborted status on success", async () => {
    const manager = getSubagentManager();
    const subagentId = "abort-detail-1";
    injectSubagent(manager, subagentId, "abort-owner-sess", "running");

    const result = await executeSubagentAbort(
      { subagent_id: subagentId },
      makeContext("abort-owner-sess"),
    );
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.subagentId).toBe(subagentId);
    expect(parsed.status).toBe("aborted");
    expect(parsed.message).toContain("aborted successfully");
  });

  test("abort fails for already-completed subagent", async () => {
    const manager = getSubagentManager();
    const subagentId = "abort-completed-1";
    injectSubagent(manager, subagentId, "abort-owner-sess", "completed");

    const result = await executeSubagentAbort(
      { subagent_id: subagentId },
      makeContext("abort-owner-sess"),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Could not abort");
  });

  test("abort fails for already-failed subagent", async () => {
    const manager = getSubagentManager();
    const subagentId = "abort-failed-1";
    injectSubagent(manager, subagentId, "abort-owner-sess", "failed");

    const result = await executeSubagentAbort(
      { subagent_id: subagentId },
      makeContext("abort-owner-sess"),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Could not abort");
  });
});

// ── Label-based subagent lookup ────────────────────────────────────

describe("Label-based subagent lookup", () => {
  const parentConversation = "label-test-sess";
  const subagentId = "label-sub-1";

  // Inject a subagent with a specific label for the test suite.
  const manager = getSubagentManager();
  injectSubagent(manager, subagentId, parentConversation, "running", {
    config: {
      id: subagentId,
      parentConversationId: parentConversation,
      label: "Research task",
      objective: "research something",
    },
  });

  test("subagent_status with label returns status", async () => {
    const result = await executeSubagentStatus(
      { label: "Research task" },
      makeContext(parentConversation),
    );
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.subagentId).toBe(subagentId);
    expect(parsed.label).toBe("Research task");
    expect(parsed.status).toBe("running");
  });

  test("subagent_status with lowercase label (case-insensitive)", async () => {
    const result = await executeSubagentStatus(
      { label: "research task" },
      makeContext(parentConversation),
    );
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.subagentId).toBe(subagentId);
  });

  test("subagent_status with nonexistent label returns error", async () => {
    const result = await executeSubagentStatus(
      { label: "nonexistent" },
      makeContext(parentConversation),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("No subagent found");
  });

  test("subagent_message with label succeeds", async () => {
    const result = await executeSubagentMessage(
      { label: "Research task", content: "hello" },
      makeContext(parentConversation),
    );
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.subagentId).toBe(subagentId);
    expect(parsed.message).toContain("Message sent");
  });

  test("subagent_read with label on completed subagent returns output", async () => {
    // Inject a completed subagent for the read test.
    const readSubId = "label-read-sub-1";
    injectSubagent(manager, readSubId, parentConversation, "completed", {
      config: {
        id: readSubId,
        parentConversationId: parentConversation,
        label: "Read task",
        objective: "read something",
      },
    });

    mockGetMessages = (convId: string) => {
      if (convId !== `conv-${readSubId}`) {
        return null;
      }
      return [
        {
          role: "assistant",
          content: [{ type: "text", text: "Research findings here" }],
        },
      ];
    };

    try {
      const result = await executeSubagentRead(
        { label: "Read task" },
        makeContext(parentConversation),
      );
      expect(result.isError).toBe(false);
      expect(result.content).toContain("Research findings here");
    } finally {
      mockGetMessages = () => null;
    }
  });
});

// ── Label collision & dispose guard ─────────────────────────────────

describe("Label collision and dispose guard", () => {
  test("disposing second subagent with same label keeps first reachable by label", () => {
    const manager = getSubagentManager();
    const parentConversation = "label-collision-sess";
    const firstId = "collision-sub-1";
    const secondId = "collision-sub-2";
    const sharedLabel = "Shared Worker";

    // Inject two subagents with the same label — second overwrites label index.
    injectSubagent(manager, firstId, parentConversation, "running", {
      config: {
        id: firstId,
        parentConversationId: parentConversation,
        label: sharedLabel,
        objective: "first task",
      },
    });
    injectSubagent(manager, secondId, parentConversation, "completed", {
      config: {
        id: secondId,
        parentConversationId: parentConversation,
        label: sharedLabel,
        objective: "second task",
      },
    });

    // Label should currently resolve to the second subagent.
    expect(manager.getByLabel(sharedLabel, parentConversation)?.config.id).toBe(
      secondId,
    );

    // Dispose the FIRST subagent — its label was already overwritten,
    // so the label index entry (pointing to second) must survive.
    manager.dispose(firstId);

    const afterDispose = manager.getByLabel(sharedLabel, parentConversation);
    expect(afterDispose).toBeDefined();
    expect(afterDispose!.config.id).toBe(secondId);

    // The second subagent should still be directly accessible too.
    expect(manager.getState(secondId)).toBeDefined();
    // And the first should be gone.
    expect(manager.getState(firstId)).toBeUndefined();
  });
});

// ── Role-based spawn ──────────────────────────────────────────────

describe("Subagent role-based spawn", () => {
  test("spawn with role 'researcher' passes role to manager", async () => {
    const manager = getSubagentManager();
    const originalSpawn = manager.spawn.bind(manager);
    let capturedConfig: Record<string, unknown> | undefined;

    manager.spawn = async (config: Record<string, unknown>) => {
      capturedConfig = config;
      return "role-researcher-id";
    };

    try {
      const result = await executeSubagentSpawn(
        {
          label: "Research task",
          objective: "Find pricing data",
          role: "researcher",
        },
        makeContext("sess-role-1", { sendToClient: () => {} }),
      );
      expect(result.isError).toBe(false);
      const parsed = JSON.parse(result.content);
      expect(parsed.subagentId).toBe("role-researcher-id");
      expect(capturedConfig).toBeDefined();
      expect(capturedConfig!.role).toBe("researcher");
    } finally {
      manager.spawn = originalSpawn;
    }
  });

  test("spawn without role runs as builder", async () => {
    const manager = getSubagentManager();
    const originalSpawn = manager.spawn.bind(manager);
    let capturedConfig: Record<string, unknown> | undefined;

    manager.spawn = async (config: Record<string, unknown>) => {
      capturedConfig = config;
      return "role-default-id";
    };

    try {
      const result = await executeSubagentSpawn(
        { label: "Unlabelled task", objective: "Do something" },
        makeContext("sess-role-2", { sendToClient: () => {} }),
      );
      expect(result.isError).toBe(false);
      const parsed = JSON.parse(result.content);
      expect(parsed.subagentId).toBe("role-default-id");
      expect(parsed.role).toBe("builder");
      // Naming no role stays write-capable, and says nothing extra about it.
      expect(parsed.roleNote).toBeUndefined();
      expect(capturedConfig).toBeDefined();
      expect(capturedConfig!.role).toBe("builder");
      // And keeps the whole surface: builder imposes no allowlist, so the
      // manager filters nothing for a spawn that named no role.
      expect(SUBAGENT_ROLE_REGISTRY.builder.allowedTools).toBeUndefined();
    } finally {
      manager.spawn = originalSpawn;
    }
  });

  test.each([
    ["planner", "researcher"],
    ["investigator", "researcher"],
    ["coder", "builder"],
    ["general", "builder"],
  ])("legacy role %s spawns a %s", async (legacy, expected) => {
    const manager = getSubagentManager();
    const originalSpawn = manager.spawn.bind(manager);
    let capturedConfig: Record<string, unknown> | undefined;

    manager.spawn = async (config: Record<string, unknown>) => {
      capturedConfig = config;
      return `alias-${legacy}-id`;
    };

    try {
      const result = await executeSubagentSpawn(
        { label: `${legacy} task`, objective: "Do something", role: legacy },
        makeContext(`sess-alias-${legacy}`, { sendToClient: () => {} }),
      );
      expect(result.isError).toBe(false);
      expect(capturedConfig!.role).toBe(expected);
      expect(capturedConfig!.persona).toBeUndefined();

      const parsed = JSON.parse(result.content);
      expect(parsed.role).toBe(expected);
      expect(parsed.roleNote).toContain(legacy);
      expect(parsed.roleNote).toContain(expected);
    } finally {
      manager.spawn = originalSpawn;
    }
  });

  test("the child of a legacy role gets the new type's tool surface", () => {
    // The alias resolves to a type, and the type owns the tools.
    expect(SUBAGENT_ROLE_REGISTRY.researcher.allowedTools).toContain(
      "code_search",
    );
    expect(SUBAGENT_ROLE_REGISTRY.researcher.allowedTools).not.toContain(
      "bash",
    );
    // `general` resolves to builder, and builder is unrestricted exactly as
    // `general` was: a fixed list would drop connectors, MCP tools, and
    // browser and computer use from every spawn that names neither.
    expect(SUBAGENT_ROLE_REGISTRY.builder.allowedTools).toBeUndefined();
  });

  test("an unrecognized role spawns a researcher with the text as persona", async () => {
    const manager = getSubagentManager();
    const originalSpawn = manager.spawn.bind(manager);
    let capturedConfig: Record<string, unknown> | undefined;

    manager.spawn = async (config: Record<string, unknown>) => {
      capturedConfig = config;
      return "role-persona-id";
    };

    try {
      const result = await executeSubagentSpawn(
        {
          label: "Persona task",
          objective: "Assess the filing",
          role: "financial journalist",
        },
        makeContext("sess-role-persona", { sendToClient: () => {} }),
      );
      expect(result.isError).toBe(false);
      expect(capturedConfig!.role).toBe("researcher");
      expect(capturedConfig!.persona).toBe("financial journalist");

      const parsed = JSON.parse(result.content);
      expect(parsed.role).toBe("researcher");
      expect(parsed.roleNote).toContain("financial journalist");
      expect(parsed.roleNote).toContain("persona");
      expect(parsed.roleNote).toContain("builder");
    } finally {
      manager.spawn = originalSpawn;
    }
  });

  test("the persona reaches the child's system prompt", () => {
    const prompt = buildSubagentSystemPrompt(
      {
        id: "sub-persona",
        parentConversationId: "conv-1",
        label: "Persona task",
        objective: "Assess the filing",
        role: "researcher",
        persona: "financial journalist",
      },
      "researcher",
    );
    expect(prompt).toContain(
      "- Persona: act as financial journalist for this task.",
    );
  });

  test("a whitespace-only role is treated as no role at all", async () => {
    const manager = getSubagentManager();
    const originalSpawn = manager.spawn.bind(manager);
    let capturedConfig: Record<string, unknown> | undefined;

    manager.spawn = async (config: Record<string, unknown>) => {
      capturedConfig = config;
      return "role-blank-id";
    };

    try {
      const result = await executeSubagentSpawn(
        { label: "Blank role", objective: "Do something", role: "   " },
        makeContext("sess-role-blank", { sendToClient: () => {} }),
      );
      expect(result.isError).toBe(false);
      expect(capturedConfig!.role).toBe("builder");
      expect(capturedConfig!.persona).toBeUndefined();
      expect(JSON.parse(result.content).roleNote).toBeUndefined();
    } finally {
      manager.spawn = originalSpawn;
    }
  });

  test("a sentence-length role still spawns, bounded, as a researcher persona", async () => {
    const manager = getSubagentManager();
    const originalSpawn = manager.spawn.bind(manager);
    let capturedConfig: Record<string, unknown> | undefined;

    manager.spawn = async (config: Record<string, unknown>) => {
      capturedConfig = config;
      return "role-sentence-id";
    };

    const sentence =
      "You are a meticulous senior staff engineer who reviews every change against the design document and reports every discrepancy, however small.";
    try {
      const result = await executeSubagentSpawn(
        {
          label: "Sentence role",
          objective: "Review the change",
          role: sentence,
        },
        makeContext("sess-role-sentence", { sendToClient: () => {} }),
      );
      expect(result.isError).toBe(false);
      expect(capturedConfig!.role).toBe("researcher");
      expect((capturedConfig!.persona as string).length).toBeLessThan(
        sentence.length,
      );
    } finally {
      manager.spawn = originalSpawn;
    }
  });

  test("spawn tool definition takes role as an unconstrained string", () => {
    const def = findTool("subagent_spawn");
    expect(def).toBeDefined();
    expect(def.input_schema.properties.role).toBeDefined();
    expect(def.input_schema.properties.role.type).toBe("string");
    // Manifest validation runs ahead of the executor, so an enum here would
    // reject the legacy names and personas `resolveSubagentRole` handles. The
    // three types are named in the description instead.
    expect(def.input_schema.properties.role.enum).toBeUndefined();
    for (const type of ["researcher", "builder", "advisor"]) {
      expect(def.input_schema.properties.role.description).toContain(type);
    }
    // role is not required
    expect(def.input_schema.required).not.toContain("role");
  });
});

// ── Output contract ─────────────────────────────────────────────────

describe("Subagent output contract", () => {
  /**
   * Run a spawn with the manager stubbed, reporting both the config it was
   * handed and whether it was called at all (a rejected contract must not
   * spawn).
   */
  async function spawnCapturing(
    input: Record<string, unknown>,
    contextExtras: Record<string, unknown> = {},
  ): Promise<{
    result: { content: string; isError: boolean };
    config: Record<string, unknown> | undefined;
  }> {
    const manager = getSubagentManager();
    const originalSpawn = manager.spawn.bind(manager);
    let capturedConfig: Record<string, unknown> | undefined;
    manager.spawn = async (config: Record<string, unknown>) => {
      capturedConfig = config;
      return "contract-subagent-id";
    };
    try {
      const result = await executeSubagentSpawn(
        input,
        makeContext("sess-contract", {
          sendToClient: () => {},
          ...contextExtras,
        }),
      );
      return { result, config: capturedConfig };
    } finally {
      manager.spawn = originalSpawn;
    }
  }

  test.each([
    ["report", "builder"],
    ["verdict", "researcher"],
    ["artifact", "builder"],
  ])("output_contract %s is accepted for a %s", async (contract, role) => {
    const { result, config } = await spawnCapturing({
      label: "Contract task",
      objective: "Do it",
      role,
      output_contract: contract,
    });
    expect(result.isError).toBe(false);
    expect(config!.outputContract).toBe(contract);
  });

  test("an unknown output_contract fails validation without spawning", async () => {
    const { result, config } = await spawnCapturing({
      label: "Bad contract",
      objective: "Do it",
      role: "researcher",
      output_contract: "checklist",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Invalid input for tool "subagent_spawn"');
    expect(result.content).toContain("output_contract");
    expect(config).toBeUndefined();
  });

  test("verdict on a builder returns a mismatch error instead of spawning", async () => {
    const { result, config } = await spawnCapturing({
      label: "Check it",
      objective: "Verify the migration ran",
      role: "builder",
      output_contract: "verdict",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("only available to researcher-typed");
    expect(result.content).toContain('resolved to "builder"');
    expect(config).toBeUndefined();
  });

  test("verdict on a spawn that names no role is a mismatch (the default is builder)", async () => {
    const { result, config } = await spawnCapturing({
      label: "Check it",
      objective: "Verify the migration ran",
      output_contract: "verdict",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('role "researcher"');
    expect(config).toBeUndefined();
  });

  test("verdict rides the researcher fallback an unknown role resolves to", async () => {
    const { result, config } = await spawnCapturing({
      label: "Check it",
      objective: "Verify the migration ran",
      role: "release auditor",
      output_contract: "verdict",
    });
    expect(result.isError).toBe(false);
    expect(config!.role).toBe("researcher");
    expect(config!.outputContract).toBe("verdict");
  });

  test("artifact on a researcher returns a mismatch error instead of spawning", async () => {
    const { result, config } = await spawnCapturing({
      label: "Write it",
      objective: "Produce the migration file",
      role: "researcher",
      output_contract: "artifact",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("only available to builder-typed");
    expect(config).toBeUndefined();
  });

  test("the advisor takes no output contract and never consults", async () => {
    const manager = getSubagentManager();
    const originalAwait = manager.spawnAndAwait.bind(manager);
    let consulted = false;
    manager.spawnAndAwait = async () => {
      consulted = true;
      return "advice";
    };
    try {
      const result = await executeSubagentSpawn(
        {
          label: "Consult",
          objective: "Check the plan",
          role: "advisor",
          output_contract: "verdict",
        },
        makeContext("sess-contract-advisor", { sendToClient: () => {} }),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("does not apply to the advisor");
      expect(consulted).toBe(false);
    } finally {
      manager.spawnAndAwait = originalAwait;
    }
  });

  test("an explicit report is rejected for the advisor too", async () => {
    const manager = getSubagentManager();
    const originalAwait = manager.spawnAndAwait.bind(manager);
    let consulted = false;
    manager.spawnAndAwait = async () => {
      consulted = true;
      return "advice";
    };
    try {
      const result = await executeSubagentSpawn(
        {
          label: "Consult",
          objective: "Check the plan",
          role: "advisor",
          output_contract: "report",
        },
        makeContext("sess-contract-advisor-report", {
          sendToClient: () => {},
        }),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("does not apply to the advisor");
      expect(result.content).toContain('"report"');
      expect(consulted).toBe(false);
    } finally {
      manager.spawnAndAwait = originalAwait;
    }
  });

  test("a null contract reads as omitted and reaches the advisor branch", async () => {
    const result = await executeSubagentSpawn(
      {
        label: "Consult",
        objective: "Check the plan",
        role: "advisor",
        output_contract: null,
      },
      makeContext("sess-contract-advisor-none", { sendToClient: () => {} }),
    );
    // The advisor branch runs and reports its own missing-parent notice, so
    // the contract check waved this spawn through.
    expect(result.content).toContain("advisor unavailable");
    expect(result.content).not.toContain("does not apply to the advisor");
  });

  test("verdict defaults the child to the cost-optimized tier", async () => {
    const { result, config } = await spawnCapturing(
      {
        label: "Check it",
        objective: "Verify each acceptance criterion",
        role: "researcher",
        output_contract: "verdict",
      },
      { invokingCallSite: "mainAgent" },
    );
    expect(result.isError).toBe(false);
    // Ahead of the mainAgent default (balanced) this spawn would otherwise
    // inherit, and unforced like every other inheritance rung.
    expect(config!.overrideProfile).toBe("cost-optimized");
    expect(config!.forceOverrideProfile).toBeUndefined();
  });

  test("a subagentSpawn call-site pin outranks the verdict preset", async () => {
    // A pinned call site is a user's choice about delegated work; the verdict
    // tier is this tool's preset. An override wins over a call-site profile
    // outright under single-winner resolution, so the preset must not be
    // forwarded as one here or the pin is silently downgraded.
    setConfig("llm", {
      ...BASE_LLM_CONFIG,
      callSites: { subagentSpawn: { profile: "quality-optimized" } },
    });
    try {
      const { result, config } = await spawnCapturing(
        {
          label: "Check it",
          objective: "Verify each acceptance criterion",
          role: "researcher",
          output_contract: "verdict",
        },
        { invokingCallSite: "mainAgent" },
      );
      expect(result.isError).toBe(false);
      // No override at all, so the child resolves on the pinned call site.
      expect(config!.overrideProfile).toBeUndefined();
      expect(config!.forceOverrideProfile).toBeUndefined();
    } finally {
      setConfig("llm", BASE_LLM_CONFIG);
    }
  });

  test("the verdict preset still applies when the call site is unpinned", async () => {
    setConfig("llm", {
      ...BASE_LLM_CONFIG,
      callSites: { mainAgent: { profile: "quality-optimized" } },
    });
    try {
      const { config } = await spawnCapturing(
        {
          label: "Check it",
          objective: "Verify each acceptance criterion",
          role: "researcher",
          output_contract: "verdict",
        },
        { invokingCallSite: "mainAgent" },
      );
      // A pin on some other call site says nothing about delegated checks.
      expect(config!.overrideProfile).toBe("cost-optimized");
    } finally {
      setConfig("llm", BASE_LLM_CONFIG);
    }
  });

  test("an explicit inference_profile beats the verdict default", async () => {
    const { config } = await spawnCapturing({
      label: "Check it",
      objective: "Verify each acceptance criterion",
      role: "researcher",
      output_contract: "verdict",
      inference_profile: "quality-optimized",
    });
    expect(config!.overrideProfile).toBe("quality-optimized");
    expect(config!.forceOverrideProfile).toBe(true);
  });

  test("a report contract changes neither the profile nor the framing", async () => {
    const { config } = await spawnCapturing(
      {
        label: "Research it",
        objective: "Find the pricing data",
        role: "researcher",
        output_contract: "report",
      },
      { invokingCallSite: "mainAgent" },
    );
    // A report is the default contract, so it applies no preset of its own and
    // leaves the child on the subagentSpawn default like any other spawn.
    expect(config!.overrideProfile).toBeUndefined();
    expect(
      buildSubagentSystemPrompt(
        {
          id: "sub-report",
          parentConversationId: "conv-1",
          label: "Research it",
          objective: "Find the pricing data",
          outputContract: "report",
        },
        "researcher",
      ),
    ).not.toContain("Output contract");
  });

  test("the verdict contract reaches the child's system prompt", () => {
    const prompt = buildSubagentSystemPrompt(
      {
        id: "sub-verdict",
        parentConversationId: "conv-1",
        label: "Check it",
        objective: "Verify each acceptance criterion",
        outputContract: "verdict",
      },
      "researcher",
    );
    expect(prompt).toContain("- Output contract: ");
    expect(prompt).toContain("return PASS or FAIL plus the exact evidence");
    expect(prompt).toContain("CANNOT VERIFY");
  });

  test("the artifact contract reaches the child's system prompt", () => {
    const prompt = buildSubagentSystemPrompt(
      {
        id: "sub-artifact",
        parentConversationId: "conv-1",
        label: "Write it",
        objective: "Produce the migration file",
        outputContract: "artifact",
      },
      "builder",
    );
    expect(prompt).toContain("Your deliverable is the artifact itself.");
  });

  test("spawn tool definition declares output_contract", () => {
    const def = findTool("subagent_spawn");
    expect(def.input_schema.properties.output_contract).toBeDefined();
    expect(def.input_schema.properties.output_contract.type).toBe("string");
    expect(def.input_schema.properties.output_contract.enum).toEqual([
      "report",
      "verdict",
      "artifact",
    ]);
    expect(def.input_schema.required).not.toContain("output_contract");
  });
});

// ── Advisor-role consult ────────────────────────────────────────────

describe("Subagent advisor-role consult", () => {
  type Block = { type: string; [k: string]: unknown };
  type CapturedAwait = {
    config: Record<string, unknown>;
    opts?: {
      signal?: AbortSignal;
      onText?: (chunk: string) => void;
      onProgress?: () => void;
    };
  };

  /**
   * Stub `manager.spawnAndAwait` to capture the config + opts and resolve to
   * `advice`. Restores the original on cleanup. Returns the captured-call ref.
   *
   * A function `advice` receives the sender the consult passed in, so a test
   * can drive the child's event stream (the tool activity the consult counts)
   * before deciding what the run returns.
   */
  function stubAwait(
    advice:
      | string
      | ((send: (msg: Record<string, unknown>) => void) => Promise<string>),
  ): {
    captured: { current?: CapturedAwait };
    restore: () => void;
  } {
    const manager = getSubagentManager();
    const original = manager.spawnAndAwait.bind(manager);
    const captured: { current?: CapturedAwait } = {};
    manager.spawnAndAwait = (async (
      config: Record<string, unknown>,
      send: (msg: Record<string, unknown>) => void,
      opts?: CapturedAwait["opts"],
    ) => {
      captured.current = { config, opts };
      return typeof advice === "function" ? await advice(send) : advice;
    }) as unknown as typeof manager.spawnAndAwait;
    return {
      captured,
      restore: () => {
        manager.spawnAndAwait = original;
      },
    };
  }

  test("advisor role returns guidance synchronously as the tool result", async () => {
    mockFindConversation = () => ({
      messages: [{ role: "user", content: [{ type: "text", text: "Help" }] }],
      getCurrentSystemPrompt: () => "PARENT SYSTEM PROMPT",
    });
    const { captured, restore } = stubAwait("Here is my advice.");
    try {
      const result = await executeSubagentSpawn(
        {
          label: "Consult",
          objective: "advise me",
          role: "advisor",
        },
        makeContext("advisor-sess-1", { sendToClient: () => {} }),
      );
      expect(result.isError).toBe(false);
      expect(result.content).toBe("Here is my advice.");
      // Ran synchronously through spawnAndAwait, not fire-and-forget spawn.
      expect(captured.current).toBeDefined();
      expect(captured.current!.config.fork).toBe(true);
      expect(captured.current!.config.role).toBe("advisor");
      // The advisor is a ROLE, not an `LLMCallSiteEnum` value, so its usage
      // lands under `subagentSpawn` like any other subagent. The declared
      // spawn mode is what separates it from a plain fork in cost telemetry.
      expect(captured.current!.config.spawnMode).toBe("advisor_consult");
      // Framing embeds the executor prompt as advisor system prompt context.
      expect(captured.current!.config.systemPromptOverride).toContain(
        "PARENT SYSTEM PROMPT",
      );
      // The situational context pack must never ride display surfaces: the
      // system prompt stays minimal and `objective` (rendered verbatim by the
      // subagent detail panel) stays the concise advice request. Only the
      // non-display `requestText` may carry the pack.
      expect(captured.current!.config.systemPromptOverride).not.toContain(
        "<agent_environment>",
      );
      expect(captured.current!.config.objective).not.toContain(
        "<agent_environment>",
      );
      expect(captured.current!.config.requestText).toContain("advise me");
    } finally {
      restore();
      mockFindConversation = () => undefined;
    }
  });

  test("advisor inherits and sanitizes the parent transcript", async () => {
    // Parent in-memory history carries a thinking block (must be stripped) and
    // a completed tool_use/tool_result pair (must be preserved).
    mockFindConversation = () => ({
      messages: [
        { role: "user", content: [{ type: "text", text: "Do the task" }] },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "secret reasoning" },
            { type: "text", text: "Working on it" },
            { type: "tool_use", id: "t1", name: "bash", input: {} },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
        },
      ],
      getCurrentSystemPrompt: () => "SYS",
    });
    const { captured, restore } = stubAwait("advice");
    try {
      await executeSubagentSpawn(
        { label: "Consult", objective: "x", role: "advisor" },
        makeContext("advisor-sess-2", { sendToClient: () => {} }),
      );
      const msgs = captured.current!.config.parentMessages as Array<{
        role: string;
        content: Block[];
      }>;
      const allBlocks = msgs.flatMap((m) => m.content);
      // Thinking is stripped; the completed tool_use/tool_result pair survives.
      expect(allBlocks.some((b) => b.type === "thinking")).toBe(false);
      expect(allBlocks.some((b) => b.type === "tool_use")).toBe(true);
      expect(allBlocks.some((b) => b.type === "tool_result")).toBe(true);
    } finally {
      restore();
      mockFindConversation = () => undefined;
    }
  });

  test("in-flight plan is visible to the advisor with no dangling tool_use", async () => {
    // The in-memory snapshot ends on the user turn — the in-flight assistant
    // turn (this turn's plan + the pending advisor tool_use) lives only in the
    // DB at consult time. It must be appended, and its dangling tool_use stripped.
    mockFindConversation = () => ({
      messages: [
        { role: "user", content: [{ type: "text", text: "Plan the work" }] },
      ],
      getCurrentSystemPrompt: () => "SYS",
    });
    mockGetMessages = (convId: string) => {
      if (convId !== "advisor-sess-3") {
        return null;
      }
      return [
        {
          role: "user",
          content: [{ type: "text", text: "Plan the work" }],
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "My plan: step 1, step 2." },
            {
              type: "tool_use",
              id: "adv-1",
              name: "subagent_spawn",
              input: {},
            },
          ],
        },
      ];
    };
    const { captured, restore } = stubAwait("advice");
    try {
      await executeSubagentSpawn(
        { label: "Consult", objective: "x", role: "advisor" },
        makeContext("advisor-sess-3", { sendToClient: () => {} }),
      );
      const msgs = captured.current!.config.parentMessages as Array<{
        role: string;
        content: Block[];
      }>;
      const allBlocks = msgs.flatMap((m) => m.content);
      // The plan text the model wrote this turn is present in the consult.
      expect(
        allBlocks.some(
          (b) => b.type === "text" && b.text === "My plan: step 1, step 2.",
        ),
      ).toBe(true);
      // No dangling tool_use is sent.
      expect(allBlocks.some((b) => b.type === "tool_use")).toBe(false);
    } finally {
      restore();
      mockFindConversation = () => undefined;
      mockGetMessages = () => null;
    }
  });

  test("advisor defaults to llm.advisorProfile (forced)", async () => {
    mockFindConversation = () => ({
      messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      getCurrentSystemPrompt: () => "SYS",
    });
    const { captured, restore } = stubAwait("advice");
    try {
      await executeSubagentSpawn(
        { label: "Consult", objective: "x", role: "advisor" },
        makeContext("advisor-sess-4", { sendToClient: () => {} }),
      );
      expect(captured.current!.config.overrideProfile).toBe("frontier");
      expect(captured.current!.config.forceOverrideProfile).toBe(true);
    } finally {
      restore();
      mockFindConversation = () => undefined;
    }
  });

  test("advisor uses llm.advisorProfile, not the conversation pin", async () => {
    mockFindConversation = () => ({
      messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      getCurrentSystemPrompt: () => "SYS",
    });
    mockConversationOverrideProfile = "quality-optimized";
    const { captured, restore } = stubAwait("advice");
    try {
      await executeSubagentSpawn(
        { label: "Consult", objective: "x", role: "advisor" },
        makeContext("advisor-sess-isolation", { sendToClient: () => {} }),
      );
      expect(captured.current!.config.overrideProfile).toBe("frontier");
      expect(captured.current!.config.forceOverrideProfile).toBe(true);
    } finally {
      restore();
      mockConversationOverrideProfile = undefined;
      mockFindConversation = () => undefined;
    }
  });

  test("advisor respects an explicit inference_profile over advisorProfile", async () => {
    mockFindConversation = () => ({
      messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      getCurrentSystemPrompt: () => "SYS",
    });
    const { captured, restore } = stubAwait("advice");
    try {
      await executeSubagentSpawn(
        {
          label: "Consult",
          objective: "x",
          role: "advisor",
          inference_profile: "quality-optimized",
        },
        makeContext("advisor-sess-5", { sendToClient: () => {} }),
      );
      expect(captured.current!.config.overrideProfile).toBe(
        "quality-optimized",
      );
      expect(captured.current!.config.forceOverrideProfile).toBe(true);
    } finally {
      restore();
      mockFindConversation = () => undefined;
    }
  });

  test("an advisorProfile the catalog denies tools falls back with a note", async () => {
    // The advisor carries read tools now, so a profile that cannot call them
    // would answer from the transcript alone with nothing saying why.
    mockFindConversation = () => ({
      messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      getCurrentSystemPrompt: () => "SYS",
    });
    setConfig("llm", { ...BASE_LLM_CONFIG, advisorProfile: "no-tool-model" });
    const { captured, restore } = stubAwait("Ship the data model first.");
    try {
      const result = await executeSubagentSpawn(
        { label: "Consult", objective: "x", role: "advisor" },
        makeContext("advisor-sess-no-tools", { sendToClient: () => {} }),
      );
      // No override travels with the consult, which is what lands it on the
      // subagentSpawn call site's own profile while leaving usage attribution
      // on call_site instead of reporting a pin nobody set.
      expect(captured.current!.config.overrideProfile).toBeUndefined();
      expect(captured.current!.config.forceOverrideProfile).toBeUndefined();
      expect(result.content).toContain("Ship the data model first.");
      expect(result.content).toContain(
        'profile "no-tool-model" is not verified for tool calling',
      );
    } finally {
      restore();
      setConfig("llm", BASE_LLM_CONFIG);
      mockFindConversation = () => undefined;
    }
  });

  test("an explicit inference_profile the catalog denies tools falls back too", async () => {
    mockFindConversation = () => ({
      messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      getCurrentSystemPrompt: () => "SYS",
    });
    const { captured, restore } = stubAwait("advice");
    try {
      const result = await executeSubagentSpawn(
        {
          label: "Consult",
          objective: "x",
          role: "advisor",
          inference_profile: "no-tool-model",
        },
        makeContext("advisor-sess-no-tools-explicit", {
          sendToClient: () => {},
        }),
      );
      expect(captured.current!.config.overrideProfile).toBeUndefined();
      expect(result.content).toContain("is not verified for tool calling");
    } finally {
      restore();
      mockFindConversation = () => undefined;
    }
  });

  test("a model the catalog does not list keeps the advisor on it", async () => {
    // Fail open: an unknown model is not evidence of anything, and BYOK
    // installs point profiles at models the catalog has never heard of.
    mockFindConversation = () => ({
      messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      getCurrentSystemPrompt: () => "SYS",
    });
    const { captured, restore } = stubAwait("advice");
    try {
      const result = await executeSubagentSpawn(
        {
          label: "Consult",
          objective: "x",
          role: "advisor",
          inference_profile: "byok-unknown-model",
        },
        makeContext("advisor-sess-byok", { sendToClient: () => {} }),
      );
      expect(captured.current!.config.overrideProfile).toBe(
        "byok-unknown-model",
      );
      expect(result.content).toBe("advice");
    } finally {
      restore();
      mockFindConversation = () => undefined;
    }
  });

  test("advisor forwards streamed chunks to the tool's onOutput sink", async () => {
    mockFindConversation = () => ({
      messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      getCurrentSystemPrompt: () => "SYS",
    });
    const { captured, restore } = stubAwait("advice");
    const chunks: string[] = [];
    const onOutput = (c: string) => chunks.push(c);
    try {
      await executeSubagentSpawn(
        { label: "Consult", objective: "x", role: "advisor" },
        makeContext("advisor-sess-6", { sendToClient: () => {}, onOutput }),
      );
      // onText is a forwarding wrapper rather than onOutput itself, but
      // invoking it must still forward to onOutput.
      expect(captured.current!.opts?.onText).toBeInstanceOf(Function);
      captured.current!.opts?.onText?.("hello");
      expect(chunks).toEqual(["hello"]);
      expect(captured.current!.opts?.signal).toBeInstanceOf(AbortSignal);
    } finally {
      restore();
      mockFindConversation = () => undefined;
    }
  });

  test("advisor taps tool activity as deadline progress, separately from onText", async () => {
    mockFindConversation = () => ({
      messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      getCurrentSystemPrompt: () => "SYS",
    });
    const { captured, restore } = stubAwait("advice");
    const chunks: string[] = [];
    const onOutput = (c: string) => chunks.push(c);
    try {
      await executeSubagentSpawn(
        { label: "Consult", objective: "x", role: "advisor" },
        makeContext("advisor-sess-progress", {
          sendToClient: () => {},
          onOutput,
        }),
      );
      // The idle deadline is re-armed from onProgress, which the manager fires
      // for tool events as well as tokens. An advisor reading a file emits no
      // token, so without this tap the consult would be killed mid-read.
      expect(captured.current!.opts?.onProgress).toBeInstanceOf(Function);
      captured.current!.opts?.onProgress?.();
      // Progress is a liveness signal, not content: it must not reach the
      // caller's stream sink.
      expect(chunks).toEqual([]);
      expect(captured.current!.opts?.signal?.aborted).toBe(false);
    } finally {
      restore();
      mockFindConversation = () => undefined;
    }
  });

  /** One child tool call, enveloped the way the manager sends it to a parent. */
  function toolCallEvent(toolUseId: string): Record<string, unknown> {
    return {
      type: "subagent_event",
      subagentId: "advisor-child",
      conversationId: "advisor-parent",
      event: {
        type: "tool_use_start",
        toolName: "file_read",
        toolUseId,
        conversationId: "advisor-child-conv",
      },
    };
  }

  test("a consult that keeps reading is stopped and answers with what it has", async () => {
    // Tool events re-arm the idle window, so without a ceiling on tool rounds
    // a reading advisor blocks the user's turn until the absolute backstop.
    mockFindConversation = () => ({
      messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      getCurrentSystemPrompt: () => "SYS",
    });
    let sawAbort = false;
    const { captured, restore } = stubAwait(async (send) => {
      for (let i = 0; i < 12; i++) {
        send(toolCallEvent(`tool-${i}`));
      }
      sawAbort = captured.current!.opts!.signal!.aborted;
      throw new SubagentAbortedError("Check the migration ordering first.");
    });
    const forwarded: unknown[] = [];
    try {
      const result = await executeSubagentSpawn(
        { label: "Consult", objective: "x", role: "advisor" },
        makeContext("advisor-sess-tool-cap", {
          sendToClient: (msg: unknown) => forwarded.push(msg),
        }),
      );

      expect(sawAbort).toBe(true);
      expect(result.isError).toBe(false);
      expect(result.content).toContain("Check the migration ordering first.");
      expect(result.content).toContain("used its full budget of 8 tool calls");
      // Counting must not swallow the child's events on their way to the client.
      expect(forwarded).toHaveLength(12);
    } finally {
      restore();
      mockFindConversation = () => undefined;
    }
  });

  test("tool calls under the ceiling leave the consult running", async () => {
    mockFindConversation = () => ({
      messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      getCurrentSystemPrompt: () => "SYS",
    });
    let sawAbort = true;
    const { captured, restore } = stubAwait(async (send) => {
      for (let i = 0; i < 8; i++) {
        send(toolCallEvent(`tool-${i}`));
      }
      // Non-tool traffic must not count against the ceiling.
      for (let i = 0; i < 20; i++) {
        send({
          type: "subagent_event",
          subagentId: "advisor-child",
          event: { type: "assistant_text_delta", text: "thinking" },
        });
      }
      sawAbort = captured.current!.opts!.signal!.aborted;
      return "Read enough. Ship the data model first.";
    });
    try {
      const result = await executeSubagentSpawn(
        { label: "Consult", objective: "x", role: "advisor" },
        makeContext("advisor-sess-tool-cap-under", { sendToClient: () => {} }),
      );

      expect(sawAbort).toBe(false);
      expect(result.content).toBe("Read enough. Ship the data model first.");
    } finally {
      restore();
      mockFindConversation = () => undefined;
    }
  });

  test("a consult stopped at the ceiling with nothing written says so", async () => {
    mockFindConversation = () => ({
      messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      getCurrentSystemPrompt: () => "SYS",
    });
    const { restore } = stubAwait(async (send) => {
      for (let i = 0; i < 9; i++) {
        send(toolCallEvent(`tool-${i}`));
      }
      throw new SubagentAbortedError("  ");
    });
    try {
      const result = await executeSubagentSpawn(
        { label: "Consult", objective: "x", role: "advisor" },
        makeContext("advisor-sess-tool-cap-empty", { sendToClient: () => {} }),
      );

      expect(result.isError).toBe(false);
      expect(result.content).toContain(
        "advisor used its full budget of 8 tool calls without writing any guidance",
      );
      // The generic degrade would say nothing about why it stopped.
      expect(result.content).not.toContain("advisor unavailable");
    } finally {
      restore();
      mockFindConversation = () => undefined;
    }
  });

  test("a consult that both fell back on profile and hit the cap says both", async () => {
    // The profile note explains guidance that reads oddly, so the branch with
    // no guidance at all is exactly where it is most needed.
    mockFindConversation = () => ({
      messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      getCurrentSystemPrompt: () => "SYS",
    });
    setConfig("llm", { ...BASE_LLM_CONFIG, advisorProfile: "no-tool-model" });
    const { restore } = stubAwait(async (send) => {
      for (let i = 0; i < 9; i++) {
        send(toolCallEvent(`tool-${i}`));
      }
      throw new SubagentAbortedError("  ");
    });
    try {
      const result = await executeSubagentSpawn(
        { label: "Consult", objective: "x", role: "advisor" },
        makeContext("advisor-sess-tool-cap-note", { sendToClient: () => {} }),
      );

      expect(result.content).toContain(
        "advisor used its full budget of 8 tool calls without writing any guidance",
      );
      expect(result.content).toContain(
        'profile "no-tool-model" is not verified for tool calling',
      );
    } finally {
      restore();
      setConfig("llm", BASE_LLM_CONFIG);
      mockFindConversation = () => undefined;
    }
  });

  test("advisor consult runs under the owner-gated read-only guard", async () => {
    mockFindConversation = () => ({
      messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      getCurrentSystemPrompt: () => "SYS",
    });
    const { captured, restore } = stubAwait("advice");
    try {
      await executeSubagentSpawn(
        { label: "Consult", objective: "x", role: "advisor" },
        makeContext("advisor-sess-readonly", { sendToClient: () => {} }),
      );
      // Without this the advisor's read-only guarantee is a list of NAMES, and
      // a workspace tool registered as `file_read` would be handed to it to
      // execute. The owner check that names cannot express rides on the role,
      // so it reaches every path that projects the role rather than only the
      // spawn site that remembered to ask for it.
      expect(captured.current!.config.role).toBe("advisor");
      expect(SUBAGENT_ROLE_REGISTRY.advisor.denySideEffects).toBe(true);
    } finally {
      restore();
      mockFindConversation = () => undefined;
    }
  });

  test("advisor degrades benignly when the consult throws (incl. depth limit)", async () => {
    mockFindConversation = () => ({
      messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      getCurrentSystemPrompt: () => "SYS",
    });
    const { restore } = stubAwait(async () => {
      throw new Error(
        "Cannot spawn subagent: parent is itself a subagent (max depth 1).",
      );
    });
    try {
      const result = await executeSubagentSpawn(
        { label: "Consult", objective: "x", role: "advisor" },
        makeContext("advisor-sess-7", { sendToClient: () => {} }),
      );
      // Never fail the turn — benign non-error notice.
      expect(result.isError).toBe(false);
      expect(result.content).toContain("advisor unavailable");
      expect(result.content).toContain("parent is itself a subagent");
    } finally {
      restore();
      mockFindConversation = () => undefined;
    }
  });

  test("advisor returns partial guidance (with a cut-off note) when the consult times out", async () => {
    mockFindConversation = () => ({
      messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      getCurrentSystemPrompt: () => "SYS",
    });
    // A timeout surfaces as SubagentAbortedError carrying the partial text the
    // advisor streamed before being cut off; that text must be salvaged.
    const { restore } = stubAwait(async () => {
      throw new SubagentAbortedError(
        "Lead with the data model, then wire reminders last.",
      );
    });
    try {
      const result = await executeSubagentSpawn(
        { label: "Consult", objective: "x", role: "advisor" },
        makeContext("advisor-sess-timeout", { sendToClient: () => {} }),
      );
      expect(result.isError).toBe(false);
      expect(result.content).toContain(
        "Lead with the data model, then wire reminders last.",
      );
      expect(result.content).toContain("may be cut off");
      // Not the generic unavailable degrade — real guidance was preserved.
      expect(result.content).not.toContain("advisor unavailable");
    } finally {
      restore();
      mockFindConversation = () => undefined;
    }
  });

  test("advisor still degrades when a timeout yields no partial text", async () => {
    mockFindConversation = () => ({
      messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      getCurrentSystemPrompt: () => "SYS",
    });
    // Aborted before producing any text → empty partial → fall through to the
    // benign "advisor unavailable" notice.
    const { restore } = stubAwait(async () => {
      throw new SubagentAbortedError("   ");
    });
    try {
      const result = await executeSubagentSpawn(
        { label: "Consult", objective: "x", role: "advisor" },
        makeContext("advisor-sess-timeout-empty", { sendToClient: () => {} }),
      );
      expect(result.isError).toBe(false);
      expect(result.content).toContain("advisor unavailable");
    } finally {
      restore();
      mockFindConversation = () => undefined;
    }
  });

  test("advisor degrades benignly when no client is connected", async () => {
    // No sendToClient → the shared client guard fires before the advisor branch.
    const result = await executeSubagentSpawn(
      { label: "Consult", objective: "x", role: "advisor" },
      makeContext("advisor-sess-8"),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("No client connected");
  });
});

// ── Advisor role read-only enforcement ──────────────────────────────

describe("Advisor role is read-only", () => {
  test("the advisor allowlist admits its read tools and nothing write-capable", async () => {
    // The allowlist is a ceiling, not a hint: build a resolveTools callback
    // with the advisor's allowlist and confirm a write-capable tool is dropped
    // while its read tools survive.
    const { createResolveToolsCallback } =
      await import("../daemon/conversation-tool-setup.js");
    const { SUBAGENT_ROLE_REGISTRY } = await import("../subagent/types.js");
    const advisorAllowed = SUBAGENT_ROLE_REGISTRY.advisor.allowedTools;
    expect(advisorAllowed).toEqual(["file_read", "file_list", "code_search"]);

    const toolDefs = [
      "bash",
      "file_write",
      "file_read",
      "file_list",
      "code_search",
      "recall",
    ].map((name) => ({
      name,
      description: "",
      input_schema: { type: "object" },
    }));
    const ctx = {
      skillProjectionState: new Map<string, string>(),
      skillProjectionCache: new Map(),
      toolsDisabledDepth: 0,
      subagentAllowedTools: new Set<string>(advisorAllowed),
      // Default (absent) gate mode is "wire": the allowlist filters the wire
      // tool list.
      isSubagent: true,
    } as unknown as Parameters<typeof createResolveToolsCallback>[1];

    const resolve = createResolveToolsCallback(
      toolDefs as unknown as Parameters<typeof createResolveToolsCallback>[0],
      ctx,
    );
    expect(resolve).toBeDefined();
    const resolvedNames = resolve!([]).map((t) => t.name);
    expect(resolvedNames.sort()).toEqual([
      "code_search",
      "file_list",
      "file_read",
    ]);
    // The per-turn execution gate matches the wire list.
    const gate = (ctx as unknown as { allowedToolNames?: Set<string> })
      .allowedToolNames;
    expect(gate?.has("file_read")).toBe(true);
    expect(gate?.has("bash")).toBe(false);
    // `recall` reaches memory and prior conversations, which the consult's
    // contract excludes, so the allowlist does not admit it either.
    expect(gate?.has("recall")).toBe(false);
  });
});

// ── model-input schema validation (LUM-2855) ────────────────────────

describe("subagent tools — model-input schema validation", () => {
  test("spawn rejects a non-string label instead of spawning with it", async () => {
    const result = await executeSubagentSpawn(
      { label: 42, objective: "do something" },
      makeContext("sess-schema", { sendToClient: () => {} }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Invalid input for tool "subagent_spawn"');
    expect(result.content).toContain("label");
  });

  test("spawn treats explicit null label as missing (bespoke required error)", async () => {
    const result = await executeSubagentSpawn(
      { label: null, objective: "do something" },
      makeContext("sess-schema", { sendToClient: () => {} }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("required");
  });

  test("status rejects a non-string subagent_id", async () => {
    const result = await executeSubagentStatus(
      { subagent_id: 42 },
      makeContext("sess-schema"),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      'Invalid input for tool "subagent_status"',
    );
  });

  test("message rejects a non-string content", async () => {
    const result = await executeSubagentMessage(
      { subagent_id: "some-id", content: 42 },
      makeContext("sess-schema"),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      'Invalid input for tool "subagent_message"',
    );
    expect(result.content).toContain("content");
  });

  test("read rejects a non-string label but passes malformed last_n through", async () => {
    const bad = await executeSubagentRead(
      { label: 42 },
      makeContext("sess-schema"),
    );
    expect(bad.isError).toBe(true);
    expect(bad.content).toContain('Invalid input for tool "subagent_read"');

    // last_n is loose passthrough — a malformed value is ignored, so the call
    // reaches the bespoke "required" check instead of failing validation.
    const passthrough = await executeSubagentRead(
      { last_n: "five" },
      makeContext("sess-schema"),
    );
    expect(passthrough.isError).toBe(true);
    expect(passthrough.content).toContain("required");
  });
});

// ── Read tool misuse redirects ──────────────────────────────────────

describe("Subagent read tool misuse", () => {
  for (const key of ["path", "file", "filename"]) {
    test(`read redirects a "${key}" param to file_read`, async () => {
      const result = await executeSubagentRead(
        { [key]: "/tmp/notes.md" },
        makeContext("misuse-sess"),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("it does not read files");
      expect(result.content).toContain("Use file_read for files");
      expect(result.content).toContain("Pass subagent_id or label here");
    });
  }

  for (const key of ["subagentId", "agent_id"]) {
    test(`read names "${key}" as an unknown parameter`, async () => {
      const result = await executeSubagentRead(
        { [key]: "some-id" },
        makeContext("misuse-sess"),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toBe(
        "Unknown parameter. Use subagent_id (snake_case) or label.",
      );
    });
  }

  test("a file-reader key wins over the misnamed-id message", async () => {
    const result = await executeSubagentRead(
      { path: "/tmp/notes.md", subagentId: "some-id" },
      makeContext("misuse-sess"),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("it does not read files");
  });

  test("a correctly named read is untouched by the misuse checks", async () => {
    const manager = getSubagentManager();
    const subagentId = "misuse-untouched-1";
    injectSubagent(manager, subagentId, "misuse-sess", "running");

    const result = await executeSubagentRead(
      { subagent_id: subagentId },
      makeContext("misuse-sess"),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("still running");
  });
});

// ── Durable fallback past the rehydration bound ─────────────────────

/** Mirrors `MAX_REHYDRATED_TERMINAL_RECORDS` in `subagent/manager.ts`. */
const REHYDRATION_CAP = 200;

const beyondCapParent = "beyond-cap-parent";
const beyondCapOtherParent = "beyond-cap-other-parent";
const reusedLabel = "Reused beyond cap";

function terminalRecord(over: Partial<SubagentRecord>): SubagentRecord {
  return {
    id: "seed",
    parentConversationId: beyondCapParent,
    conversationId: "conv-seed",
    label: "seed",
    objective: "seeded objective",
    role: "builder",
    isFork: false,
    sendResultToUser: true,
    parentToolUseId: null,
    status: "completed",
    error: null,
    createdAt: 1,
    startedAt: 2,
    completedAt: 3,
    inputTokens: 11,
    outputTokens: 22,
    estimatedCost: 0.33,
    ...over,
  };
}

describe("Subagent tools past the startup rehydration bound", () => {
  // Two runs reused one label, both older than a full cap's worth of finished
  // subagents, so the rehydration leaves them out of memory entirely.
  upsertSubagentRecord(
    terminalRecord({
      id: "reused-cap-old",
      conversationId: "conv-reused-cap-old",
      label: reusedLabel,
      createdAt: 1_000,
      completedAt: 2_000,
    }),
  );
  upsertSubagentRecord(
    terminalRecord({
      id: "reused-cap-new",
      conversationId: "conv-reused-cap-new",
      label: reusedLabel,
      createdAt: 3_000,
      completedAt: 4_000,
    }),
  );
  for (let i = 0; i < REHYDRATION_CAP; i++) {
    upsertSubagentRecord(
      terminalRecord({
        id: `cap-filler-${i}`,
        conversationId: `conv-cap-filler-${i}`,
        label: `cap filler ${i}`,
        createdAt: 10_000 + i,
        completedAt: 20_000 + i,
      }),
    );
  }

  const manager = getSubagentManager();
  manager.rehydrateFromDb();

  test("the rehydration really left the older runs out of memory", () => {
    expect(manager.getState("reused-cap-new")).toBeUndefined();
    expect(manager.getState("reused-cap-old")).toBeUndefined();
    expect(manager.getByLabel(reusedLabel, beyondCapParent)).toBeUndefined();
  });

  test("status answers for a subagent the bound left in the table", async () => {
    const result = await executeSubagentStatus(
      { subagent_id: "reused-cap-new" },
      makeContext(beyondCapParent),
    );
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.subagentId).toBe("reused-cap-new");
    expect(parsed.label).toBe(reusedLabel);
    expect(parsed.status).toBe("completed");
    expect(parsed.usage).toEqual({
      inputTokens: 11,
      outputTokens: 22,
      estimatedCost: 0.33,
    });
  });

  test("status still rejects another conversation asking for it", async () => {
    const result = await executeSubagentStatus(
      { subagent_id: "reused-cap-new" },
      makeContext(beyondCapOtherParent),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("No subagent found");
  });

  test("read returns the transcript for a subagent past the bound", async () => {
    mockGetMessages = (convId: string) => {
      if (convId !== "conv-reused-cap-new") {
        return null;
      }
      return [
        {
          role: "assistant",
          content: [{ type: "text", text: "Output from beyond the bound" }],
        },
      ];
    };

    try {
      const result = await executeSubagentRead(
        { subagent_id: "reused-cap-new" },
        makeContext(beyondCapParent),
      );
      expect(result.isError).toBe(false);
      // The counters live with the in-memory entry, which the bound dropped, so
      // the footer says unavailable rather than reporting zero tool calls.
      expect(result.content).toBe(
        "Output from beyond the bound\n\n[stats: unavailable (tool counters are not retained for this subagent)]",
      );
    } finally {
      mockGetMessages = () => null;
    }
  });

  test("read reports unavailable for a subagent the rehydration DID load", async () => {
    // This entry is inside the rehydration bound, so the restart put it back
    // in the manager, but its counters died with the process that ran it, and
    // no rehydrated entry can ever have them. Manager membership is therefore
    // not the signal; `rehydrated` is.
    const filler = `cap-filler-${REHYDRATION_CAP - 1}`;
    expect(manager.getState(filler)).toBeDefined();

    mockGetMessages = (convId: string) =>
      convId === `conv-${filler}`
        ? [
            {
              role: "assistant",
              content: [
                { type: "text", text: "Output from before the restart" },
              ],
            },
          ]
        : null;

    try {
      const result = await executeSubagentRead(
        { subagent_id: filler },
        makeContext(beyondCapParent),
      );
      expect(result.isError).toBe(false);
      expect(result.content).toBe(
        "Output from before the restart\n\n[stats: unavailable (tool counters are not retained for this subagent)]",
      );
    } finally {
      mockGetMessages = () => null;
    }
  });

  test("read still rejects another conversation asking for it", async () => {
    mockGetMessages = () => [
      { role: "assistant", content: [{ type: "text", text: "leaked" }] },
    ];

    try {
      const result = await executeSubagentRead(
        { subagent_id: "reused-cap-new" },
        makeContext(beyondCapOtherParent),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("No subagent found");
      expect(result.content).not.toContain("leaked");
    } finally {
      mockGetMessages = () => null;
    }
  });

  test("a label past the bound resolves durably to the newest run", async () => {
    const result = await executeSubagentStatus(
      { label: reusedLabel },
      makeContext(beyondCapParent),
    );
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content).subagentId).toBe("reused-cap-new");
  });

  test("a label past the bound matches case- and space-insensitively", async () => {
    const result = await executeSubagentStatus(
      { label: `  ${reusedLabel.toUpperCase()}  ` },
      makeContext(beyondCapParent),
    );
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content).subagentId).toBe("reused-cap-new");
  });

  test("a label past the bound stays scoped to the parent that spawned it", async () => {
    const result = await executeSubagentStatus(
      { label: reusedLabel },
      makeContext(beyondCapOtherParent),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("No subagent found");
  });
});

// ── List-all merges live children with durable rows ─────────────────

describe("subagent_status list-all past the in-memory window", () => {
  const mergeParent = "list-merge-parent";

  // A run the retention sweep evicted from memory while keeping its row, plus
  // a stale row for a subagent the manager still holds live.
  upsertSubagentRecord(
    terminalRecord({
      id: "list-merge-swept",
      parentConversationId: mergeParent,
      conversationId: "conv-list-merge-swept",
      label: "Swept worker",
      createdAt: 1_000,
      completedAt: 2_000,
    }),
  );
  upsertSubagentRecord(
    terminalRecord({
      id: "list-merge-live",
      parentConversationId: mergeParent,
      conversationId: "conv-list-merge-live",
      label: "Live worker",
      createdAt: 3_000,
      completedAt: 4_000,
    }),
  );

  const listMergeManager = getSubagentManager();
  injectSubagent(listMergeManager, "list-merge-live", mergeParent, "running");

  function listedSubagents(content: string) {
    return JSON.parse(content) as Array<{ subagentId: string; status: string }>;
  }

  test("lists a swept subagent alongside the live one", async () => {
    const result = await executeSubagentStatus({}, makeContext(mergeParent));
    expect(result.isError).toBe(false);
    expect(
      listedSubagents(result.content)
        .map((s) => s.subagentId)
        .sort(),
    ).toEqual(["list-merge-live", "list-merge-swept"]);
  });

  test("prefers live state over the row, and settles a row-only entry", async () => {
    const result = await executeSubagentStatus({}, makeContext(mergeParent));
    const listed = listedSubagents(result.content);

    // The row says `completed`; the manager is still running it.
    expect(listed.find((s) => s.subagentId === "list-merge-live")?.status).toBe(
      "running",
    );
    expect(
      listed.find((s) => s.subagentId === "list-merge-swept")?.status,
    ).toBe("completed");
  });
});

// ── List-all bounds the merged set ──────────────────────────────────

/** Mirrors `MAX_LISTED_TERMINAL_RECORDS` in `tools/subagent/status.ts`. */
const LISTED_TERMINAL_CAP = 20;

describe("subagent_status list-all bounds the terminal entries", () => {
  const boundParent = "list-bound-parent";

  // A restart rehydrates far more terminal children than this path reports, so
  // the bound has to hold over the merged set, not just the durable query.
  for (let i = 0; i < 25; i++) {
    injectSubagent(
      getSubagentManager(),
      `list-bound-done-${String(i).padStart(2, "0")}`,
      boundParent,
      "completed",
      { createdAt: 1_000 + i, completedAt: 10_000 + i },
    );
  }
  // The oldest child of the parent, which the recency cap must not reach.
  injectSubagent(
    getSubagentManager(),
    "list-bound-active",
    boundParent,
    "running",
    {
      createdAt: 1,
    },
  );

  function listedIds(content: string): string[] {
    return (JSON.parse(content) as Array<{ subagentId: string }>).map(
      (s) => s.subagentId,
    );
  }

  test("reports only the most recently settled terminal children", async () => {
    const result = await executeSubagentStatus({}, makeContext(boundParent));
    expect(result.isError).toBe(false);

    expect(
      listedIds(result.content)
        .filter((id) => id !== "list-bound-active")
        .sort(),
    ).toEqual(
      Array.from(
        { length: LISTED_TERMINAL_CAP },
        (_, i) => `list-bound-done-${String(i + 5).padStart(2, "0")}`,
      ).sort(),
    );
  });

  test("never caps out an active child, however old", async () => {
    const result = await executeSubagentStatus({}, makeContext(boundParent));
    const ids = listedIds(result.content);

    expect(ids).toContain("list-bound-active");
    expect(ids).toHaveLength(LISTED_TERMINAL_CAP + 1);
  });
});
