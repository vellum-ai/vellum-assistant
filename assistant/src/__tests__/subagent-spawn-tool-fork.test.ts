import { describe, expect, test } from "bun:test";
import { mock } from "bun:test";

// Mock conversation-crud before importing tool executors that depend on it.
mock.module("../memory/conversation-crud.js", () => ({
  getConversationType: () => "default",
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
}));

import type { Message } from "../providers/types.js";
import { getSubagentManager } from "../subagent/index.js";
import { executeSubagentSpawn } from "../tools/subagent/spawn.js";

// ── Shared helpers ──────────────────────────────────────────────────

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

const FAKE_PARENT_MESSAGES: Message[] = [
  {
    role: "user",
    content: [{ type: "text", text: "Hello from parent" }],
  },
  {
    role: "assistant",
    content: [{ type: "text", text: "Hello! How can I help?" }],
  },
];

describe("subagent_spawn fork parameter", () => {
  test("fork: true passes parent context to manager", async () => {
    const manager = getSubagentManager();
    const originalSpawn = manager.spawn.bind(manager);
    const originalResolve = manager.resolveParentConversation;

    let capturedConfig: Record<string, unknown> | undefined;
    manager.spawn = async (config: Record<string, unknown>) => {
      capturedConfig = config;
      return "fork-subagent-id";
    };

    // Wire resolveParentConversation to return a fake parent conversation.
    manager.resolveParentConversation = (id: string) => {
      if (id === "parent-conv-1") {
        return {
          messages: FAKE_PARENT_MESSAGES,
          getCurrentSystemPrompt: () => "You are a helpful assistant.",
        } as any;
      }
      return undefined;
    };

    try {
      const result = await executeSubagentSpawn(
        {
          label: "Fork task",
          objective: "Summarize our discussion",
          fork: true,
        },
        makeContext("parent-conv-1", { sendToClient: () => {} }),
      );

      expect(result.isError).toBe(false);
      expect(capturedConfig).toBeDefined();
      expect(capturedConfig!.fork).toBe(true);
      expect(capturedConfig!.parentMessages).toEqual(FAKE_PARENT_MESSAGES);
      expect(capturedConfig!.parentSystemPrompt).toBe(
        "You are a helpful assistant.",
      );
      expect(capturedConfig!.parentConversationId).toBe("parent-conv-1");

      // Verify the response includes isFork
      const parsed = JSON.parse(result.content);
      expect(parsed.isFork).toBe(true);
      expect(parsed.subagentId).toBe("fork-subagent-id");
      expect(parsed.status).toBe("pending");
      expect(parsed.message).toContain("Forked subagent");
    } finally {
      manager.spawn = originalSpawn;
      manager.resolveParentConversation = originalResolve;
    }
  });

  test("fork: true ignores role parameter", async () => {
    const manager = getSubagentManager();
    const originalSpawn = manager.spawn.bind(manager);
    const originalResolve = manager.resolveParentConversation;

    let capturedConfig: Record<string, unknown> | undefined;
    manager.spawn = async (config: Record<string, unknown>) => {
      capturedConfig = config;
      return "fork-role-id";
    };

    manager.resolveParentConversation = (id: string) => {
      if (id === "parent-conv-role") {
        return {
          messages: FAKE_PARENT_MESSAGES,
          getCurrentSystemPrompt: () => "Parent prompt.",
        } as any;
      }
      return undefined;
    };

    try {
      const result = await executeSubagentSpawn(
        {
          label: "Fork with role",
          objective: "Do something",
          fork: true,
          role: "researcher", // should be ignored
        },
        makeContext("parent-conv-role", { sendToClient: () => {} }),
      );

      expect(result.isError).toBe(false);
      expect(capturedConfig).toBeDefined();
      // When fork is true, role should NOT be passed to the manager config
      expect(capturedConfig!.role).toBeUndefined();
      expect(capturedConfig!.fork).toBe(true);
    } finally {
      manager.spawn = originalSpawn;
      manager.resolveParentConversation = originalResolve;
    }
  });

  test("fork: true defaults sendResultToUser to false", async () => {
    const manager = getSubagentManager();
    const originalSpawn = manager.spawn.bind(manager);
    const originalResolve = manager.resolveParentConversation;

    let capturedConfig: Record<string, unknown> | undefined;
    manager.spawn = async (config: Record<string, unknown>) => {
      capturedConfig = config;
      return "fork-silent-id";
    };

    manager.resolveParentConversation = (id: string) => {
      if (id === "parent-conv-silent") {
        return {
          messages: FAKE_PARENT_MESSAGES,
          getCurrentSystemPrompt: () => "Parent prompt.",
        } as any;
      }
      return undefined;
    };

    try {
      // No send_result_to_user specified — fork should default to false
      const result = await executeSubagentSpawn(
        {
          label: "Silent fork",
          objective: "Internal processing",
          fork: true,
        },
        makeContext("parent-conv-silent", { sendToClient: () => {} }),
      );

      expect(result.isError).toBe(false);
      expect(capturedConfig).toBeDefined();
      expect(capturedConfig!.sendResultToUser).toBe(false);
    } finally {
      manager.spawn = originalSpawn;
      manager.resolveParentConversation = originalResolve;
    }
  });

  test("fork: true with explicit send_result_to_user: true preserves it", async () => {
    const manager = getSubagentManager();
    const originalSpawn = manager.spawn.bind(manager);
    const originalResolve = manager.resolveParentConversation;

    let capturedConfig: Record<string, unknown> | undefined;
    manager.spawn = async (config: Record<string, unknown>) => {
      capturedConfig = config;
      return "fork-visible-id";
    };

    manager.resolveParentConversation = (id: string) => {
      if (id === "parent-conv-visible") {
        return {
          messages: FAKE_PARENT_MESSAGES,
          getCurrentSystemPrompt: () => "Parent prompt.",
        } as any;
      }
      return undefined;
    };

    try {
      const result = await executeSubagentSpawn(
        {
          label: "Visible fork",
          objective: "Share with user",
          fork: true,
          send_result_to_user: true,
        },
        makeContext("parent-conv-visible", { sendToClient: () => {} }),
      );

      expect(result.isError).toBe(false);
      expect(capturedConfig).toBeDefined();
      expect(capturedConfig!.sendResultToUser).toBe(true);
    } finally {
      manager.spawn = originalSpawn;
      manager.resolveParentConversation = originalResolve;
    }
  });

  test("fork: false / omitted behaves identically to current behavior", async () => {
    const manager = getSubagentManager();
    const originalSpawn = manager.spawn.bind(manager);

    // Test with fork: false
    let capturedConfig: Record<string, unknown> | undefined;
    manager.spawn = async (config: Record<string, unknown>) => {
      capturedConfig = config;
      return "regular-subagent-id";
    };

    try {
      const result = await executeSubagentSpawn(
        {
          label: "Regular task",
          objective: "Do something",
          fork: false,
          role: "researcher",
          context: "Some context",
        },
        makeContext("regular-conv-1", { sendToClient: () => {} }),
      );

      expect(result.isError).toBe(false);
      expect(capturedConfig).toBeDefined();
      // Should NOT have fork fields
      expect(capturedConfig!.fork).toBeUndefined();
      expect(capturedConfig!.parentMessages).toBeUndefined();
      expect(capturedConfig!.parentSystemPrompt).toBeUndefined();
      // Should have role
      expect(capturedConfig!.role).toBe("researcher");
      // Should have regular sendResultToUser default (true)
      expect(capturedConfig!.sendResultToUser).toBe(true);
      expect(capturedConfig!.context).toBe("Some context");

      // Response should NOT include isFork
      const parsed = JSON.parse(result.content);
      expect(parsed.isFork).toBeUndefined();
      expect(parsed.message).toContain("spawned");
      expect(parsed.message).not.toContain("Forked");
    } finally {
      manager.spawn = originalSpawn;
    }
  });

  test("fork omitted behaves like fork: false", async () => {
    const manager = getSubagentManager();
    const originalSpawn = manager.spawn.bind(manager);

    let capturedConfig: Record<string, unknown> | undefined;
    manager.spawn = async (config: Record<string, unknown>) => {
      capturedConfig = config;
      return "omitted-fork-id";
    };

    try {
      const result = await executeSubagentSpawn(
        {
          label: "No fork field",
          objective: "Standard task",
        },
        makeContext("no-fork-conv", { sendToClient: () => {} }),
      );

      expect(result.isError).toBe(false);
      expect(capturedConfig).toBeDefined();
      expect(capturedConfig!.fork).toBeUndefined();
      expect(capturedConfig!.parentMessages).toBeUndefined();
      expect(capturedConfig!.parentSystemPrompt).toBeUndefined();
      expect(capturedConfig!.sendResultToUser).toBe(true);

      const parsed = JSON.parse(result.content);
      expect(parsed.isFork).toBeUndefined();
    } finally {
      manager.spawn = originalSpawn;
    }
  });

  test("error when parent conversation cannot be resolved", async () => {
    const manager = getSubagentManager();
    const originalResolve = manager.resolveParentConversation;

    // resolveParentConversation returns undefined
    manager.resolveParentConversation = () => undefined;

    try {
      const result = await executeSubagentSpawn(
        {
          label: "Orphan fork",
          objective: "Should fail",
          fork: true,
        },
        makeContext("nonexistent-parent", { sendToClient: () => {} }),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("Cannot fork");
      expect(result.content).toContain(
        "parent conversation could not be resolved",
      );
    } finally {
      manager.resolveParentConversation = originalResolve;
    }
  });

  test("error when resolveParentConversation is not wired", async () => {
    const manager = getSubagentManager();
    const originalResolve = manager.resolveParentConversation;

    // Unset the callback entirely
    manager.resolveParentConversation = undefined;

    try {
      const result = await executeSubagentSpawn(
        {
          label: "Unwired fork",
          objective: "Should fail",
          fork: true,
        },
        makeContext("some-parent", { sendToClient: () => {} }),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("Cannot fork");
      expect(result.content).toContain(
        "parent conversation could not be resolved",
      );
    } finally {
      manager.resolveParentConversation = originalResolve;
    }
  });

  test("fork: true shallow copies parent messages", async () => {
    const manager = getSubagentManager();
    const originalSpawn = manager.spawn.bind(manager);
    const originalResolve = manager.resolveParentConversation;

    const originalMessages = [...FAKE_PARENT_MESSAGES];
    let capturedConfig: Record<string, unknown> | undefined;
    manager.spawn = async (config: Record<string, unknown>) => {
      capturedConfig = config;
      return "copy-check-id";
    };

    manager.resolveParentConversation = (id: string) => {
      if (id === "parent-conv-copy") {
        return {
          messages: originalMessages,
          getCurrentSystemPrompt: () => "Prompt.",
        } as any;
      }
      return undefined;
    };

    try {
      await executeSubagentSpawn(
        {
          label: "Copy check",
          objective: "Test",
          fork: true,
        },
        makeContext("parent-conv-copy", { sendToClient: () => {} }),
      );

      expect(capturedConfig).toBeDefined();
      const passedMessages = capturedConfig!.parentMessages as Message[];
      // Should be a different array reference (shallow copy via spread)
      expect(passedMessages).not.toBe(originalMessages);
      // But same content
      expect(passedMessages).toEqual(originalMessages);
    } finally {
      manager.spawn = originalSpawn;
      manager.resolveParentConversation = originalResolve;
    }
  });
});
