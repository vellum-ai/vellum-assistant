/**
 * PR 11 — verifies that inbound Slack messages persist a `slackMeta`
 * sub-object on the row's metadata column, sourced from gateway-forwarded
 * `sourceMetadata.threadId` (the field PR 2 added) and the message's own
 * Slack `ts` (`sourceMetadata.messageId`).
 *
 * The test exercises the persistence layer directly via
 * `persistQueuedMessageBody` rather than spinning up the full HTTP stack:
 *   - `Server.processMessage` materializes `slackInbound` into the
 *     `metadata` parameter passed to `Conversation.persistUserMessage`,
 *     which delegates to this function.
 *   - The wiring between the HTTP handler and that call is type-checked
 *     end-to-end (see `inbound-message-handler.ts:705`,
 *     `background-dispatch.ts:188`, `server.ts:1652`).
 *
 * A non-Slack control case asserts that the enrichment is silent for other
 * channels — no `slackMeta` key appears in the persisted metadata.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks (must precede module imports under test)
// ---------------------------------------------------------------------------

const addMessageCalls: Array<{
  conversationId: string;
  role: string;
  content: string;
  metadata?: Record<string, unknown>;
}> = [];

mock.module("../persistence/conversation-crud.js", () => ({
  setConversationProcessingStartedAt: () => {},
  isConversationProcessing: () => false,
  addMessage: async (
    conversationId: string,
    role: string,
    content: string,
    options?: { metadata?: Record<string, unknown> },
  ) => {
    addMessageCalls.push({
      conversationId,
      role,
      content,
      metadata: options?.metadata,
    });
    return { id: `persisted-${addMessageCalls.length}` };
  },
  getConversation: () => null,
  provenanceFromTrustContext: () => ({}),
  setConversationOriginChannelIfUnset: () => {},
  setConversationOriginInterfaceIfUnset: () => {},
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
}));

mock.module("../persistence/conversation-disk-view.js", () => ({
  syncMessageToDisk: () => {},
  updateMetaFile: () => {},
}));

mock.module("../persistence/attachments-store.js", () => ({
  attachmentExists: () => false,
  linkAttachmentToMessage: () => {},
  attachInlineAttachmentToMessage: () => {},
  validateAttachmentUpload: () => ({ ok: true }),
  AttachmentUploadError: class extends Error {},
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestContext(
  turnChannel: TurnChannelContext | null,
): MessagingConversationContext {
  const queueStub = {
    push: () => true,
    drain: () => [],
    size: () => 0,
  } as unknown as MessageQueue;

  const turnIfCtx: TurnInterfaceContext | null = turnChannel
    ? {
        userMessageInterface: "slack",
        assistantMessageInterface: "slack",
      }
    : null;

  let processing = false;
  return {
    conversationId: "conv-test",
    messages: [],
    isProcessing: () => processing,
    setProcessing: (value: boolean) => {
      processing = value;
    },
    abortController: null,
    queue: queueStub,
    getTurnChannelContext: () => turnChannel,
    getTurnInterfaceContext: () => turnIfCtx,
  };
}

function lastPersistedMetadata(): Record<string, unknown> {
  expect(addMessageCalls.length).toBeGreaterThan(0);
  const metadata = addMessageCalls.at(-1)?.metadata;
  expect(metadata).toBeDefined();
  return metadata!;
}

function readPersistedSlackMeta(): SlackMessageMetadata | null {
  const metadata = lastPersistedMetadata();
  const raw = metadata.slackMeta;
  if (raw === undefined) return null;
  expect(typeof raw).toBe("string");
  return readSlackMetadata(raw as string);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PR 11 — inbound Slack message metadata persistence", () => {
  beforeEach(() => {
    addMessageCalls.length = 0;
  });

  test("Slack thread reply: slackMeta.threadTs reflects sourceMetadata.threadId", async () => {
    const ctx = createTestContext({
      userMessageChannel: "slack",
      assistantMessageChannel: "slack",
    });

    await persistQueuedMessageBody(ctx, {
      content: "Reply inside a thread",
      requestId: "req-thread",
      metadata: {
        slackInbound: {
          channelId: "C0123CHANNEL",
          channelName: "engineering",
          channelTs: "1700000001.111111",
          threadTs: "1700000000.000001",
          displayName: "Alice",
          actorExternalUserId: "U_ALICE",
        },
      },
    });

    const slackMeta = readPersistedSlackMeta();
    expect(slackMeta).not.toBeNull();
    expect(slackMeta!.source).toBe("slack");
    expect(slackMeta!.eventKind).toBe("message");
    expect(slackMeta!.channelId).toBe("C0123CHANNEL");
    expect(slackMeta!.channelName).toBe("engineering");
    expect(slackMeta!.channelTs).toBe("1700000001.111111");
    expect(slackMeta!.threadTs).toBe("1700000000.000001");
    expect(slackMeta!.displayName).toBe("Alice");
    expect(slackMeta!.actorExternalUserId).toBe("U_ALICE");
  });

  test("Slack top-level message: slackMeta has no threadTs", async () => {
    const ctx = createTestContext({
      userMessageChannel: "slack",
      assistantMessageChannel: "slack",
    });

    await persistQueuedMessageBody(ctx, {
      content: "Top-level channel post",
      requestId: "req-top",
      metadata: {
        slackInbound: {
          channelId: "C0123CHANNEL",
          channelTs: "1700000010.222222",
          displayName: "Bob",
        },
      },
    });

    const slackMeta = readPersistedSlackMeta();
    expect(slackMeta).not.toBeNull();
    expect(slackMeta!.channelTs).toBe("1700000010.222222");
    expect(slackMeta!.threadTs).toBeUndefined();
    expect(slackMeta!.displayName).toBe("Bob");
    expect(slackMeta!.channelName).toBeUndefined();
  });

  test("Slack normalized content is persisted with raw channelTs in slackMeta", async () => {
    const ctx = createTestContext({
      userMessageChannel: "slack",
      assistantMessageChannel: "slack",
    });

    await persistQueuedMessageBody(ctx, {
      content: "@leo can you check this?",
      requestId: "req-normalized-content",
      metadata: {
        slackInbound: {
          channelId: "C0123CHANNEL",
          channelTs: "1700000015.123456",
          displayName: "Alice",
        },
      },
    });

    expect(JSON.parse(addMessageCalls.at(-1)!.content)).toEqual([
      { type: "text", text: "@leo can you check this?" },
    ]);

    const slackMeta = readPersistedSlackMeta();
    expect(slackMeta).not.toBeNull();
    expect(slackMeta!.channelTs).toBe("1700000015.123456");
    expect(slackMeta!.displayName).toBe("Alice");
  });

  test("Slack message without displayName omits the field", async () => {
    const ctx = createTestContext({
      userMessageChannel: "slack",
      assistantMessageChannel: "slack",
    });

    await persistQueuedMessageBody(ctx, {
      content: "Anonymous channel post",
      requestId: "req-anon",
      metadata: {
        slackInbound: {
          channelId: "C0123CHANNEL",
          channelTs: "1700000020.333333",
        },
      },
    });

    const slackMeta = readPersistedSlackMeta();
    expect(slackMeta).not.toBeNull();
    expect(slackMeta!.displayName).toBeUndefined();
  });

  test("non-Slack channel (telegram): no slackMeta key in persisted metadata", async () => {
    const ctx = createTestContext({
      userMessageChannel: "telegram",
      assistantMessageChannel: "telegram",
    });

    await persistQueuedMessageBody(ctx, {
      content: "Telegram message",
      requestId: "req-tg",
    });

    const metadata = lastPersistedMetadata();
    expect("slackMeta" in metadata).toBe(false);
    expect(metadata.userMessageChannel).toBe("telegram");
  });

  test("non-Slack channel (telegram) ignores stale slackInbound carrier", async () => {
    // Defense-in-depth: even if a caller mistakenly forwards `slackInbound`
    // alongside a non-Slack channel, persistence must not emit `slackMeta`.
    // The carrier field itself is stripped from the persisted metadata.
    const ctx = createTestContext({
      userMessageChannel: "telegram",
      assistantMessageChannel: "telegram",
    });

    await persistQueuedMessageBody(ctx, {
      content: "Telegram message with stray slackInbound",
      requestId: "req-tg-stray",
      metadata: {
        slackInbound: {
          channelId: "C0_DOES_NOT_APPLY",
          channelTs: "1700000030.444444",
        },
      },
    });

    const metadata = lastPersistedMetadata();
    expect("slackMeta" in metadata).toBe(false);
    expect("slackInbound" in metadata).toBe(false);
  });

  test("Slack channel without slackInbound: no slackMeta key", async () => {
    // A Slack-originated turn that lacked the inbound metadata (e.g. a
    // signal-injected wake) must not emit a `slackMeta` field — readers
    // already tolerate its absence (the renderer's legacy fallback).
    const ctx = createTestContext({
      userMessageChannel: "slack",
      assistantMessageChannel: "slack",
    });

    await persistQueuedMessageBody(ctx, {
      content: "Slack wake without inbound metadata",
      requestId: "req-no-slack-inbound",
    });

    const metadata = lastPersistedMetadata();
    expect("slackMeta" in metadata).toBe(false);
  });

  test("Slack channel with malformed slackInbound (missing channelTs): no slackMeta", async () => {
    const ctx = createTestContext({
      userMessageChannel: "slack",
      assistantMessageChannel: "slack",
    });

    await persistQueuedMessageBody(ctx, {
      content: "Malformed inbound payload",
      requestId: "req-malformed",
      metadata: {
        slackInbound: {
          // channelTs intentionally missing — simulates a bug upstream.
          channelId: "C0123CHANNEL",
        } as unknown as Record<string, unknown>,
      },
    });

    const metadata = lastPersistedMetadata();
    expect("slackMeta" in metadata).toBe(false);
  });

  test("transient slackInbound carrier never appears in persisted metadata", async () => {
    const ctx = createTestContext({
      userMessageChannel: "slack",
      assistantMessageChannel: "slack",
    });

    await persistQueuedMessageBody(ctx, {
      content: "Verify carrier is stripped",
      requestId: "req-strip",
      metadata: {
        slackInbound: {
          channelId: "C0123CHANNEL",
          channelTs: "1700000040.555555",
        },
      },
    });

    const metadata = lastPersistedMetadata();
    expect("slackInbound" in metadata).toBe(false);
    expect("slackMeta" in metadata).toBe(true);
  });
});
