import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

type MockSlackInfo = {
  id: string;
  name?: string;
  nameNormalized?: string;
} | null;

type MockSlackCategory =
  | "auth"
  | "channel_not_found"
  | "not_found"
  | "permission"
  | "rate_limit"
  | "unknown";

class MockSlackApiError extends Error {
  readonly slackError: string | undefined;
  readonly category: MockSlackCategory;

  constructor(slackError: string | undefined, category: MockSlackCategory) {
    super(`Slack API error: ${slackError ?? "unknown"}`);
    this.name = "SlackApiError";
    this.slackError = slackError;
    this.category = category;
  }
}

const slackInfoCalls: string[] = [];
let slackInfoImpl: (channelId: string) => Promise<MockSlackInfo> = async () =>
  null;

mock.module("../../../messaging/providers/slack/api.js", () => ({
  SlackApiError: MockSlackApiError,
  getSlackConversationInfo: async (channelId: string) => {
    slackInfoCalls.push(channelId);
    return slackInfoImpl(channelId);
  },
}));

import { createConversation } from "../../../memory/conversation-crud.js";
import { getDb, resetDb } from "../../../memory/db-connection.js";
import { initializeDb } from "../../../memory/db-init.js";
import {
  getBindingByConversation,
  upsertBinding,
} from "../../../memory/external-conversation-store.js";
import { ROUTES } from "../slack-channel-routes.js";
import type { RouteDefinition } from "../types.js";

initializeDb();

interface ResolveResponse {
  channelId: string;
  channelName?: string;
  cached: boolean;
  resolved: boolean;
  reason?: string;
}

function resolveHandler(): RouteDefinition["handler"] {
  const route = ROUTES.find(
    (r) => r.operationId === "slack_channel_name_resolve",
  );
  if (!route) throw new Error("slack_channel_name_resolve route not found");
  return route.handler;
}

const handler = resolveHandler();

function clearTables(): void {
  const db = getDb();
  db.run("DELETE FROM external_conversation_bindings");
  db.run("DELETE FROM conversations");
}

function createBoundConversation(input: {
  sourceChannel?: string;
  externalChatId: string;
  externalChatName?: string | null;
  externalThreadId?: string | null;
  externalUserId?: string | null;
  displayName?: string | null;
  username?: string | null;
}): string {
  const conversation = createConversation("Slack route test");
  upsertBinding({
    conversationId: conversation.id,
    sourceChannel: input.sourceChannel ?? "slack",
    externalChatId: input.externalChatId,
    externalChatName: input.externalChatName,
    externalThreadId: input.externalThreadId,
    externalUserId: input.externalUserId,
    displayName: input.displayName,
    username: input.username,
  });
  return conversation.id;
}

async function resolve(conversationId: string): Promise<ResolveResponse> {
  return (await handler({
    pathParams: { conversationId },
  })) as ResolveResponse;
}

beforeEach(() => {
  clearTables();
  slackInfoCalls.length = 0;
  slackInfoImpl = async () => null;
});

afterAll(() => {
  resetDb();
  mock.restore();
});

describe("slack_channel_name_resolve", () => {
  test("returns cached friendly name without calling Slack", async () => {
    const conversationId = createBoundConversation({
      externalChatId: "CACHED123",
      externalChatName: "team-updates",
    });

    const result = await resolve(conversationId);

    expect(result).toEqual({
      channelId: "CACHED123",
      channelName: "team-updates",
      cached: true,
      resolved: true,
    });
    expect(slackInfoCalls).toEqual([]);
  });

  test("resolves an unresolved channel ID and persists the returned name", async () => {
    const conversationId = createBoundConversation({
      externalChatId: "CRESOLVE123",
      externalChatName: "CRESOLVE123",
      externalThreadId: "1710000000.000100",
      externalUserId: "U123",
      displayName: "Alice",
      username: "alice",
    });
    slackInfoImpl = async (channelId) => ({
      id: channelId,
      name: "engineering",
    });

    const result = await resolve(conversationId);

    expect(slackInfoCalls).toEqual(["CRESOLVE123"]);
    expect(result).toEqual({
      channelId: "CRESOLVE123",
      channelName: "engineering",
      cached: false,
      resolved: true,
    });

    const updated = getBindingByConversation(conversationId);
    expect(updated?.externalChatName).toBe("engineering");
    expect(updated?.externalThreadId).toBe("1710000000.000100");
    expect(updated?.externalUserId).toBe("U123");
    expect(updated?.displayName).toBe("Alice");
    expect(updated?.username).toBe("alice");
  });

  test("does not call Slack for DM bindings", async () => {
    const conversationId = createBoundConversation({
      externalChatId: "D123",
      externalChatName: null,
    });

    const result = await resolve(conversationId);

    expect(result).toEqual({
      channelId: "D123",
      cached: false,
      resolved: false,
      reason: "dm",
    });
    expect(slackInfoCalls).toEqual([]);
    expect(getBindingByConversation(conversationId)?.externalChatName).toBe(
      null,
    );
  });

  test("rejects non-Slack bindings", async () => {
    const conversationId = createBoundConversation({
      sourceChannel: "telegram",
      externalChatId: "chat-123",
    });

    await expect(resolve(conversationId)).rejects.toMatchObject({
      code: "NOT_FOUND",
      statusCode: 404,
    });
    expect(slackInfoCalls).toEqual([]);
  });

  test("returns unresolved on Slack API failure without mutating the binding", async () => {
    const conversationId = createBoundConversation({
      externalChatId: "CFAIL123",
      externalChatName: "CFAIL123",
    });
    const before = getBindingByConversation(conversationId);
    slackInfoImpl = async () => {
      throw new MockSlackApiError("missing_scope", "permission");
    };

    const result = await resolve(conversationId);

    expect(result).toEqual({
      channelId: "CFAIL123",
      cached: false,
      resolved: false,
      reason: "permission",
    });
    expect(slackInfoCalls).toEqual(["CFAIL123"]);

    const after = getBindingByConversation(conversationId);
    expect(after?.externalChatName).toBe("CFAIL123");
    expect(after?.updatedAt).toBe(before?.updatedAt);
  });
});
