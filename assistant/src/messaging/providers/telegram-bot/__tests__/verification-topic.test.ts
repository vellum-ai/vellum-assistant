import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

let getMeResult: { has_topics_enabled?: boolean } | Error = {};
let createTopicResult: { messageThreadId: number; name: string } | Error = {
  messageThreadId: 4242,
  name: "Verification",
};
const createTopicCalls: Array<{ chatId: string; name: string }> = [];

mock.module("../api.js", () => ({
  callTelegramBotApi: async (method: string) => {
    if (method === "getMe") {
      if (getMeResult instanceof Error) throw getMeResult;
      return getMeResult;
    }
    throw new Error(`unexpected method ${method}`);
  },
}));

mock.module("../forum-topics.js", () => ({
  createTelegramForumTopic: async (params: {
    chatId: string;
    name: string;
  }) => {
    createTopicCalls.push(params);
    if (createTopicResult instanceof Error) throw createTopicResult;
    return createTopicResult;
  },
}));

const { resolveVerificationThreadId, resetTelegramThreadedModeCache } =
  await import("../verification-topic.js");

beforeEach(() => {
  createTopicCalls.length = 0;
  resetTelegramThreadedModeCache();
});

afterEach(() => {
  resetTelegramThreadedModeCache();
});

describe("resolveVerificationThreadId", () => {
  test("creates a Verification topic and returns its thread id in threaded mode", async () => {
    getMeResult = { has_topics_enabled: true };
    createTopicResult = { messageThreadId: 4242, name: "Verification" };

    const threadId = await resolveVerificationThreadId("chat-1");

    expect(threadId).toBe("4242");
    expect(createTopicCalls).toEqual([
      { chatId: "chat-1", name: "Verification" },
    ]);
  });

  test("returns undefined (main chat) when threaded mode is off", async () => {
    getMeResult = { has_topics_enabled: false };

    const threadId = await resolveVerificationThreadId("chat-1");

    expect(threadId).toBeUndefined();
    expect(createTopicCalls).toHaveLength(0);
  });

  test("falls back to main chat when topic creation fails", async () => {
    getMeResult = { has_topics_enabled: true };
    createTopicResult = new Error("BOT_FORUM_CREATE_FORBIDDEN");

    const threadId = await resolveVerificationThreadId("chat-1");

    expect(threadId).toBeUndefined();
    expect(createTopicCalls).toHaveLength(1);
  });

  test("falls back to main chat when getMe fails", async () => {
    getMeResult = new Error("network down");

    const threadId = await resolveVerificationThreadId("chat-1");

    expect(threadId).toBeUndefined();
    expect(createTopicCalls).toHaveLength(0);
  });
});
