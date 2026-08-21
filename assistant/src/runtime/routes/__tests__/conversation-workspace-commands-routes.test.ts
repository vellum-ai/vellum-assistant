import { beforeEach, describe, expect, test } from "bun:test";

import { getDb } from "../../../persistence/db-connection.js";
import { initializeDb } from "../../../persistence/db-init.js";
import { conversations } from "../../../persistence/schema/index.js";
import { upsertBinding } from "../../../persistence/external-conversation-store.js";
import { ROUTES } from "../conversation-workspace-commands-routes.js";
import type { RouteDefinition } from "../types.js";

await initializeDb();

function findHandler(operationId: string) {
  const route = ROUTES.find((r: RouteDefinition) => r.operationId === operationId);
  if (!route) {
    throw new Error(`Route ${operationId} not found`);
  }
  return route.handler;
}

const getHandler = findHandler("getConversationWorkspaceCommands");
const putHandler = findHandler("setConversationWorkspaceCommands");
const getCliHandler = findHandler("conversation_workspace_commands_get_cli");
const setCliHandler = findHandler("conversation_workspace_commands_set_cli");

function seedConversation(id: string): void {
  const now = Date.now();
  getDb()
    .insert(conversations)
    .values({
      id,
      title: "Slack DM",
      createdAt: now,
      updatedAt: now,
      source: "test",
      conversationType: "standard",
    })
    .run();
}

function clear(): void {
  getDb().run("DELETE FROM scoped_approval_grants");
  getDb().run("DELETE FROM external_conversation_bindings");
  getDb().delete(conversations).run();
}

describe("conversation workspace-commands routes", () => {
  beforeEach(() => {
    clear();
    seedConversation("conv-xyz");
  });

  test("GET reports disabled until a standing grant is written", async () => {
    const before = await getHandler({ pathParams: { id: "conv-xyz" } });
    expect(before).toEqual({ conversationId: "conv-xyz", enabled: false });

    const after = await putHandler({
      pathParams: { id: "conv-xyz" },
      body: { enabled: true },
    });
    expect(after).toEqual({ conversationId: "conv-xyz", enabled: true });

    const reread = await getHandler({ pathParams: { id: "conv-xyz" } });
    expect(reread).toEqual({ conversationId: "conv-xyz", enabled: true });
  });

  test("PUT enabled false revokes the standing grant", async () => {
    await putHandler({
      pathParams: { id: "conv-xyz" },
      body: { enabled: true },
    });
    const denied = await putHandler({
      pathParams: { id: "conv-xyz" },
      body: { enabled: false },
    });
    expect(denied).toEqual({ conversationId: "conv-xyz", enabled: false });
  });

  test("CLI allow resolves a Slack user DM", async () => {
    upsertBinding({
      conversationId: "conv-xyz",
      sourceChannel: "slack",
      externalChatId: "D01234567",
      externalUserId: "U12345678",
    });

    const result = await setCliHandler({
      body: { slackUserId: "U12345678", enabled: true },
    });
    expect(result).toEqual({ conversationId: "conv-xyz", enabled: true });

    const status = await getCliHandler({
      body: { slackChannelId: "D01234567" },
    });
    expect(status).toEqual({ conversationId: "conv-xyz", enabled: true });
  });

  test("CLI rejects multiple identifiers", async () => {
    await expect(
      getCliHandler({
        body: { conversationId: "conv-xyz", slackUserId: "U12345678" },
      }),
    ).rejects.toThrow("exactly one");
  });
});
