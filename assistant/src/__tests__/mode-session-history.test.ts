import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { setConfig } from "./helpers/set-config.js";

setConfig("memory", { enabled: false });

import type { ModeSessionDescriptor } from "../api/mode-session.js";
import type { ConversationMessage } from "../api/responses/conversation-message.js";
import { setModeSessionRecoveryHealthy } from "../config/session-groups-gate.js";
import type { Conversation } from "../daemon/conversation.js";
import { ConversationModeSessionCoordinator } from "../daemon/conversation-mode-session.js";
import {
  clearConversations,
  setConversation,
} from "../daemon/conversation-registry.js";
import {
  addMessage,
  createConversation,
} from "../persistence/conversation-crud.js";
import {
  beginConversationModeSession,
  finalizeConversationModeSession,
} from "../persistence/conversation-mode-sessions.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { handleListMessages } from "../runtime/routes/conversation-routes.js";

await initializeDb();

interface MessagesResponse {
  messages: ConversationMessage[];
  modeSessions?: ModeSessionDescriptor[];
}

function registerCoordinator(
  conversationId: string,
  coordinator: ConversationModeSessionCoordinator,
): void {
  setConversation(conversationId, {
    modeSessions: coordinator,
    isProcessing: () => false,
    snapshotQueuedMessages: () => [],
  } as unknown as Conversation);
}

describe("mode-session history projection", () => {
  afterEach(() => {
    setModeSessionRecoveryHealthy(true);
    clearConversations();
  });

  test("omits unrecovered active descriptors while preserving terminal history and stamps", async () => {
    const conversation = createConversation();
    for (const id of ["active-session", "terminal-session"]) {
      beginConversationModeSession({
        id,
        conversationId: conversation.id,
        mode: "browser",
        sourceStartedAt: 100,
      });
      await addMessage(
        conversation.id,
        "assistant",
        JSON.stringify([{ type: "text", text: id }]),
        {
          id: `${id}-message`,
          metadata: { modeSession: { mode: "browser", id } },
          skipIndexing: true,
        },
      );
    }
    finalizeConversationModeSession({
      id: "terminal-session",
      conversationId: conversation.id,
      expectedRevision: 1,
      status: "completed",
      endedAt: 200,
      endReason: "settled",
    });
    setModeSessionRecoveryHealthy(false);
    const response = (await handleListMessages({
      queryParams: { conversationId: conversation.id },
    })) as unknown as MessagesResponse;
    expect(response.modeSessions?.map(({ summary }) => summary.id)).toEqual([
      "terminal-session",
    ]);
    expect(response.messages.map((message) => message.modeSession?.id)).toEqual(
      ["active-session", "terminal-session"],
    );
  });
  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM messages");
    db.run("DELETE FROM conversation_mode_sessions");
    db.run("DELETE FROM conversations");
  });

  test.each([false, true])(
    "omits orphaned active descriptors with live coordinator=%s",
    async (hasCoordinator) => {
      const conversation = createConversation();
      beginConversationModeSession({
        id: "orphan-session",
        conversationId: conversation.id,
        mode: "browser",
        sourceStartedAt: 100,
      });
      await addMessage(
        conversation.id,
        "assistant",
        JSON.stringify([{ type: "text", text: "Saved output" }]),
        {
          metadata: { modeSession: { id: "orphan-session", mode: "browser" } },
          skipIndexing: true,
        },
      );
      if (hasCoordinator) {
        registerCoordinator(
          conversation.id,
          new ConversationModeSessionCoordinator(conversation.id),
        );
      }
      const response = (await handleListMessages({
        queryParams: {
          conversationId: conversation.id,
          modeSessionIds: "orphan-session",
        },
      })) as unknown as MessagesResponse;
      expect(response.modeSessions).toBeUndefined();
      expect(response.messages[0]?.modeSession).toEqual({
        id: "orphan-session",
        mode: "browser",
      });
    },
  );

  test("returns same-conversation summaries, membership, aliases, and activity", async () => {
    const conversation = createConversation();
    const coordinator = new ConversationModeSessionCoordinator(conversation.id);
    registerCoordinator(conversation.id, coordinator);
    const session = coordinator.activateSource({
      sourceId: "browser-source",
      generation: 1,
      mode: "browser",
      sourceStartedAt: 100,
    })!;
    const requestedSession = coordinator.activateSource({
      sourceId: "computer-source",
      generation: 1,
      mode: "computer_use",
      sourceStartedAt: 200,
    })!;

    await addMessage(
      conversation.id,
      "assistant",
      JSON.stringify([{ type: "text", text: "First" }]),
      {
        id: "assistant-123",
        metadata: {
          modeSession: { mode: "browser", id: session.id },
          sentAt: 120,
        },
        skipIndexing: true,
      },
    );
    await addMessage(
      conversation.id,
      "assistant",
      JSON.stringify([{ type: "text", text: "Second" }]),
      {
        id: "assistant-456",
        metadata: {
          modeSession: { mode: "browser", id: session.id },
          sentAt: 180,
        },
        skipIndexing: true,
      },
    );

    const response = (await handleListMessages({
      queryParams: {
        conversationId: conversation.id,
        modeSessionIds: requestedSession.id,
      },
    })) as unknown as MessagesResponse;

    expect(response.messages).toHaveLength(1);
    expect(response.messages[0]).toMatchObject({
      id: "assistant-123",
      mergedMessageIds: ["assistant-456"],
      modeSession: { mode: "browser", id: session.id },
      modeSessionActivity: { firstAt: 120, lastAt: 180 },
    });
    expect(
      response.modeSessions?.map((descriptor) => descriptor.summary.id).sort(),
    ).toEqual([session.id, requestedSession.id].sort());
  });

  test("drops copied membership without a child-owned lifecycle record", async () => {
    const parent = createConversation();
    const child = createConversation();
    expect(
      beginConversationModeSession({
        id: "session-parent",
        conversationId: parent.id,
        mode: "browser",
        sourceStartedAt: 100,
      }).ok,
    ).toBe(true);
    await addMessage(
      child.id,
      "assistant",
      JSON.stringify([{ type: "text", text: "Copied" }]),
      {
        metadata: {
          modeSession: { mode: "browser", id: "session-parent" },
        },
        skipIndexing: true,
      },
    );

    const response = (await handleListMessages({
      queryParams: { conversationId: child.id },
    })) as unknown as MessagesResponse;

    expect(response.messages).toHaveLength(1);
    expect(response.messages[0]).not.toHaveProperty("modeSession");
    expect(response.messages[0]).not.toHaveProperty("modeSessionActivity");
    expect(response.modeSessions).toBeUndefined();
  });

  test("bounds and validates explicitly requested IDs", async () => {
    const conversation = createConversation();
    const ids = Array.from({ length: 101 }, (_, index) => `session-${index}`);
    await expect(
      handleListMessages({
        queryParams: {
          conversationId: conversation.id,
          modeSessionIds: ids.join(","),
        },
      }),
    ).rejects.toThrow("modeSessionIds contains an invalid session ID");
  });
});
