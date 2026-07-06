/**
 * Verifies that `persistQueuedMessageBody` stamps the client-reported OS
 * surface into `metadata.client.os` on persisted user messages.
 *
 * The web, iOS, and macOS apps all run the same web renderer and report
 * `userMessageInterface: "web"` (the transport surface, which host-proxy
 * capability gating keys off), so `client.os` is the only per-platform
 * attribution available to turn telemetry (`turn-events-store` forwards
 * `$.client` onto `TurnTelemetryEvent.client`). Without the stamp, desktop
 * and mobile usage are indistinguishable from browser usage downstream.
 *
 * Mirrors the mock harness of `dm-persistence.test.ts` — exercises
 * `persistQueuedMessageBody` directly with a captured `addMessage`.
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

import type {
  TurnChannelContext,
  TurnInterfaceContext,
} from "../channels/types.js";
import type { MessagingConversationContext } from "../daemon/conversation-messaging.js";
import { persistQueuedMessageBody } from "../daemon/conversation-messaging.js";
import type { MessageQueue } from "../daemon/conversation-queue-manager.js";

function createWebTurnContext(
  clientOs: string | undefined,
): MessagingConversationContext {
  const channel: TurnChannelContext = {
    userMessageChannel: "vellum",
    assistantMessageChannel: "vellum",
  };
  const iface: TurnInterfaceContext = {
    userMessageInterface: "web",
    assistantMessageInterface: "web",
  };
  const queueStub = {
    push: () => true,
    drain: () => [],
    size: () => 0,
  } as unknown as MessageQueue;
  let processing = false;
  return {
    conversationId: "conv-client-os-test",
    messages: [],
    isProcessing: () => processing,
    setProcessing: (value: boolean) => {
      processing = value;
    },
    abortController: null,
    queue: queueStub,
    clientOs,
    getTurnChannelContext: () => channel,
    getTurnInterfaceContext: () => iface,
  };
}

function lastUserMetadata(): Record<string, unknown> {
  expect(addMessageCalls.length).toBeGreaterThan(0);
  const metadata = addMessageCalls.at(-1)?.metadata;
  expect(metadata).toBeDefined();
  return metadata!;
}

describe("client OS surface metadata persistence", () => {
  beforeEach(() => {
    addMessageCalls.length = 0;
  });

  test.each(["macos", "ios", "android", "web"])(
    "stamps client.os = %s from the conversation's clientOs",
    async (os) => {
      const ctx = createWebTurnContext(os);
      await persistQueuedMessageBody(ctx, {
        content: "hello",
        requestId: `req-${os}`,
      });

      expect(lastUserMetadata().client).toEqual({ os });
      // The transport surface is unchanged — client.os must not leak into it.
      expect(lastUserMetadata().userMessageInterface).toBe("web");
    },
  );

  test("omits the client bag when no clientOs is reported", async () => {
    const ctx = createWebTurnContext(undefined);
    await persistQueuedMessageBody(ctx, {
      content: "hello",
      requestId: "req-none",
    });

    expect(lastUserMetadata().client).toBeUndefined();
  });

  test("omits the client bag for values outside the ClientOs vocabulary", async () => {
    const ctx = createWebTurnContext("windows");
    await persistQueuedMessageBody(ctx, {
      content: "hello",
      requestId: "req-invalid",
    });

    expect(lastUserMetadata().client).toBeUndefined();
  });

  test("caller-supplied client metadata wins over the stamp", async () => {
    const ctx = createWebTurnContext("macos");
    await persistQueuedMessageBody(ctx, {
      content: "hello",
      requestId: "req-caller",
      metadata: { client: { os: "ios", interface_version: "1.2.3" } },
    });

    expect(lastUserMetadata().client).toEqual({
      os: "ios",
      interface_version: "1.2.3",
    });
  });
});
