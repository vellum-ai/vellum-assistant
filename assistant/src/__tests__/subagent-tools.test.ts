import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, mock, test } from "bun:test";

import { setConfig } from "./helpers/set-config.js";

// Seed the two non-catalog inference profiles these tests exercise: `disabled`
// drives the "profile is disabled" spawn error, and `frontier` is the advisor
// consult's default `advisorProfile`. The catalog profiles (balanced,
// cost-optimized, quality-optimized) always resolve through the code catalog,
// so they need no seeding.
setConfig("llm", {
  profiles: {
    disabled: { status: "disabled" },
    frontier: {},
  },
  advisorProfile: "frontier",
});

// Mock conversation-crud before importing tool executors that depend on it.
let mockGetMessages: (
  conversationId: string,
) => Array<{ role: string; content: unknown }> | null = () => null;

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
  createConversation: () => ({ id: "mock-conv" }),
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
}));

import { resolveMessageContentBlocks } from "../persistence/message-content-file.js";
import { getSubagentManager } from "../subagent/index.js";
import { SubagentAbortedError, SubagentManager } from "../subagent/manager.js";
import type { SubagentState } from "../subagent/types.js";
import { executeSubagentAbort } from "../tools/subagent/abort.js";
import { executeSubagentMessage } from "../tools/subagent/message.js";
import { executeSubagentRead } from "../tools/subagent/read.js";
import { executeSubagentSpawn } from "../tools/subagent/spawn.js";
import { executeSubagentStatus } from "../tools/subagent/status.js";

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
 */
function injectSubagent(
  manager: SubagentManager,
  subagentId: string,
  parentConversationId: string,
  status: SubagentState["status"] = "running",
  overrides: Partial<SubagentState> = {},
): SubagentState {
  const internals = manager as unknown as {
    subagents: Map<
      string,
      {
        conversation: unknown;
        state: SubagentState;
        parentSendToClient: () => void;
      }
    >;
    parentToChildren: Map<string, Set<string>>;
    labelIndex: Map<string, string>;
  };
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
    ...overrides,
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
  };
  internals.subagents.set(subagentId, {
    conversation: fakeConversation,
    state,
    parentSendToClient: () => {},
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

  test("spawn inherits the invoking call site's default profile when no override is present", async () => {
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
      // No explicit profile and no per-turn override → the child matches the
      // invoking call site's resolved default profile (balanced for mainAgent
      // in the test config).
      expect(capturedConfig!.overrideProfile).toBe("balanced");
      expect(capturedConfig!.forceOverrideProfile).toBeUndefined();
    } finally {
      manager.spawn = originalSpawn;
    }
  });

  test("spawn inherits a non-main invoker's call-site default profile", async () => {
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
      // A subagent spawned from a heartbeat turn matches heartbeatAgent's own
      // cost-optimized default, not the mainAgent default.
      expect(capturedConfig!.overrideProfile).toBe("cost-optimized");
    } finally {
      manager.spawn = originalSpawn;
    }
  });

  test("spawn prefers a per-turn override profile over the invoker default", async () => {
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
      // The live per-turn override wins over
      // the call-site default, and is forwarded non-forced.
      expect(capturedConfig!.overrideProfile).toBe("quality-optimized");
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
    expect(result.content).toContain("Wait");
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

  test("spawn without role defaults to general (backwards compat)", async () => {
    const manager = getSubagentManager();
    const originalSpawn = manager.spawn.bind(manager);
    let capturedConfig: Record<string, unknown> | undefined;

    manager.spawn = async (config: Record<string, unknown>) => {
      capturedConfig = config;
      return "role-default-id";
    };

    try {
      const result = await executeSubagentSpawn(
        { label: "General task", objective: "Do something" },
        makeContext("sess-role-2", { sendToClient: () => {} }),
      );
      expect(result.isError).toBe(false);
      const parsed = JSON.parse(result.content);
      expect(parsed.subagentId).toBe("role-default-id");
      expect(capturedConfig).toBeDefined();
      // When role is not specified, it should not be present in config
      expect(capturedConfig!.role).toBeUndefined();
    } finally {
      manager.spawn = originalSpawn;
    }
  });

  test("spawn with invalid role returns clear error message", async () => {
    const result = await executeSubagentSpawn(
      {
        label: "Bad role task",
        objective: "Should fail",
        role: "nonexistent-role",
      },
      makeContext("sess-role-invalid", { sendToClient: () => {} }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Invalid subagent role");
    expect(result.content).toContain("nonexistent-role");
    expect(result.content).toContain("Must be one of");
    expect(result.content).toContain("general");
    expect(result.content).toContain("researcher");
  });

  test("spawn tool definition includes role property", () => {
    const def = findTool("subagent_spawn");
    expect(def).toBeDefined();
    expect(def.input_schema.properties.role).toBeDefined();
    expect(def.input_schema.properties.role.type).toBe("string");
    expect(def.input_schema.properties.role.enum).toEqual([
      "general",
      "researcher",
      "coder",
      "planner",
      "investigator",
      "advisor",
    ]);
    // role is not required
    expect(def.input_schema.required).not.toContain("role");
  });
});

// ── Advisor-role consult ────────────────────────────────────────────

describe("Subagent advisor-role consult", () => {
  type Block = { type: string; [k: string]: unknown };
  type CapturedAwait = {
    config: Record<string, unknown>;
    opts?: { signal?: AbortSignal; onText?: (chunk: string) => void };
  };

  /**
   * Stub `manager.spawnAndAwait` to capture the config + opts and resolve to
   * `advice`. Restores the original on cleanup. Returns the captured-call ref.
   */
  function stubAwait(advice: string | (() => Promise<string>)): {
    captured: { current?: CapturedAwait };
    restore: () => void;
  } {
    const manager = getSubagentManager();
    const original = manager.spawnAndAwait.bind(manager);
    const captured: { current?: CapturedAwait } = {};
    manager.spawnAndAwait = (async (
      config: Record<string, unknown>,
      _send: unknown,
      opts?: CapturedAwait["opts"],
    ) => {
      captured.current = { config, opts };
      return typeof advice === "function" ? await advice() : advice;
    }) as typeof manager.spawnAndAwait;
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
      // Framing embeds the executor prompt as advisor system prompt context.
      expect(captured.current!.config.systemPromptOverride).toContain(
        "PARENT SYSTEM PROMPT",
      );
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
      // onText is a progress-recording wrapper (resets the idle deadline), not
      // onOutput itself — but invoking it must still forward to onOutput.
      expect(captured.current!.opts?.onText).toBeInstanceOf(Function);
      captured.current!.opts?.onText?.("hello");
      expect(chunks).toEqual(["hello"]);
      expect(captured.current!.opts?.signal).toBeInstanceOf(AbortSignal);
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

// ── Advisor role tool-less enforcement ──────────────────────────────

describe("Advisor role is tool-less", () => {
  test("the advisor role's empty allowlist yields zero tools (not 'no filter')", async () => {
    // An empty allowlist must mean ZERO tools, not "no restriction". Build a
    // resolveTools callback with the advisor's empty allowlist and confirm no
    // tool survives — including a fake skill tool the projection would add.
    const { createResolveToolsCallback } =
      await import("../daemon/conversation-tool-setup.js");
    const { SUBAGENT_ROLE_REGISTRY } = await import("../subagent/types.js");
    const advisorAllowed = SUBAGENT_ROLE_REGISTRY.advisor.allowedTools;
    expect(advisorAllowed).toEqual([]);

    const toolDefs = [
      { name: "bash", description: "", input_schema: { type: "object" } },
      { name: "file_read", description: "", input_schema: { type: "object" } },
    ];
    const ctx = {
      skillProjectionState: new Map<string, string>(),
      skillProjectionCache: new Map(),
      coreToolNames: new Set(toolDefs.map((d) => d.name)),
      toolsDisabledDepth: 0,
      // The advisor role applies `new Set(allowedTools)` — empty Set here.
      subagentAllowedTools: new Set<string>(advisorAllowed),
      // Default (absent) gate mode is "wire": the allowlist filters the wire
      // tool list, so an empty Set leaves nothing.
      isSubagent: true,
    } as unknown as Parameters<typeof createResolveToolsCallback>[1];

    const resolve = createResolveToolsCallback(
      toolDefs as unknown as Parameters<typeof createResolveToolsCallback>[0],
      ctx,
    );
    expect(resolve).toBeDefined();
    const resolved = resolve!([]);
    expect(resolved).toEqual([]);
    // The per-turn execution gate is likewise empty.
    expect(
      (ctx as unknown as { allowedToolNames?: Set<string> }).allowedToolNames
        ?.size ?? 0,
    ).toBe(0);
  });
});
