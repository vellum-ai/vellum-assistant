/**
 * Regression suite for the seen-signal → per-conversation typed-event
 * publish path.
 *
 * Verifies that `handleRecordSeen` and `handleMarkUnread` publish a
 * single `conversation_seen_changed` typed event (with the canonical
 * post-mutation state) and DO NOT fan out a list-level invalidation.
 *
 * The old behavior — `publishConversationListAndMetadataChanged` —
 * tagged `sync_changed` with `conversationsList`, which forced every
 * subscribed web client to redrain the full paginated sidebar
 * (`limit=50&offset=0..N` for foreground + background variants) on
 * every conversation switch that landed on an unseen conversation. The
 * typed event lets clients patch a single cached row instead.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/env.js", () => ({
  isHttpAuthDisabled: () => true,
  hasUngatedHttpAuthDisabled: () => false,
  getGatewayInternalBaseUrl: () => "http://127.0.0.1:7830",
  getGatewayPort: () => 7830,
  getRuntimeHttpPort: () => 7821,
  getRuntimeHttpHost: () => "127.0.0.1",
  getRuntimeGatewayOriginSecret: () => undefined,
  getIngressPublicBaseUrl: () => undefined,
  setIngressPublicBaseUrl: () => {},
}));

const mockMarkConversationUnread = mock((_conversationId: string) => true);
const mockRecordConversationSeenSignal = mock(
  (_params: Record<string, unknown>) => ({}),
);

// Default to "was unseen" so the publish branch fires. Individual tests
// override this when they need the no-publish path. We type the mock
// explicitly so `.mockImplementationOnce` overrides can return rows
// with non-null `lastSeen*` fields without TypeScript narrowing every
// nullable field to `null` from the default implementation.
type MockAttentionRow = {
  conversationId: string;
  latestAssistantMessageId: string | null;
  latestAssistantMessageAt: number | null;
  lastSeenAssistantMessageId: string | null;
  lastSeenAssistantMessageAt: number | null;
  lastSeenEventAt: number | null;
  lastSeenConfidence: string | null;
  lastSeenSignalType: string | null;
  lastSeenSourceChannel: string | null;
  lastSeenSource: string | null;
  lastSeenEvidenceText: string | null;
  createdAt: number;
  updatedAt: number;
};

const mockGetAttentionState = mock(
  (): Map<string, MockAttentionRow> => {
    const state: MockAttentionRow = {
      conversationId: "conv-1",
      latestAssistantMessageId: "msg-latest",
      latestAssistantMessageAt: 1700000000000,
      lastSeenAssistantMessageId: null,
      lastSeenAssistantMessageAt: null,
      lastSeenEventAt: null,
      lastSeenConfidence: null,
      lastSeenSignalType: null,
      lastSeenSourceChannel: null,
      lastSeenSource: null,
      lastSeenEvidenceText: null,
      createdAt: 0,
      updatedAt: 0,
    };
    return new Map([["conv-1", state]]);
  },
);

mock.module("../memory/conversation-attention-store.js", () => ({
  getAttentionStateByConversationIds: mockGetAttentionState,
  recordConversationSeenSignal: mockRecordConversationSeenSignal,
  markConversationUnread: mockMarkConversationUnread,
}));

mock.module("../memory/conversation-key-store.js", () => ({
  resolveConversationId: (id: string) => id,
}));

const mockPublishSeenChanged = mock(
  (
    _params: {
      conversationId: string;
      hasUnseenLatestAssistantMessage: boolean;
      latestAssistantMessageAt: number | null;
      lastSeenAssistantMessageAt: number | null;
    },
    _originClientId?: string,
  ) => {},
);

const mockPublishListAndMetadata = mock(() => {});

// Explicit stub of every export this route file might reach into. The
// real module pulls in `broadcastMessage` which transitively boots the
// hub + event-stream subsystem; we don't need any of that to assert the
// route's publish-shape behavior.
mock.module("../runtime/sync/resource-sync-events.js", () => ({
  publishConversationSeenChanged: mockPublishSeenChanged,
  publishConversationListAndMetadataChanged: mockPublishListAndMetadata,
  // Stubs for siblings the routes barrel re-imports — keep them as
  // no-ops so the import graph stays satisfied without dragging the
  // hub into the test runtime.
  publishConversationListChanged: () => {},
  publishConversationMessagesChanged: () => {},
  publishConversationTitleChanged: () => {},
  publishConversationInferenceProfileChanged: () => {},
  publishAvatarChanged: () => {},
  publishIdentityChanged: () => {},
  publishConfigChanged: () => {},
  publishSoundsConfigUpdated: () => {},
  publishSchedulesChanged: () => {},
}));

import { RuntimeHttpServer } from "../runtime/http-server.js";

describe("seen-signal publishes per-conversation typed event", () => {
  let server: RuntimeHttpServer;
  let port: number;

  beforeEach(() => {
    mockPublishSeenChanged.mockClear();
    mockPublishListAndMetadata.mockClear();
    mockMarkConversationUnread.mockClear();
    mockRecordConversationSeenSignal.mockClear();
  });

  afterAll(async () => {
    await server?.stop();
  });

  async function startServer(): Promise<void> {
    port = 21000 + Math.floor(Math.random() * 1000);
    server = new RuntimeHttpServer({ port });
    await server.start();
  }

  async function stopServer(): Promise<void> {
    await server?.stop();
  }

  test("POST /v1/conversations/seen publishes ConversationSeenChanged when wasUnseen", async () => {
    await startServer();

    const res = await fetch(
      `http://127.0.0.1:${port}/v1/conversations/seen`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-vellum-client-id": "client-abc",
        },
        body: JSON.stringify({ conversationId: "conv-1" }),
      },
    );

    expect(res.status).toBe(200);

    // Typed event: published exactly once with the canonical post-mutation
    // state and the originating client id threaded through.
    expect(mockPublishSeenChanged).toHaveBeenCalledTimes(1);
    const [params, originClientId] = mockPublishSeenChanged.mock.calls[0]!;
    expect(params).toEqual({
      conversationId: "conv-1",
      hasUnseenLatestAssistantMessage: false,
      latestAssistantMessageAt: 1700000000000,
      lastSeenAssistantMessageAt: null,
    });
    expect(originClientId).toBe("client-abc");

    // The list-level fan-out path must not fire — that was the source of
    // the ~14-request sidebar redrain we're paying down.
    expect(mockPublishListAndMetadata).not.toHaveBeenCalled();

    await stopServer();
  });

  test("POST /v1/conversations/seen suppresses publish when conversation was already seen", async () => {
    mockGetAttentionState.mockImplementationOnce(() => {
      const state = {
        conversationId: "conv-1",
        latestAssistantMessageId: "msg-latest",
        latestAssistantMessageAt: 1700000000000,
        lastSeenAssistantMessageId: "msg-latest",
        lastSeenAssistantMessageAt: 1700000000000,
        lastSeenEventAt: 1700000000000,
        lastSeenConfidence: null,
        lastSeenSignalType: null,
        lastSeenSourceChannel: null,
        lastSeenSource: null,
        lastSeenEvidenceText: null,
        createdAt: 0,
        updatedAt: 0,
      };
      return new Map([["conv-1", state]]);
    });

    await startServer();

    const res = await fetch(
      `http://127.0.0.1:${port}/v1/conversations/seen`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: "conv-1" }),
      },
    );

    expect(res.status).toBe(200);
    // Nothing changed → no event, no list invalidation.
    expect(mockPublishSeenChanged).not.toHaveBeenCalled();
    expect(mockPublishListAndMetadata).not.toHaveBeenCalled();

    await stopServer();
  });

  test("POST /v1/conversations/unread publishes ConversationSeenChanged with hasUnseen=true", async () => {
    await startServer();

    const res = await fetch(
      `http://127.0.0.1:${port}/v1/conversations/unread`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-vellum-client-id": "client-xyz",
        },
        body: JSON.stringify({ conversationId: "conv-1" }),
      },
    );

    expect(res.status).toBe(200);
    expect(mockPublishSeenChanged).toHaveBeenCalledTimes(1);
    const [params, originClientId] = mockPublishSeenChanged.mock.calls[0]!;
    expect(params).toEqual({
      conversationId: "conv-1",
      hasUnseenLatestAssistantMessage: true,
      latestAssistantMessageAt: 1700000000000,
      lastSeenAssistantMessageAt: null,
    });
    expect(originClientId).toBe("client-xyz");
    expect(mockPublishListAndMetadata).not.toHaveBeenCalled();

    await stopServer();
  });

  test("POST /v1/conversations/unread suppresses publish when no state change", async () => {
    mockMarkConversationUnread.mockImplementationOnce(() => false);

    await startServer();

    const res = await fetch(
      `http://127.0.0.1:${port}/v1/conversations/unread`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: "conv-1" }),
      },
    );

    expect(res.status).toBe(200);
    expect(mockPublishSeenChanged).not.toHaveBeenCalled();
    expect(mockPublishListAndMetadata).not.toHaveBeenCalled();

    await stopServer();
  });
});
