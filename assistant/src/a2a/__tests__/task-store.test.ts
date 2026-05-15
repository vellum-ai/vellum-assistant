import { beforeEach, describe, expect, test } from "bun:test";
import { mock } from "bun:test";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
  truncateForLog: (value: string) => value,
}));

import { getDb, getSqliteFrom } from "../../memory/db-connection.js";
import { initializeDb } from "../../memory/db-init.js";
import type { A2AMessage, Artifact } from "../protocol-types.js";
import {
  completeWithArtifacts,
  createTask,
  getPushUrl,
  getTask,
  linkConversation,
  updateState,
} from "../task-store.js";

initializeDb();

function makeRequestMessage(overrides?: Partial<A2AMessage>): A2AMessage {
  return {
    message_id: crypto.randomUUID(),
    role: "user",
    parts: [{ kind: "text", text: "Hello from sender" }],
    ...overrides,
  };
}

describe("a2a-task-store", () => {
  beforeEach(() => {
    const raw = getSqliteFrom(getDb());
    raw.run("DELETE FROM a2a_tasks");
  });

  // ── State transitions ───────────────────────────────────────────

  test("createTask returns a task in submitted state", () => {
    const msg = makeRequestMessage();
    const task = createTask({
      senderAssistantId: "assistant-123",
      requestMessage: msg,
    });

    expect(task.id).toBeTruthy();
    expect(task.status.state).toBe("submitted");
    expect(task.artifacts).toBeUndefined();
  });

  test("submitted -> working -> completed lifecycle", () => {
    const task = createTask({
      senderAssistantId: "assistant-123",
      requestMessage: makeRequestMessage(),
    });

    const working = updateState(task.id, "working", "Processing...");
    expect(working.status.state).toBe("working");
    expect(working.status.message).toBeDefined();

    const completed = updateState(task.id, "completed");
    expect(completed.status.state).toBe("completed");
  });

  test("cannot transition from terminal state (completed -> working)", () => {
    const task = createTask({
      senderAssistantId: "assistant-123",
      requestMessage: makeRequestMessage(),
    });

    updateState(task.id, "completed");

    expect(() => updateState(task.id, "working")).toThrow(/terminal state/);
  });

  test("cannot transition from failed state", () => {
    const task = createTask({
      senderAssistantId: "assistant-123",
      requestMessage: makeRequestMessage(),
    });

    updateState(task.id, "failed");

    expect(() => updateState(task.id, "working")).toThrow(/terminal state/);
  });

  test("cannot transition from canceled state", () => {
    const task = createTask({
      senderAssistantId: "assistant-123",
      requestMessage: makeRequestMessage(),
    });

    updateState(task.id, "canceled");

    expect(() => updateState(task.id, "submitted")).toThrow(/terminal state/);
  });

  test("cannot transition from rejected state", () => {
    const task = createTask({
      senderAssistantId: "assistant-123",
      requestMessage: makeRequestMessage(),
    });

    updateState(task.id, "rejected");

    expect(() => updateState(task.id, "working")).toThrow(/terminal state/);
  });

  // ── Artifact serialization round-trip ─────────────────────────

  test("completeWithArtifacts stores and retrieves artifacts via JSON round-trip", () => {
    const task = createTask({
      senderAssistantId: "assistant-123",
      requestMessage: makeRequestMessage(),
    });

    updateState(task.id, "working");

    const artifacts: Artifact[] = [
      {
        artifact_id: "art-1",
        parts: [{ kind: "text", text: "Result data" }],
        metadata: { score: 0.95 },
      },
      {
        artifact_id: "art-2",
        parts: [
          { kind: "data", data: { key: "value" } },
          {
            kind: "file",
            url: "https://example.com/file.txt",
            filename: "file.txt",
          },
        ],
      },
    ];

    const completed = completeWithArtifacts(task.id, artifacts);
    expect(completed.status.state).toBe("completed");
    expect(completed.artifacts).toHaveLength(2);
    expect(completed.artifacts![0].artifact_id).toBe("art-1");
    expect(completed.artifacts![0].metadata).toEqual({ score: 0.95 });
    expect(completed.artifacts![1].parts).toHaveLength(2);

    // Verify round-trip via fresh getTask
    const fetched = getTask(task.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.artifacts).toEqual(completed.artifacts);
  });

  test("completeWithArtifacts rejects terminal task", () => {
    const task = createTask({
      senderAssistantId: "assistant-123",
      requestMessage: makeRequestMessage(),
    });

    updateState(task.id, "completed");

    expect(() =>
      completeWithArtifacts(task.id, [
        { artifact_id: "art-1", parts: [{ kind: "text", text: "late" }] },
      ]),
    ).toThrow(/terminal state/);
  });

  // ── Push URL storage and retrieval ────────────────────────────

  test("push URL is stored and retrieved", () => {
    const task = createTask({
      senderAssistantId: "assistant-123",
      requestMessage: makeRequestMessage(),
      pushUrl: "https://example.com/push",
    });

    const url = getPushUrl(task.id);
    expect(url).toBe("https://example.com/push");
  });

  test("getPushUrl returns null when no push URL set", () => {
    const task = createTask({
      senderAssistantId: "assistant-123",
      requestMessage: makeRequestMessage(),
    });

    const url = getPushUrl(task.id);
    expect(url).toBeNull();
  });

  test("getPushUrl returns null for unknown task ID", () => {
    const url = getPushUrl("nonexistent-id");
    expect(url).toBeNull();
  });

  // ── getTask ───────────────────────────────────────────────────

  test("getTask returns null for unknown ID", () => {
    const result = getTask("nonexistent-id");
    expect(result).toBeNull();
  });

  test("getTask returns task with context_id when provided", () => {
    const task = createTask({
      contextId: "ctx-456",
      senderAssistantId: "assistant-123",
      requestMessage: makeRequestMessage(),
    });

    const fetched = getTask(task.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.context_id).toBe("ctx-456");
  });

  // ── linkConversation ──────────────────────────────────────────

  test("linkConversation associates a conversation ID", () => {
    const task = createTask({
      senderAssistantId: "assistant-123",
      requestMessage: makeRequestMessage(),
    });

    linkConversation(task.id, "conv-789");

    // Verify via raw DB since getTask doesn't expose conversationId
    const raw = getSqliteFrom(getDb());
    const row = raw
      .prepare("SELECT conversation_id FROM a2a_tasks WHERE id = ?")
      .get(task.id) as { conversation_id: string };
    expect(row.conversation_id).toBe("conv-789");
  });

  test("linkConversation throws for unknown task ID", () => {
    expect(() => linkConversation("nonexistent-id", "conv-123")).toThrow(
      /not found/,
    );
  });

  // ── updateState error cases ───────────────────────────────────

  test("updateState throws for unknown task ID", () => {
    expect(() => updateState("nonexistent-id", "working")).toThrow(/not found/);
  });
});
