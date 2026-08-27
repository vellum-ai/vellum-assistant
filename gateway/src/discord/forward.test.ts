import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Logger } from "pino";

import "../__tests__/test-preload.js";

const seededContacts: Array<{
  externalUserId: string;
  externalChatId?: string;
}> = [];
const forwarded: Array<Record<string, unknown>> = [];

const actualContactHelpers = await import("../verification/contact-helpers.js");
mock.module("../verification/contact-helpers.js", () => ({
  ...actualContactHelpers,
  upsertContactChannel: async (params: {
    externalUserId: string;
    externalChatId?: string;
  }) => {
    seededContacts.push(params);
  },
}));

const actualHandleInbound = await import("../handlers/handle-inbound.js");
mock.module("../handlers/handle-inbound.js", () => ({
  ...actualHandleInbound,
  handleInbound: async (_config: unknown, event: Record<string, unknown>) => {
    forwarded.push(event);
    return { forwarded: true, rejected: false };
  },
}));

const { createDiscordInboundEventHandler } = await import("./forward.js");
const { createConversationTaskQueue } =
  await import("../channels/conversation-queue.js");
import type { DiscordInboundEvent } from "../channels/inbound-event.js";
import type { GatewayConfig } from "../config.js";

const noopLog = {
  debug() {},
  info() {},
  warn() {},
  error() {},
} as unknown as Logger;

function makeHandler() {
  return createDiscordInboundEventHandler({
    config: {
      gatewayInternalBaseUrl: "http://127.0.0.1:7830",
    } as GatewayConfig,
    log: noopLog,
    notifyRecordActivity: () => {},
    forwardQueue: createConversationTaskQueue(),
  });
}

function discordEvent(overrides: {
  eventKind: "message" | "edit" | "delete" | "reaction" | "button";
  actorUnattributed?: boolean;
  chatType?: string;
}): DiscordInboundEvent {
  return {
    version: "v1",
    sourceChannel: "discord",
    receivedAt: new Date().toISOString(),
    message: {
      eventKind: overrides.eventKind,
      content: overrides.eventKind === "message" ? "<@bot-1> hi" : "",
      conversationExternalId: "channel-1",
      externalMessageId: `msg-${overrides.eventKind}`,
    },
    actor: {
      actorExternalId: overrides.actorUnattributed
        ? "discord-system"
        : "user-1",
    },
    source: {
      updateId: "u-1",
      messageId: "msg-1",
      chatType: overrides.chatType ?? "channel",
      isDirectMessage: overrides.chatType === "dm",
      ...(overrides.actorUnattributed ? { actorUnattributed: true } : {}),
    },
    raw: {},
  };
}

/** Let the enqueued forward closure run to completion. */
async function drain(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("contact seeding gate", () => {
  beforeEach(() => {
    seededContacts.length = 0;
    forwarded.length = 0;
  });

  test("admitted user-authored kinds seed a contact and forward", async () => {
    const handler = makeHandler();
    handler(discordEvent({ eventKind: "message" }));
    handler(discordEvent({ eventKind: "edit" }));
    await drain();

    expect(seededContacts).toHaveLength(2);
    expect(forwarded).toHaveLength(2);
  });

  test("ungated kinds never seed: a stranger's reaction, press, or delete mints no contact", async () => {
    // These kinds ride with no admission gate in front of them, so a seed
    // here would create a contact record the trust resolver later reads as
    // an existing unverified contact. They still forward; the daemon's own
    // gates decide what they touch.
    const handler = makeHandler();
    handler(discordEvent({ eventKind: "reaction" }));
    handler(discordEvent({ eventKind: "button" }));
    handler(discordEvent({ eventKind: "delete", actorUnattributed: true }));
    await drain();

    expect(seededContacts).toHaveLength(0);
    expect(forwarded).toHaveLength(3);
  });

  test("only a DM records the chat as the contact's delivery address", async () => {
    const handler = makeHandler();
    handler(discordEvent({ eventKind: "message", chatType: "dm" }));
    handler(discordEvent({ eventKind: "message" }));
    await drain();

    expect(seededContacts[0]?.externalChatId).toBe("channel-1");
    expect(seededContacts[1]?.externalChatId).toBeUndefined();
  });
});
