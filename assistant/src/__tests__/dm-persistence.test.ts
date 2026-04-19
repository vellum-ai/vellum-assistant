/**
 * PR 16 — verifies that Slack DMs ride the same persistence path as Slack
 * channel messages. The DM case is structurally identical: `chatType: "im"`
 * still maps to `userMessageChannel === "slack"` (the channel-vs-DM
 * distinction lives on `ChannelCapabilities.chatType`, not `originChannel`),
 * so the metadata enrichment in `persistQueuedMessageBody` is channel-
 * agnostic for any Slack inbound.
 *
 * This test guards against a regression where someone tightens the slackMeta
 * enrichment with a chatType-based guard (`chatType !== "im"` or similar)
 * and silently drops DM rows back into the legacy JIT-hint path that PR 25
 * is set to remove.
 *
 * The test exercises `persistQueuedMessageBody` directly — the same entry
 * point used by `inbound-slack-persistence.test.ts` — to keep the assertion
 * focused on the DM-vs-channel parity rather than the full HTTP plumbing.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

const addMessageCalls: Array<{
  conversationId: string;
  role: string;
  content: string;
  metadata?: Record<string, unknown>;
}> = [];

mock.module("../memory/conversation-crud.js", () => ({
  addMessage: async (
    conversationId: string,
    role: string,
    content: string,
    metadata?: Record<string, unknown>,
  ) => {
    addMessageCalls.push({ conversationId, role, content, metadata });
    return { id: `persisted-${addMessageCalls.length}` };
  },
  getConversation: () => null,
  provenanceFromTrustContext: () => ({}),
  setConversationOriginChannelIfUnset: () => {},
  setConversationOriginInterfaceIfUnset: () => {},
}));

mock.module("../memory/conversation-disk-view.js", () => ({
  syncMessageToDisk: () => {},
  updateMetaFile: () => {},
}));

mock.module("../memory/attachments-store.js", () => ({
  attachmentExists: () => false,
  linkAttachmentToMessage: () => {},
  attachInlineAttachmentToMessage: () => {},
  validateAttachmentUpload: () => ({ ok: true }),
  AttachmentUploadError: class extends Error {},
}));

import type {
  TurnChannelContext,
  TurnInterfaceContext,
} from "../channels/types.js";
import type { MessagingConversationContext } from "../daemon/conversation-messaging.js";
import { persistQueuedMessageBody } from "../daemon/conversation-messaging.js";
import type { MessageQueue } from "../daemon/conversation-queue-manager.js";
import {
  readSlackMetadata,
  type SlackMessageMetadata,
} from "../messaging/providers/slack/message-metadata.js";

function createSlackTurnContext(): MessagingConversationContext {
  // DMs and channel messages both resolve to userMessageChannel === "slack"
  // — the chatType ("im" vs "channel") is carried on ChannelCapabilities,
  // not on the channel string itself. So the same context shape covers
  // both surfaces.
  const channel: TurnChannelContext = {
    userMessageChannel: "slack",
    assistantMessageChannel: "slack",
  };
  const iface: TurnInterfaceContext = {
    userMessageInterface: "slack",
    assistantMessageInterface: "slack",
  };
  const queueStub = {
    push: () => true,
    drain: () => [],
    size: () => 0,
  } as unknown as MessageQueue;
  return {
    conversationId: "conv-dm-test",
    messages: [],
    processing: false,
    abortController: null,
    queue: queueStub,
    getTurnChannelContext: () => channel,
    getTurnInterfaceContext: () => iface,
  };
}

function lastPersistedSlackMeta(): SlackMessageMetadata | null {
  expect(addMessageCalls.length).toBeGreaterThan(0);
  const metadata = addMessageCalls.at(-1)?.metadata;
  expect(metadata).toBeDefined();
  const raw = metadata?.slackMeta;
  if (raw === undefined) return null;
  expect(typeof raw).toBe("string");
  return readSlackMetadata(raw as string);
}

describe("PR 16 — Slack DM persistence parity", () => {
  beforeEach(() => {
    addMessageCalls.length = 0;
  });

  test("DM inbound persists slackMeta with channelId/channelTs and no threadTs", async () => {
    // Simulate a Slack DM: gateway forwards `sourceMetadata.chatType: "im"`
    // and never populates `threadId` because DMs don't have threads. The
    // ingress handler builds a `slackInbound` with no `threadTs` and threads
    // it through to persistence.
    const ctx = createSlackTurnContext();
    await persistQueuedMessageBody(
      ctx,
      "hello from DM",
      [],
      "req-dm",
      {
        slackInbound: {
          channelId: "D0123DM",
          channelTs: "1700000000.123456",
          displayName: "Alice",
        },
      },
      undefined,
    );

    const slackMeta = lastPersistedSlackMeta();
    expect(slackMeta).not.toBeNull();
    expect(slackMeta!.source).toBe("slack");
    expect(slackMeta!.eventKind).toBe("message");
    expect(slackMeta!.channelId).toBe("D0123DM");
    expect(slackMeta!.channelTs).toBe("1700000000.123456");
    expect(slackMeta!.displayName).toBe("Alice");
    // DMs have no threads — `threadTs` must be absent rather than empty.
    expect(slackMeta!.threadTs).toBeUndefined();

    // The transient `slackInbound` carrier key must not leak into the stored
    // metadata column — it's an in-memory plumbing field only.
    const persistedMeta = addMessageCalls.at(-1)!.metadata;
    expect(persistedMeta).toBeDefined();
    expect(persistedMeta!.slackInbound).toBeUndefined();
  });

  test("DM persists slackMeta even when displayName is omitted", async () => {
    // Some DM events arrive with no displayable sender label (e.g. when the
    // gateway can't resolve the user). The envelope should still be written;
    // only the optional displayName field is omitted.
    const ctx = createSlackTurnContext();
    await persistQueuedMessageBody(
      ctx,
      "anonymous DM",
      [],
      "req-dm-anon",
      {
        slackInbound: {
          channelId: "D9999DM",
          channelTs: "1700000000.555555",
        },
      },
      undefined,
    );

    const slackMeta = lastPersistedSlackMeta();
    expect(slackMeta).not.toBeNull();
    expect(slackMeta!.channelId).toBe("D9999DM");
    expect(slackMeta!.channelTs).toBe("1700000000.555555");
    expect(slackMeta!.threadTs).toBeUndefined();
    expect(slackMeta!.displayName).toBeUndefined();
  });

  test("DM and channel-message envelopes differ only by threadTs", async () => {
    // Capture the channel-thread case first.
    const ctx = createSlackTurnContext();
    await persistQueuedMessageBody(
      ctx,
      "channel thread reply",
      [],
      "req-channel",
      {
        slackInbound: {
          channelId: "C0123CHAN",
          channelTs: "1700000000.999999",
          threadTs: "1700000000.111111",
          displayName: "Bob",
        },
      },
      undefined,
    );
    const channelMeta = lastPersistedSlackMeta();
    expect(channelMeta).not.toBeNull();
    expect(channelMeta!.threadTs).toBe("1700000000.111111");

    // Now dispatch a DM and assert that every shared field has the same
    // shape — only `threadTs` (and the inputs themselves) differ.
    addMessageCalls.length = 0;
    await persistQueuedMessageBody(
      ctx,
      "DM reply",
      [],
      "req-dm-2",
      {
        slackInbound: {
          channelId: "D9999DM",
          channelTs: "1700000000.222222",
          displayName: "Carol",
        },
      },
      undefined,
    );
    const dmMeta = lastPersistedSlackMeta();
    expect(dmMeta).not.toBeNull();
    expect(dmMeta!.source).toBe(channelMeta!.source);
    expect(dmMeta!.eventKind).toBe(channelMeta!.eventKind);
    expect(dmMeta!.threadTs).toBeUndefined();
  });
});
