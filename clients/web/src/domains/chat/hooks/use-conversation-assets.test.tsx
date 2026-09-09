/**
 * Tests for `useConversationAssets`.
 *
 * Apps and documents come from two TanStack queries and the attachments from
 * the chat-session store, so the suite seeds all three rather than mocking
 * anything: nothing refetches on mount and the derived lists are exactly what
 * a test asks for.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook } from "@testing-library/react";

import { makeDisplayAttachment } from "@/domains/chat/components/chat-attachments/attachment-fixtures";
import {
  clearTranscriptMessages,
  makeAppSummary,
  makeChatInfoQueryClient,
  makeDocumentSummary,
  makePendingChatInfoQueryClient,
  seedChatInfoConversation,
  seedQueryFailure,
  seedTranscriptMessages,
} from "@/domains/chat/components/chat-info.test-helper";
import {
  toConversationFileAssets,
  useConversationAssets,
} from "@/domains/chat/hooks/use-conversation-assets";
import type { DisplayMessage } from "@/domains/chat/types/types";
import {
  appsGetQueryKey,
  documentsGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type { AppSummary } from "@/types/app-types";
import type { DocumentSummary } from "@/types/document-types";

const ASSISTANT_ID = "asst-1";
const CONVERSATION_ID = "conv-1";

function makeApp(id: string, updatedAt: number): AppSummary {
  return makeAppSummary({
    id,
    name: `App ${id}`,
    createdAt: updatedAt - 1,
    updatedAt,
    contentId: `content-${id}`,
  });
}

function makeDocument(surfaceId: string, updatedAt: number): DocumentSummary {
  return makeDocumentSummary({
    surfaceId,
    conversationId: CONVERSATION_ID,
    title: `Doc ${surfaceId}`,
    createdAt: updatedAt - 1,
    updatedAt,
  });
}

const QUERY_ARGS = {
  path: { assistant_id: ASSISTANT_ID },
  query: { conversationId: CONVERSATION_ID },
};

function renderAssets({
  client = makeChatInfoQueryClient(),
  refreshKey,
}: { client?: QueryClient; refreshKey?: number } = {}) {
  const view = renderHook(
    (props: { refreshKey?: number }) =>
      useConversationAssets({
        assistantId: ASSISTANT_ID,
        conversationId: CONVERSATION_ID,
        refreshKey: props.refreshKey,
      }),
    {
      initialProps: { refreshKey },
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );

  return { ...view, client };
}

function renderSeeded({
  apps = [],
  documents = [],
  refreshKey,
}: {
  apps?: AppSummary[];
  documents?: DocumentSummary[];
  refreshKey?: number;
} = {}) {
  const client = makeChatInfoQueryClient();
  seedChatInfoConversation(client, {
    assistantId: ASSISTANT_ID,
    conversationId: CONVERSATION_ID,
    apps,
    documents,
  });
  return renderAssets({ client, refreshKey });
}

function seedMessages(messages: DisplayMessage[]) {
  seedTranscriptMessages(ASSISTANT_ID, CONVERSATION_ID, messages);
}

beforeEach(() => {
  seedMessages([]);
});

afterEach(() => {
  cleanup();
  clearTranscriptMessages();
});

describe("useConversationAssets", () => {
  test("lists documents before attachments, each newest first", () => {
    seedMessages([
      {
        id: "msg-1",
        role: "user",
        timestamp: 1_000,
        attachments: [makeDisplayAttachment({ id: "att-old" })],
      },
      {
        id: "msg-2",
        role: "user",
        timestamp: 2_000,
        attachments: [makeDisplayAttachment({ id: "att-new" })],
      },
    ]);

    const { result } = renderSeeded({
      documents: [
        makeDocument("doc-old", 1_000),
        makeDocument("doc-new", 2_000),
      ],
    });

    expect(result.current.files.map((file) => file.id)).toEqual([
      "doc-doc-new",
      "doc-doc-old",
      "att-att-new",
      "att-att-old",
    ]);
    expect(result.current.frames).toHaveLength(0);
  });

  test("sorts apps newest first", () => {
    const { result } = renderSeeded({
      apps: [makeApp("a", 1_000), makeApp("b", 3_000), makeApp("c", 2_000)],
    });

    expect(result.current.apps.map((app) => app.id)).toEqual(["b", "c", "a"]);
  });

  test("counts every category and sums them", () => {
    seedMessages([
      {
        id: "msg-1",
        role: "user",
        attachments: [
          makeDisplayAttachment({ id: "att-1" }),
          makeDisplayAttachment({ id: "att-2" }),
        ],
      },
    ]);

    const { result } = renderSeeded({
      apps: [makeApp("a", 1_000)],
      documents: [makeDocument("doc-1", 1_000)],
    });

    expect(result.current.counts).toEqual({ apps: 1, files: 3, frames: 0 });
    expect(result.current.count).toBe(4);
  });

  test("counts nothing for a conversation with no assets", () => {
    const { result } = renderSeeded();

    expect(result.current.count).toBe(0);
    expect(result.current.status).toBe("ready");
  });

  test("invalidates both queries when the refresh key changes", () => {
    const { rerender, client } = renderSeeded({ refreshKey: 1 });
    const invalidated: unknown[] = [];
    client.invalidateQueries = (filters) => {
      invalidated.push(filters);
      return Promise.resolve();
    };

    rerender({ refreshKey: 2 });

    expect(invalidated).toEqual([
      { queryKey: appsGetQueryKey(QUERY_ARGS) },
      { queryKey: documentsGetQueryKey(QUERY_ARGS) },
    ]);
  });
});

describe("useConversationAssets status", () => {
  // An empty category means "nothing here" only once this reads "ready", so
  // the panel can tell an empty conversation from one still loading.
  test("is pending until both sources resolve", () => {
    const { result } = renderAssets({
      client: makePendingChatInfoQueryClient(),
    });

    expect(result.current.status).toBe("pending");
    expect(result.current.count).toBe(0);
  });

  test("is pending while only one source has resolved", () => {
    const client = makePendingChatInfoQueryClient();
    client.setQueryData(appsGetQueryKey(QUERY_ARGS), { apps: [] });

    const { result } = renderAssets({ client });

    expect(result.current.status).toBe("pending");
  });

  test("is error when either source failed", () => {
    const client = makePendingChatInfoQueryClient();
    client.setQueryData(appsGetQueryKey(QUERY_ARGS), { apps: [] });
    seedQueryFailure(client, documentsGetQueryKey(QUERY_ARGS));

    const { result } = renderAssets({ client });

    expect(result.current.status).toBe("error");
  });
});

describe("toConversationFileAssets", () => {
  test("keeps legacy rehydrated attachments from different rows apart by id", () => {
    const { files } = toConversationFileAssets(
      [],
      [
        {
          attachment: makeDisplayAttachment({
            id: "rehydrated:0",
            filename: "old.pdf",
          }),
          key: "msg-old:0",
          capturedAt: null,
          sightFrame: false,
        },
        {
          attachment: makeDisplayAttachment({
            id: "rehydrated:0",
            filename: "new.pdf",
          }),
          key: "msg-new:0",
          capturedAt: null,
          sightFrame: false,
        },
      ],
    );
    expect(new Set(files.map((file) => file.id)).size).toBe(2);
  });

  test("routes a camera frame to frames and nowhere else", () => {
    const frame = makeDisplayAttachment({ id: "shot", filename: "shot.jpg" });
    const upload = makeDisplayAttachment({
      id: "shot",
      filename: "upload.png",
    });

    const { files, frames } = toConversationFileAssets(
      [makeDocument("shot", 1_000)],
      [
        {
          key: "shot",
          attachment: frame,
          capturedAt: 5_000,
          sightFrame: true,
        },
        {
          key: "shot",
          attachment: upload,
          capturedAt: null,
          sightFrame: false,
        },
      ],
    );

    expect(frames).toEqual([
      {
        kind: "frame",
        id: "frame-shot",
        title: "shot.jpg",
        attachment: frame,
        capturedAt: 5_000,
      },
    ]);
    // One shared underlying id across all three kinds, three distinct keys.
    expect(files.map((file) => file.id)).toEqual(["doc-shot", "att-shot"]);
    expect(files.some((file) => file.kind === "frame")).toBe(false);
  });
});
