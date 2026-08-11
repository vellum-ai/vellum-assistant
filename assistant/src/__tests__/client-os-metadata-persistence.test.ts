/**
 * Verifies that `persistQueuedMessageBody` stamps the client-reported OS
 * surface into `metadata.client.os` on persisted user messages.
 *
 * Browser, mobile, and desktop apps all run the same web renderer and report
 * `userMessageInterface: "web"` (the transport surface, which host-proxy
 * capability gating keys off), so `client.os` is the only per-platform
 * attribution available to turn telemetry (`turn-events-store` forwards
 * `$.client` onto `TurnTelemetryEvent.client`). Without the stamp, desktop
 * and mobile usage are indistinguishable from browser usage downstream.
 *
 * Mirrors the mock harness of `dm-persistence.test.ts` and exercises
 * `persistQueuedMessageBody` directly with a captured `addMessage`.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

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
import { isMacOriginatedUserMessage } from "../persistence/conversation-types.js";

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

  test.each(["macos", "windows", "ios", "android", "web"])(
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
    const ctx = createWebTurnContext("linux");
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

  test("transport os fills in when the caller bag omits it", async () => {
    const ctx = createWebTurnContext("ios");
    await persistQueuedMessageBody(ctx, {
      content: "hello",
      requestId: "req-merge",
      metadata: { client: { browser_family: "safari" } },
    });

    expect(lastUserMetadata().client).toEqual({
      os: "ios",
      browser_family: "safari",
    });
  });
});

/**
 * `Conversation.clientOs` is a live field that only a transport-carrying
 * message refreshes, so a transport-less turn stamps whatever an earlier send
 * left there. `clientOsFromRequest` separates the two, and
 * {@link isMacOriginatedUserMessage} (the row-origin read behind the
 * `chat.assistant_reply` presence gate) requires it before letting an attended
 * Mac suppress a push.
 */
describe("client OS per-row evidence marker", () => {
  beforeEach(() => {
    addMessageCalls.length = 0;
  });

  test("marks an OS this row's own transport reported", async () => {
    const ctx = createWebTurnContext("macos");
    await persistQueuedMessageBody(ctx, {
      content: "hello",
      requestId: "req-transport-os",
      requestClientOs: "macos",
    });

    expect(lastUserMetadata().client).toEqual({ os: "macos" });
    expect(lastUserMetadata().clientOsFromRequest).toBe(true);
    expect(isMacOriginatedUserMessage(lastUserMetadata())).toBe(true);
  });

  test("marks an OS this row's own request headers reported", async () => {
    const ctx = createWebTurnContext(undefined);
    await persistQueuedMessageBody(ctx, {
      content: "hello",
      requestId: "req-header-os",
      metadata: { client: { os: "macos", interface_version: "0.8.2" } },
    });

    expect(lastUserMetadata().clientOsFromRequest).toBe(true);
    expect(isMacOriginatedUserMessage(lastUserMetadata())).toBe(true);
  });

  // The bug shape: a button tapped on the phone reaches a conversation whose
  // last desktop send left `clientOs: "macos"` behind. The row still carries
  // the inherited OS for telemetry, but nothing says this turn came from the
  // Mac, so the reply push must survive.
  test("leaves an inherited OS unmarked and not Mac-originated", async () => {
    const ctx = createWebTurnContext("macos");
    await persistQueuedMessageBody(ctx, {
      content: "[User action on card surface: submit]",
      requestId: "req-inherited-os",
    });

    expect(lastUserMetadata().client).toEqual({ os: "macos" });
    expect(lastUserMetadata().clientOsFromRequest).toBeUndefined();
    expect(isMacOriginatedUserMessage(lastUserMetadata())).toBe(false);
  });

  // The marker vouches for the `client.os` that actually landed, not for
  // whatever the row reported: a reported OS the stamp disagrees with is no
  // evidence at all.
  test("leaves the marker off when the reported OS is not the stamped one", async () => {
    const ctx = createWebTurnContext("macos");
    await persistQueuedMessageBody(ctx, {
      content: "hello",
      requestId: "req-mismatched-os",
      requestClientOs: "ios",
    });

    expect(lastUserMetadata().client).toEqual({ os: "macos" });
    expect(lastUserMetadata().clientOsFromRequest).toBeUndefined();
    expect(isMacOriginatedUserMessage(lastUserMetadata())).toBe(false);
  });

  // The marker is derived from what this persist can see, so a bag value
  // riding in from a caller must not survive the metadata spread and assert an
  // origin the row never reported.
  test("drops a caller-supplied marker from the metadata bag", async () => {
    const ctx = createWebTurnContext("macos");
    await persistQueuedMessageBody(ctx, {
      content: "[User action on card surface: submit]",
      requestId: "req-spoofed-marker",
      metadata: { clientOsFromRequest: true },
    });

    expect(lastUserMetadata().clientOsFromRequest).toBeUndefined();
    expect(isMacOriginatedUserMessage(lastUserMetadata())).toBe(false);
  });

  test("leaves the marker off for a reported OS outside the vocabulary", async () => {
    const ctx = createWebTurnContext(undefined);
    await persistQueuedMessageBody(ctx, {
      content: "hello",
      requestId: "req-unknown-os",
      requestClientOs: "windows",
    });

    expect(lastUserMetadata().client).toBeUndefined();
    expect(lastUserMetadata().clientOsFromRequest).toBeUndefined();
  });
});
