/**
 * A verification reply reaches the person through the daemon's channel
 * transport for the chat the code came from.
 *
 * The gateway consumes the code itself, so no turn runs and no turn reply
 * goes out: this reply is the only thing the person hears back. The session
 * store is real; the assistant IPC socket is the boundary.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import {
  DELIVER_GATEWAY_REPLY_IPC_METHOD,
  hashVerificationSecret,
} from "@vellumai/gateway-client";

let ipcCalls: { method: string; params?: Record<string, unknown> }[] = [];

// Spread the actual module so untouched exports stay importable by
// later-loaded files when suites share a bun process.
const actualAssistantClient = await import("../ipc/assistant-client.js");
mock.module("../ipc/assistant-client.js", () => ({
  ...actualAssistantClient,
  ipcCallAssistant: async (
    method: string,
    params?: Record<string, unknown>,
  ) => {
    ipcCalls.push({ method, params });
    return { ok: true, messageIds: ["1"] };
  },
}));

await import("./test-preload.js");
const { getGatewayDb, initGatewayDb, resetGatewayDb } =
  await import("../db/connection.js");
const { channelVerificationSessions } = await import("../db/schema.js");
const { createOutboundSession } = await import("../db/session-store.js");
const { tryTextVerificationIntercept } =
  await import("../verification/text-verification.js");

const CHANNEL = "telegram";
const ACTOR = "777000";
const CODE = "123456";
// The path the gateway's Telegram webhook builds, on a reserved host: a fetch
// of this URL cannot reach a live service.
const REPLY_URL = "http://gateway.invalid/deliver/telegram";

function replies(): Record<string, unknown>[] {
  return ipcCalls
    .filter((c) => c.method === DELIVER_GATEWAY_REPLY_IPC_METHOD)
    .map((c) => c.params!.body as Record<string, unknown>);
}

function interceptParams(overrides: Record<string, unknown> = {}) {
  return {
    sourceChannel: CHANNEL,
    messageContent: CODE,
    actorExternalUserId: ACTOR,
    actorChatId: ACTOR,
    replyCallbackUrl: REPLY_URL,
    assistantId: "self",
    ...overrides,
  };
}

beforeAll(async () => {
  await initGatewayDb();
});

beforeEach(() => {
  ipcCalls = [];
  getGatewayDb().delete(channelVerificationSessions).run();
  createOutboundSession({
    id: "session-1",
    channel: CHANNEL,
    challengeHash: hashVerificationSecret(CODE),
    expiresAt: Date.now() + 10 * 60 * 1000,
    status: "awaiting_response",
    expectedExternalUserId: ACTOR,
    identityBindingStatus: "bound",
    destinationAddress: ACTOR,
    verificationPurpose: "trusted_contact",
  });
});

afterAll(() => {
  resetGatewayDb();
});

describe("text verification reply", () => {
  test("a wrong code is answered in the sender's chat", async () => {
    const result = await tryTextVerificationIntercept(
      interceptParams({ messageContent: "654321", isDirectMessage: true }),
    );

    expect(result.intercepted).toBe(true);
    if (result.intercepted) {
      expect(result.pendingReplyText).toBeUndefined();
    }
    expect(replies()).toEqual([
      {
        callbackUrl: REPLY_URL,
        chatId: ACTOR,
        text: "The verification code is invalid or has expired.",
        assistantId: "self",
      },
    ]);
  });

  test("a code posted in a room is answered with where to send it", async () => {
    await tryTextVerificationIntercept(
      interceptParams({ actorChatId: "-100200300", isDirectMessage: false }),
    );

    expect(replies()).toHaveLength(1);
    expect(replies()[0]).toMatchObject({
      callbackUrl: REPLY_URL,
      chatId: "-100200300",
    });
    expect(String(replies()[0]!.text)).toContain("direct message");
    expect(String(replies()[0]!.text)).not.toContain(CODE);
  });
});
