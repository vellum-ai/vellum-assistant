import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { ReactNode } from "react";
import { z } from "zod";

import type {
  AssistantEventEnvelope,
  ConversationMessage,
} from "@vellumai/assistant-api";

import { client } from "@/generated/daemon/client.gen";
import type { MessagesGetResponse } from "@/generated/daemon/types.gen";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useConversationStore } from "@/stores/conversation-store";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useConversationHistory } from "@/domains/chat/hooks/use-conversation-history";
import { useMessageLifecycle } from "@/domains/chat/hooks/use-message-lifecycle";
import { useTranscriptMessages } from "@/domains/chat/transcript/use-transcript-messages";
import {
  makeServerMessage,
  messageText,
  textBody,
  wireTextBody,
} from "@/domains/chat/utils/message-test-helpers";
import * as messageMapper from "@/domains/chat/utils/map-runtime-message";
import { __resetForTesting, publish } from "@/lib/event-bus";
import { parseAssistantEvent } from "@/lib/streaming/event-parser";
import { unknownEvent } from "@/lib/streaming/parse-helpers";
import { __resetLocalSeqForTesting } from "@/lib/streaming/local-seq";
import { resetReconnectCursor } from "@/lib/streaming/reconnect-cursor";
import {
  pushSseEvent,
  resetSseDebugStateForTests,
} from "@/lib/streaming/stream-debug";
import { getClientId } from "@/lib/telemetry/client-identity";

const ASSISTANT_ID = "assistant-1";
const CONVERSATION_ID = "conversation-1";

// The echo contract compiled into web bundles that predate cameraFrame.
const legacyEchoSchema = z
  .object({
    type: z.literal("user_message_echo"),
    text: z.string(),
    conversationId: z.string().optional(),
    messageId: z.string().optional(),
    requestId: z.string().optional(),
    clientMessageId: z.string().optional(),
  })
  .strict();

function parseLegacyEcho(
  raw: Record<string, unknown>,
): AssistantEventEnvelope {
  const inner = raw.message as Record<string, unknown>;
  const parsed = legacyEchoSchema.safeParse(inner);
  return parseAssistantEvent({
    ...raw,
    message: parsed.success
      ? parsed.data
      : unknownEvent("user_message_echo", inner),
  });
}

function deliver(envelope: AssistantEventEnvelope): void {
  pushSseEvent("client-1", envelope);
  publish("sse.event", envelope);
}

let queryClient: QueryClient;
let serverHistory: MessagesGetResponse;
let messageFetches: number;
const mapCurrentHistory = messageMapper.mapRuntimeToDisplayMessage;

beforeEach(() => {
  __resetForTesting();
  __resetLocalSeqForTesting();
  resetReconnectCursor();
  resetSseDebugStateForTests();
  useChatSessionStore.setState({ snapshot: null, optimisticSends: [] });
  useConversationStore.getState().setActiveConversationId(CONVERSATION_ID);
  useAssistantIdentityStore.getState().setIdentity(null, null);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  serverHistory = { messages: [], seq: 10, processing: false, hasMore: false };
  messageFetches = 0;

  // Legacy history mapping ignores the new optional field while preserving
  // the existing attachment projection and the real history/reseed pipeline.
  spyOn(messageMapper, "mapRuntimeToDisplayMessage").mockImplementation(
    (message) => {
      const legacyMessage = { ...message };
      delete legacyMessage.cameraFrame;
      return mapCurrentHistory(legacyMessage);
    },
  );
  spyOn(client, "get").mockImplementation(async (options) => {
    if (options.url === "/v1/assistants/{assistant_id}/messages") {
      expect(options.path).toEqual({ assistant_id: ASSISTANT_ID });
      expect(options.query).toMatchObject({ conversationId: CONVERSATION_ID });
      messageFetches += 1;
      return { data: serverHistory, response: new Response() } as never;
    }
    expect(options.url).toBe(
      "/v1/assistants/{assistant_id}/pending-interactions",
    );
    return { data: {}, response: new Response() } as never;
  });
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  mock.restore();
  __resetForTesting();
  __resetLocalSeqForTesting();
  resetReconnectCursor();
  resetSseDebugStateForTests();
  useChatSessionStore.setState({ snapshot: null, optimisticSends: [] });
  useConversationStore.getState().setActiveConversationId(null);
});

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

function useLegacyTranscript() {
  const { pagination } = useConversationHistory({
    assistantId: ASSISTANT_ID,
    assistantStateKind: "active",
    activeConversationId: CONVERSATION_ID,
  });
  useMessageLifecycle({
    assistantId: ASSISTANT_ID,
    assistantStateKind: "active",
    activeConversationId: CONVERSATION_ID,
    conversationExistsOnServer: true,
    latestPageOldestTimestamp: pagination.latestPageOldestTimestamp,
    reachability: { state: { phase: "ready" }, probe: () => {}, reset: () => {} },
    setAssetsRefreshKey: () => {},
  });
  return useTranscriptMessages();
}

describe("camera frames on a legacy web bundle", () => {
  test("recovers a dropped strict-schema echo through messages sync and history reseed", async () => {
    const { result } = renderHook(useLegacyTranscript, { wrapper: Wrapper });
    await waitFor(() =>
      expect(useChatSessionStore.getState().snapshot?.seq).toBe(10),
    );
    const initialMessageFetches = messageFetches;
    expect(initialMessageFetches).toBeGreaterThan(0);

    const optimistic = {
      id: "optimistic-1",
      clientMessageId: "client-message-1",
      role: "user" as const,
      isOptimistic: true,
      ...textBody("What is on the table?"),
    };
    act(() => useChatSessionStore.getState().setOptimisticSends([optimistic]));

    const echo = parseLegacyEcho({
      id: "event-11",
      conversationId: CONVERSATION_ID,
      seq: 11,
      emittedAt: "2026-09-14T10:00:00.000Z",
      message: {
        type: "user_message_echo",
        conversationId: CONVERSATION_ID,
        messageId: "frame-1",
        text: "(camera frame)",
        cameraFrame: true,
      },
    });
    expect(echo).toMatchObject({ message: { type: "unknown" } });
    act(() => deliver(echo));
    expect(result.current).toEqual([optimistic]);
    expect(messageFetches).toBe(initialMessageFetches);

    const attachment: ConversationMessage["attachments"][number] = {
      id: "attachment-1",
      filename: "camera-frame.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 100,
      kind: "image",
      data: "ZmFrZS1pbWFnZQ==",
    };
    serverHistory = {
      messages: [
        makeServerMessage({
          id: "frame-1",
          role: "user",
          cameraFrame: true,
          timestamp: "2026-09-14T10:00:00.000Z",
          ...wireTextBody("(camera frame)"),
          attachments: [attachment],
        }),
      ],
      seq: 11,
      processing: false,
      hasMore: false,
    };
    const sync = parseAssistantEvent({
      id: "event-12",
      conversationId: CONVERSATION_ID,
      seq: 12,
      emittedAt: "2026-09-14T10:00:00.001Z",
      message: {
        type: "sync_changed",
        tags: [`conversation:${CONVERSATION_ID}:messages`],
      },
    });
    expect(getClientId()).toBeTruthy();
    expect(sync.message).not.toHaveProperty("originClientId");
    act(() => deliver(sync));

    await waitFor(() => expect(result.current).toHaveLength(2));
    expect(messageFetches).toBeGreaterThan(initialMessageFetches);
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    const recovered = result.current.filter(
      (message) => message.id === "frame-1",
    );
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.attachments).toEqual([
      {
        id: attachment.id,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        previewUrl: `data:image/jpeg;base64,${attachment.data}`,
        thumbnailUrl: null,
      },
    ]);
    expect(messageText(recovered[0])).toBe("(camera frame)");
    expect(recovered[0]?.isCameraFrame).toBeUndefined();
    expect(useChatSessionStore.getState().optimisticSends).toEqual([
      optimistic,
    ]);

    const fetchesBeforeReplay = messageFetches;
    act(() => deliver(sync));
    await waitFor(() =>
      expect(messageFetches).toBeGreaterThan(fetchesBeforeReplay),
    );
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(
      result.current.filter((message) => message.id === "frame-1"),
    ).toHaveLength(1);
    expect(useChatSessionStore.getState().optimisticSends).toEqual([
      optimistic,
    ]);
  });
});
