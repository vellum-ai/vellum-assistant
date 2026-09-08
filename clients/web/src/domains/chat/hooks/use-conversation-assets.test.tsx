/**
 * Tests for `useConversationAssets`.
 *
 * Apps and documents come from two TanStack queries, so the suite seeds the
 * cache with `staleTime: Infinity` instead of mocking the SDK: nothing
 * refetches on mount and the derived lists are exactly what a test asks for.
 * The transcript hook behind the attachments is mocked the same way its own
 * suite mocks it.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook } from "@testing-library/react";

import type * as TranscriptMessages from "@/domains/chat/transcript/use-transcript-messages";
import type { DisplayMessage } from "@/domains/chat/types/types";
import type { AppSummary } from "@/types/app-types";
import type { DocumentSummary } from "@/types/document-types";

const messagesRef: { value: DisplayMessage[] } = { value: [] };

mock.module(
  "@/domains/chat/transcript/use-transcript-messages",
  (): Partial<typeof TranscriptMessages> => ({
    useTranscriptMessages: () => messagesRef.value,
  }),
);

const { useConversationAssets, toConversationFileAssets } =
  await import("@/domains/chat/hooks/use-conversation-assets");
const { makeDisplayAttachment } =
  await import("@/domains/chat/components/chat-attachments/attachment-fixtures");
const {
  appsGetOptions,
  appsGetQueryKey,
  documentsGetOptions,
  documentsGetQueryKey,
} = await import("@/generated/daemon/@tanstack/react-query.gen");

const ASSISTANT_ID = "asst-1";
const CONVERSATION_ID = "conv-1";

function makeApp(id: string, updatedAt: number): AppSummary {
  return {
    id,
    name: `App ${id}`,
    createdAt: updatedAt - 1,
    updatedAt,
    version: "1.0.0",
    contentId: `content-${id}`,
    origin: "workspace",
  };
}

function makeDocument(surfaceId: string, updatedAt: number): DocumentSummary {
  return {
    surfaceId,
    conversationId: CONVERSATION_ID,
    title: `Doc ${surfaceId}`,
    wordCount: 12,
    createdAt: updatedAt - 1,
    updatedAt,
  };
}

/**
 * `staleTime: Infinity` keeps the seeded entries fresh, so the queries resolve
 * from cache and never reach the generated SDK.
 */
function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: Infinity },
    },
  });
}

function seedConversation(
  client: QueryClient,
  apps: AppSummary[],
  documents: DocumentSummary[],
) {
  const queryArgs = {
    path: { assistant_id: ASSISTANT_ID },
    query: { conversationId: CONVERSATION_ID },
  };
  client.setQueryData(appsGetOptions(queryArgs).queryKey, { apps });
  client.setQueryData(documentsGetOptions(queryArgs).queryKey, { documents });
}

function renderAssets({
  apps = [],
  documents = [],
  refreshKey,
}: {
  apps?: AppSummary[];
  documents?: DocumentSummary[];
  refreshKey?: number;
} = {}) {
  const client = makeQueryClient();
  seedConversation(client, apps, documents);

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

afterEach(() => {
  cleanup();
  messagesRef.value = [];
});

describe("useConversationAssets", () => {
  test("lists documents before attachments, each newest first", () => {
    messagesRef.value = [
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
    ];

    const { result } = renderAssets({
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
    const { result } = renderAssets({
      apps: [makeApp("a", 1_000), makeApp("b", 3_000), makeApp("c", 2_000)],
    });

    expect(result.current.apps.map((app) => app.id)).toEqual(["b", "c", "a"]);
  });

  test("counts every category and sums them", () => {
    messagesRef.value = [
      {
        id: "msg-1",
        role: "user",
        attachments: [
          makeDisplayAttachment({ id: "att-1" }),
          makeDisplayAttachment({ id: "att-2" }),
        ],
      },
    ];

    const { result } = renderAssets({
      apps: [makeApp("a", 1_000)],
      documents: [makeDocument("doc-1", 1_000)],
    });

    expect(result.current.counts).toEqual({ apps: 1, files: 3, frames: 0 });
    expect(result.current.count).toBe(4);
  });

  test("invalidates both queries when the refresh key changes", () => {
    const { rerender, client } = renderAssets({ refreshKey: 1 });
    const invalidated: unknown[] = [];
    client.invalidateQueries = (filters) => {
      invalidated.push(filters);
      return Promise.resolve();
    };

    rerender({ refreshKey: 2 });

    const queryArgs = {
      path: { assistant_id: ASSISTANT_ID },
      query: { conversationId: CONVERSATION_ID },
    };
    expect(invalidated).toEqual([
      { queryKey: appsGetQueryKey(queryArgs) },
      { queryKey: documentsGetQueryKey(queryArgs) },
    ]);
  });
});

describe("toConversationFileAssets", () => {
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
          attachment: frame,
          messageId: "msg-1",
          capturedAt: 5_000,
          sightFrame: true,
        },
        {
          attachment: upload,
          messageId: "msg-2",
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
