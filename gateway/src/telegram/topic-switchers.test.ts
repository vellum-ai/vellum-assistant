import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import type { ConfigFileCache } from "../config-file-cache.js";
import type { CredentialCache } from "../credential-cache.js";
import { credentialKey } from "../credential-key.js";

// Mock fetch at the transport level (same pattern as send.test.ts) instead of
// mocking ./api.js, which would leak across files in the same Bun process.
type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
let fetchMock: ReturnType<typeof mock<FetchFn>> = mock(
  async () => new Response(),
);

mock.module("../fetch.js", () => ({
  fetchImpl: (...args: Parameters<FetchFn>) => fetchMock(...args),
}));

const { sendTopicSwitcher, resolveTopicSwitcher } =
  await import("./topic-switchers.js");

const testCreds: CredentialCache = {
  get: async (key: string) => {
    if (key === credentialKey("telegram", "bot_token")) return "test-bot-token";
    return undefined;
  },
  invalidate: () => {},
} as unknown as CredentialCache;

const testConfigFile: ConfigFileCache = {
  getNumber: (_section: string, field: string) =>
    field === "maxRetries" ? 0 : undefined,
  getString: () => undefined,
  getBoolean: () => undefined,
  getRecord: () => undefined,
} as unknown as ConfigFileCache;

const caches = { credentials: testCreds, configFile: testConfigFile };

const keyboard = {
  inline_keyboard: [[{ text: "Balanced", callback_data: "prf:balanced" }]],
};

let calls: { method: string; body: Record<string, unknown> }[];
let nextMessageId: number;

beforeEach(() => {
  calls = [];
  nextMessageId = 100;
  fetchMock = mock(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const method = url.split("/").pop() ?? "";
      let body: Record<string, unknown> = {};
      try {
        if (init?.body) body = JSON.parse(String(init.body));
      } catch {
        /* non-JSON body */
      }
      calls.push({ method, body });
      const result =
        method === "sendMessage" ? { message_id: nextMessageId++ } : {};
      return new Response(JSON.stringify({ ok: true, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  );
});

afterEach(() => {
  fetchMock = mock(async () => new Response());
});

describe("topic switchers", () => {
  // Each test uses a distinct chatId because the registry is module-level
  // state that persists across the cases in this file.

  it("posts a switcher without deleting anything the first time", async () => {
    await sendTopicSwitcher({
      caches,
      chatId: "chat-post",
      threadId: "10",
      text: "Choose a profile:",
      keyboard,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("sendMessage");
    expect(calls[0].body.reply_markup).toBeDefined();
    expect(calls[0].body.message_thread_id).toBe(10);
  });

  it("replaces the previous switcher in the same chat/thread", async () => {
    await sendTopicSwitcher({
      caches,
      chatId: "chat-replace",
      threadId: "10",
      text: "first",
      keyboard,
    });
    await sendTopicSwitcher({
      caches,
      chatId: "chat-replace",
      threadId: "10",
      text: "second",
      keyboard,
    });

    expect(calls.map((c) => c.method)).toEqual([
      "sendMessage",
      "deleteMessage",
      "sendMessage",
    ]);
    // The delete targets the first switcher's message id (100).
    expect(calls[1].body.message_id).toBe(100);
  });

  it("keeps switchers in different threads independent", async () => {
    await sendTopicSwitcher({
      caches,
      chatId: "chat-threads",
      threadId: "10",
      text: "a",
      keyboard,
    });
    await sendTopicSwitcher({
      caches,
      chatId: "chat-threads",
      threadId: "20",
      text: "b",
      keyboard,
    });

    expect(calls.map((c) => c.method)).toEqual(["sendMessage", "sendMessage"]);
  });

  it("resolve edits the message in place and clears the registry", async () => {
    await sendTopicSwitcher({
      caches,
      chatId: "chat-resolve",
      threadId: "10",
      text: "Choose:",
      keyboard,
    });

    await resolveTopicSwitcher({
      caches,
      chatId: "chat-resolve",
      threadId: "10",
      messageId: "100",
      text: "Using Balanced profile.",
    });

    expect(calls[1].method).toBe("editMessageText");
    expect(calls[1].body.message_id).toBe(100);
    expect(calls[1].body.text).toBe("Using Balanced profile.");
    expect(calls[1].body.reply_markup).toBeUndefined();

    // After resolve the entry is gone, so the next switcher does not delete.
    await sendTopicSwitcher({
      caches,
      chatId: "chat-resolve",
      threadId: "10",
      text: "again",
      keyboard,
    });

    expect(calls.map((c) => c.method)).toEqual([
      "sendMessage",
      "editMessageText",
      "sendMessage",
    ]);
  });
});
