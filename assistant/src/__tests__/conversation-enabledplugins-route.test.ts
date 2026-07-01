import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { makeMockLogger } from "./helpers/mock-logger.js";

mock.module("../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

const config = {
  llm: {
    profiles: {},
  },
};

mock.module("../config/loader.js", () => ({
  loadConfig: () => config,
  getConfig: () => config,
}));

import {
  createConversation,
  getConversation,
} from "../persistence/conversation-crud.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { ROUTES } from "../runtime/routes/conversation-management-routes.js";
import { BadRequestError, NotFoundError } from "../runtime/routes/errors.js";
import { buildConversationDetailResponse } from "../runtime/services/conversation-serializer.js";
import { resetDbForTesting } from "./db-test-helpers.js";

await initializeDb();

const pluginsRoute = ROUTES.find(
  (r) => r.operationId === "conversations_by_id_enabledplugins_put",
)!;

function clearTables(): void {
  const db = getDb();
  db.run("DELETE FROM conversation_assistant_attention_state");
  db.run("DELETE FROM external_conversation_bindings");
  db.run("DELETE FROM conversation_keys");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

describe("PUT /v1/conversations/:id/enabledplugins", () => {
  beforeEach(() => {
    clearTables();
  });

  afterAll(() => {
    resetDbForTesting();
    mock.restore();
  });

  test("persists a string[] scope and reflects it on the conversation", async () => {
    const conversation = createConversation("enabledplugins-route");

    const result = await pluginsRoute.handler({
      pathParams: { id: conversation.id },
      body: { enabledPlugins: ["plugin-a", "plugin-b"] },
      headers: {},
    });

    expect(result).toMatchObject({
      conversationId: conversation.id,
      enabledPlugins: ["plugin-a", "plugin-b"],
    });
    expect(getConversation(conversation.id)?.enabledPlugins).toEqual([
      "plugin-a",
      "plugin-b",
    ]);

    // The HTTP conversation-detail response (what the web `conversationsByIdGet`
    // reads) must also carry the scope, not just the internal DB getter.
    const detail = buildConversationDetailResponse(conversation.id);
    expect(detail?.conversation.enabledPlugins).toEqual([
      "plugin-a",
      "plugin-b",
    ]);
  });

  test("detail response omits enabledPlugins by default and preserves an explicit []", async () => {
    const conversation = createConversation("enabledplugins-detail-shape");

    // Default (no per-chat restriction): the field is omitted from the wire.
    expect(
      "enabledPlugins" in buildConversationDetailResponse(conversation.id)!
        .conversation,
    ).toBe(false);

    // Explicit empty scope (user cleared all optional plugins): preserved as [].
    await pluginsRoute.handler({
      pathParams: { id: conversation.id },
      body: { enabledPlugins: [] },
      headers: {},
    });
    expect(
      buildConversationDetailResponse(conversation.id)?.conversation
        .enabledPlugins,
    ).toEqual([]);
  });

  test("clears the scope to default when enabledPlugins is null", async () => {
    const conversation = createConversation("enabledplugins-clear");

    await pluginsRoute.handler({
      pathParams: { id: conversation.id },
      body: { enabledPlugins: ["plugin-x"] },
      headers: {},
    });
    expect(getConversation(conversation.id)?.enabledPlugins).toEqual([
      "plugin-x",
    ]);

    const result = await pluginsRoute.handler({
      pathParams: { id: conversation.id },
      body: { enabledPlugins: null },
      headers: {},
    });

    expect(result).toMatchObject({
      conversationId: conversation.id,
      enabledPlugins: null,
    });
    expect(getConversation(conversation.id)?.enabledPlugins).toBeNull();
  });

  test("rejects a non-array, non-null body with BadRequestError", async () => {
    const conversation = createConversation("enabledplugins-bad");

    await expect(
      pluginsRoute.handler({
        pathParams: { id: conversation.id },
        body: { enabledPlugins: "not-an-array" },
        headers: {},
      }),
    ).rejects.toThrow(BadRequestError);
    expect(getConversation(conversation.id)?.enabledPlugins).toBeNull();
  });

  test("rejects an array containing a non-string with BadRequestError", async () => {
    const conversation = createConversation("enabledplugins-bad-element");

    await expect(
      pluginsRoute.handler({
        pathParams: { id: conversation.id },
        body: { enabledPlugins: ["ok", 123] },
        headers: {},
      }),
    ).rejects.toThrow(BadRequestError);
    expect(getConversation(conversation.id)?.enabledPlugins).toBeNull();
  });

  test("throws NotFoundError when the conversation does not exist", async () => {
    await expect(
      pluginsRoute.handler({
        pathParams: { id: "missing" },
        body: { enabledPlugins: [] },
        headers: {},
      }),
    ).rejects.toThrow(NotFoundError);
  });
});
