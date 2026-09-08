import { describe, expect, test } from "bun:test";

import { buildProviderMetaForPersistence } from "../daemon/conversation-messaging.js";
import type { ProviderMessageMetadata } from "../messaging/provider-message-metadata.js";
import { readProviderMetadata } from "../messaging/read-provider-metadata.js";

const telegramInbound: ProviderMessageMetadata = {
  source: "telegram",
  conversationExternalId: "chat-42",
  messageId: "msg-100",
  threadId: "topic-7",
  actorExternalId: "user-9",
  displayName: "Alice",
  eventKind: "message",
};

describe("buildProviderMetaForPersistence", () => {
  test("a matching non-Slack turn persists an envelope the neutral reader round-trips", () => {
    const serialized = buildProviderMetaForPersistence({
      channelInbound: telegramInbound,
      turnChannel: "telegram",
    });
    expect(serialized).not.toBeNull();

    // The stored row's metadata JSON carries the envelope under the
    // `providerMeta` key; the canonical reader must resolve it.
    const rowMetadata = JSON.stringify({
      userMessageChannel: "telegram",
      providerMeta: serialized,
    });
    const read = readProviderMetadata(rowMetadata);
    expect(read).toEqual(telegramInbound);
  });

  test("a Slack turn never gains a providerMeta key", () => {
    expect(
      buildProviderMetaForPersistence({
        channelInbound: { ...telegramInbound, source: "slack" },
        turnChannel: "slack",
      }),
    ).toBeNull();
  });

  test("a turn channel that does not match the envelope's source is refused", () => {
    expect(
      buildProviderMetaForPersistence({
        channelInbound: telegramInbound,
        turnChannel: "discord",
      }),
    ).toBeNull();
    expect(
      buildProviderMetaForPersistence({
        channelInbound: telegramInbound,
        turnChannel: undefined,
      }),
    ).toBeNull();
  });

  test("an absent envelope persists nothing", () => {
    expect(
      buildProviderMetaForPersistence({
        channelInbound: undefined,
        turnChannel: "telegram",
      }),
    ).toBeNull();
  });
});
