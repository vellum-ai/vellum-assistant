/**
 * The per-conversation ACP model preference: an explicit choice, keyed per
 * agent, that a later spawn reads before the run starts. It is scoped to a
 * conversation, so it has to go away when the conversation does.
 */

import { afterEach, describe, expect, test } from "bun:test";

import {
  deleteAcpConversationModelPreferences,
  getAcpConversationModelPreference,
  upsertAcpConversationModelPreference,
} from "./acp-model-preference.js";
import {
  createConversation,
  deleteConversation,
  deleteConversationGently,
} from "./conversation-crud.js";
import { getSqlite } from "./db-connection.js";
import { initializeDb } from "./db-init.js";

await initializeDb();

afterEach(() => {
  getSqlite().run("DELETE FROM acp_conversation_model_preference");
});

describe("getAcpConversationModelPreference", () => {
  test("returns undefined when the conversation has chosen nothing", () => {
    expect(
      getAcpConversationModelPreference("conv-1", "claude"),
    ).toBeUndefined();
  });

  test("reads back the recorded choice", () => {
    upsertAcpConversationModelPreference({
      parentConversationId: "conv-1",
      agentId: "claude",
      model: "opus",
    });

    expect(getAcpConversationModelPreference("conv-1", "claude")).toBe("opus");
  });

  test("is scoped to the agent, whose model vocabularies do not overlap", () => {
    upsertAcpConversationModelPreference({
      parentConversationId: "conv-1",
      agentId: "claude",
      model: "opus",
    });

    expect(
      getAcpConversationModelPreference("conv-1", "codex"),
    ).toBeUndefined();
    expect(
      getAcpConversationModelPreference("conv-2", "claude"),
    ).toBeUndefined();
  });
});

describe("upsertAcpConversationModelPreference", () => {
  test("a later choice replaces the earlier one for the same pair", () => {
    upsertAcpConversationModelPreference({
      parentConversationId: "conv-1",
      agentId: "claude",
      model: "opus",
    });
    upsertAcpConversationModelPreference({
      parentConversationId: "conv-1",
      agentId: "claude",
      model: "sonnet",
    });

    expect(getAcpConversationModelPreference("conv-1", "claude")).toBe(
      "sonnet",
    );
    const rows = getSqlite()
      .query("SELECT model FROM acp_conversation_model_preference")
      .all();
    expect(rows).toEqual([{ model: "sonnet" }]);
  });

  test("moves updated_at forward so the row dates the choice, not the first one", () => {
    const before = Date.now();
    upsertAcpConversationModelPreference({
      parentConversationId: "conv-1",
      agentId: "claude",
      model: "opus",
    });
    const first = updatedAt();
    expect(first).toBeGreaterThanOrEqual(before);

    upsertAcpConversationModelPreference({
      parentConversationId: "conv-1",
      agentId: "claude",
      model: "sonnet",
    });

    expect(updatedAt()).toBeGreaterThanOrEqual(first);
  });
});

describe("deleteAcpConversationModelPreferences", () => {
  test("drops every agent's preference for the conversation, and only that one", () => {
    for (const agentId of ["claude", "codex"]) {
      upsertAcpConversationModelPreference({
        parentConversationId: "conv-1",
        agentId,
        model: "opus",
      });
    }
    upsertAcpConversationModelPreference({
      parentConversationId: "conv-2",
      agentId: "claude",
      model: "opus",
    });

    deleteAcpConversationModelPreferences("conv-1");

    expect(
      getAcpConversationModelPreference("conv-1", "claude"),
    ).toBeUndefined();
    expect(
      getAcpConversationModelPreference("conv-1", "codex"),
    ).toBeUndefined();
    expect(getAcpConversationModelPreference("conv-2", "claude")).toBe("opus");
  });

  test("deleting a conversation takes its preferences with it", () => {
    const conversation = createConversation("acp model preference");
    upsertAcpConversationModelPreference({
      parentConversationId: conversation.id,
      agentId: "claude",
      model: "opus",
    });

    deleteConversation(conversation.id);

    expect(
      getAcpConversationModelPreference(conversation.id, "claude"),
    ).toBeUndefined();
  });

  test("the gentle delete purges them too", async () => {
    const conversation = createConversation("acp model preference gently");
    upsertAcpConversationModelPreference({
      parentConversationId: conversation.id,
      agentId: "claude",
      model: "opus",
    });

    await deleteConversationGently(conversation.id);

    expect(
      getAcpConversationModelPreference(conversation.id, "claude"),
    ).toBeUndefined();
  });
});

function updatedAt(): number {
  const row = getSqlite()
    .query(
      `SELECT updated_at FROM acp_conversation_model_preference
       WHERE parent_conversation_id = 'conv-1' AND agent_id = 'claude'`,
    )
    .get() as { updated_at: number };
  return row.updated_at;
}
