/**
 * The per-conversation ACP model preference: an explicit choice, keyed per
 * agent, that a later spawn reads before the run starts. It is scoped to a
 * conversation, so it has to go away when the conversation does.
 */

import { afterEach, describe, expect, test } from "bun:test";

import {
  getAcpConversationModelPreference,
  upsertAcpConversationModelPreference,
} from "./acp-model-preference.js";
import {
  clearAll,
  createConversation,
  deleteConversation,
  deleteConversationGently,
} from "./conversation-crud.js";
import { getSqlite } from "./db-connection.js";
import { initializeDb } from "./db-init.js";

await initializeDb();

/** The rows carry a foreign key, so every preference needs a real parent. */
function newConversationId(title: string): string {
  return createConversation(title).id;
}

afterEach(() => {
  getSqlite().run("DELETE FROM acp_conversation_model_preference");
});

describe("getAcpConversationModelPreference", () => {
  test("returns undefined when the conversation has chosen nothing", () => {
    expect(
      getAcpConversationModelPreference(newConversationId("nothing"), "claude"),
    ).toBeUndefined();
  });

  test("reads back the recorded choice", () => {
    const id = newConversationId("recorded choice");
    upsertAcpConversationModelPreference({
      parentConversationId: id,
      agentId: "claude",
      model: "opus",
    });

    expect(getAcpConversationModelPreference(id, "claude")).toBe("opus");
  });

  test("is scoped to the agent, whose model vocabularies do not overlap", () => {
    const id = newConversationId("agent scope");
    const other = newConversationId("agent scope other");
    upsertAcpConversationModelPreference({
      parentConversationId: id,
      agentId: "claude",
      model: "opus",
    });

    expect(getAcpConversationModelPreference(id, "codex")).toBeUndefined();
    expect(getAcpConversationModelPreference(other, "claude")).toBeUndefined();
  });
});

describe("upsertAcpConversationModelPreference", () => {
  test("a later choice replaces the earlier one for the same pair", () => {
    const id = newConversationId("replace");
    upsertAcpConversationModelPreference({
      parentConversationId: id,
      agentId: "claude",
      model: "opus",
    });
    upsertAcpConversationModelPreference({
      parentConversationId: id,
      agentId: "claude",
      model: "sonnet",
    });

    expect(getAcpConversationModelPreference(id, "claude")).toBe("sonnet");
    const rows = getSqlite()
      .query("SELECT model FROM acp_conversation_model_preference")
      .all();
    expect(rows).toEqual([{ model: "sonnet" }]);
  });

  test("moves updated_at forward so the row dates the choice, not the first one", () => {
    const id = newConversationId("updated at");
    const before = Date.now();
    upsertAcpConversationModelPreference({
      parentConversationId: id,
      agentId: "claude",
      model: "opus",
    });
    const first = updatedAt(id);
    expect(first).toBeGreaterThanOrEqual(before);

    upsertAcpConversationModelPreference({
      parentConversationId: id,
      agentId: "claude",
      model: "sonnet",
    });

    expect(updatedAt(id)).toBeGreaterThanOrEqual(first);
  });
});

describe("conversation cascade", () => {
  test("deleting a conversation takes every agent's preference with it, and only that conversation's", () => {
    const id = newConversationId("cascade");
    const other = newConversationId("cascade other");
    for (const agentId of ["claude", "codex"]) {
      upsertAcpConversationModelPreference({
        parentConversationId: id,
        agentId,
        model: "opus",
      });
    }
    upsertAcpConversationModelPreference({
      parentConversationId: other,
      agentId: "claude",
      model: "opus",
    });

    deleteConversation(id);

    expect(getAcpConversationModelPreference(id, "claude")).toBeUndefined();
    expect(getAcpConversationModelPreference(id, "codex")).toBeUndefined();
    expect(getAcpConversationModelPreference(other, "claude")).toBe("opus");
  });

  test("the gentle delete cascades too", async () => {
    const id = newConversationId("gently");
    upsertAcpConversationModelPreference({
      parentConversationId: id,
      agentId: "claude",
      model: "opus",
    });

    await deleteConversationGently(id);

    expect(getAcpConversationModelPreference(id, "claude")).toBeUndefined();
  });

  test("clear-all wipes them, so a reused id inherits no one else's choice", async () => {
    upsertAcpConversationModelPreference({
      parentConversationId: newConversationId("clear all"),
      agentId: "claude",
      model: "opus",
    });

    await clearAll();

    expect(
      getSqlite()
        .query("SELECT COUNT(*) AS c FROM acp_conversation_model_preference")
        .get(),
    ).toEqual({ c: 0 });
  });
});

function updatedAt(parentConversationId: string): number {
  const row = getSqlite()
    .query(
      `SELECT updated_at FROM acp_conversation_model_preference
       WHERE parent_conversation_id = ? AND agent_id = 'claude'`,
    )
    .get(parentConversationId) as { updated_at: number };
  return row.updated_at;
}
