import { beforeEach, describe, expect, test } from "bun:test";

import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import {
  queryUnreportedUsageEvents,
  recordUsageEvent,
} from "../persistence/llm-usage-store.js";
import type { PricingResult, UsageEventInput } from "../usage/types.js";
import { buildTurnUsageOriginSnapshot } from "../usage/usage-origin-snapshot.js";

await initializeDb();

const priced: PricingResult = {
  estimatedCostUsd: 0.001,
  pricingStatus: "priced",
};

function makeInput(conversationId: string): UsageEventInput {
  return {
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    inputTokens: 100,
    outputTokens: 50,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
    rawUsage: null,
    actor: "main_agent",
    conversationId,
    runId: null,
    requestId: null,
  };
}

/** Record one usage event on a conversation at a specific created_at. */
function insertEventAt(timestamp: number, conversationId: string): void {
  const event = recordUsageEvent(makeInput(conversationId), priced);
  getDb().run(
    `UPDATE llm_usage_events SET created_at = ${timestamp} WHERE id = '${event.id}'`,
  );
}

function insertConversation(
  id: string,
  conversationType = "standard",
  createdAt = 0,
): void {
  getDb().run(
    `INSERT OR IGNORE INTO conversations (id, conversation_type, created_at, updated_at) VALUES ('${id}', '${conversationType}', ${createdAt}, ${createdAt})`,
  );
}

function insertUserMessage(
  id: string,
  conversationId: string,
  createdAt: number,
): void {
  getDb().run(
    `INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES ('${id}', '${conversationId}', 'user', 'text', ${createdAt})`,
  );
}

describe("buildTurnUsageOriginSnapshot", () => {
  beforeEach(() => {
    const db = getDb();
    db.run(`DELETE FROM llm_usage_events`);
    db.run(`DELETE FROM messages`);
    db.run(`DELETE FROM conversations`);
  });

  test("top-level user conversation: turnIndex counted, parentTurnIndex null", () => {
    insertConversation("conv-user");
    insertUserMessage("u1", "conv-user", 1000);
    insertUserMessage("u2", "conv-user", 2000);

    const snapshot = buildTurnUsageOriginSnapshot(
      {
        conversationId: "conv-user",
        conversationType: "standard",
        source: "user",
        parentConversationId: null,
        forkParentConversationId: null,
      },
      "mainAgent",
    );

    expect(snapshot.turnIndex).toBe(2);
    expect(snapshot.parentConversationId).toBeNull();
    expect(snapshot.parentTurnIndex).toBeNull();
    expect(snapshot.workOrigin).toBe("user_interactive");
  });

  // A subagent's background conversation carries the live subagent parent. Its
  // parentTurnIndex must count the PARENT conversation's real user turns —
  // matching the telemetry read path, which counts the same population up to
  // the child's creation. At snapshot time the parent's turns already exist, so
  // counting them all equals telemetry's cutoff count.
  test("subagent child: parentTurnIndex counts the parent's turns and agrees with telemetry", () => {
    const db = getDb();
    insertConversation("parent-1");
    insertUserMessage("p1", "parent-1", 1000);
    insertUserMessage("p2", "parent-1", 2000);
    db.run(
      `INSERT INTO conversations (id, conversation_type, created_at, updated_at, parent_conversation_id) VALUES ('child-1', 'background', 3000, 3000, 'parent-1')`,
    );
    insertUserMessage("c1", "child-1", 3100);
    insertEventAt(4000, "child-1");

    const snapshot = buildTurnUsageOriginSnapshot(
      {
        conversationId: "child-1",
        conversationType: "background",
        source: "subagent",
        parentConversationId: "parent-1",
        forkParentConversationId: null,
      },
      "subagentSpawn",
    );

    expect(snapshot.parentConversationId).toBe("parent-1");
    expect(snapshot.turnIndex).toBe(1);
    expect(snapshot.parentTurnIndex).toBe(2);
    expect(snapshot.workOrigin).toBe("delegated_child");

    // Telemetry resolves the same parent and counts the same population.
    const events = queryUnreportedUsageEvents(0, undefined, 100);
    expect(events).toHaveLength(1);
    expect(events[0].parentConversationId).toBe("parent-1");
    expect(events[0].parentTurnIndex).toBe(snapshot.parentTurnIndex);
  });

  // A retrospective fork is a background conversation with no live subagent
  // parent; its spawn parent is the source via fork_parent_conversation_id. The
  // parentTurnIndex counts the SOURCE's real user turns.
  test("retrospective fork: resolves the fork parent and counts its turns", () => {
    const db = getDb();
    insertConversation("source-1");
    insertUserMessage("s1", "source-1", 1000);
    insertUserMessage("s2", "source-1", 2000);
    // Fork through the latest source message (s2), as real retrospectives do.
    db.run(
      `INSERT INTO conversations (id, conversation_type, created_at, updated_at, fork_parent_conversation_id, fork_parent_message_id) VALUES ('retro-1', 'background', 3000, 3000, 'source-1', 's2')`,
    );
    insertEventAt(4000, "retro-1");

    const snapshot = buildTurnUsageOriginSnapshot(
      {
        conversationId: "retro-1",
        conversationType: "background",
        source: "memory-retrospective-fork",
        parentConversationId: null,
        forkParentConversationId: "source-1",
      },
      "memoryRetrospective",
    );

    expect(snapshot.parentConversationId).toBe("source-1");
    expect(snapshot.parentTurnIndex).toBe(2);
    expect(snapshot.workOrigin).toBe("delegated_child");

    const events = queryUnreportedUsageEvents(0, undefined, 100);
    expect(events[0].parentConversationId).toBe("source-1");
    expect(events[0].parentTurnIndex).toBe(snapshot.parentTurnIndex);
  });

  test("user-initiated (standard) fork does not inherit fork-parent attribution", () => {
    insertConversation("source-2");
    insertConversation("user-fork");
    insertUserMessage("s1", "source-2", 1000);
    insertUserMessage("f1", "user-fork", 2000);

    const snapshot = buildTurnUsageOriginSnapshot(
      {
        conversationId: "user-fork",
        conversationType: "standard",
        source: "user",
        parentConversationId: null,
        forkParentConversationId: "source-2",
      },
      "mainAgent",
    );

    expect(snapshot.parentConversationId).toBeNull();
    expect(snapshot.parentTurnIndex).toBeNull();
    expect(snapshot.workOrigin).toBe("user_interactive");
  });
});
