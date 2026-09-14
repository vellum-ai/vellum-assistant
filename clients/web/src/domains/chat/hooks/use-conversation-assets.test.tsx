/**
 * Tests for `useConversationAssets`.
 *
 * Apps and documents come from two TanStack queries, and the attachments from
 * the daemon's two list queries where the connected version serves them and
 * from the chat-session store otherwise, so the suite seeds each source rather
 * than mocking anything: nothing refetches on mount, no request leaves the
 * process, and the derived lists are exactly what a test asks for. Every one of
 * them is a source the reported status answers for.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  onlineManager,
  type QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { cleanup, renderHook } from "@testing-library/react";

import { makeDisplayAttachment } from "@/domains/chat/components/chat-attachments/attachment-fixtures";
import {
  clearTranscriptMessages,
  holdOrgHeaderUnresolved,
  makeAppSummary,
  makeAttachmentSummary,
  makeChatInfoQueryClient,
  makeDocumentSummary,
  makePendingChatInfoQueryClient,
  reportAssistantVersion,
  seedAttachmentList,
  seedChatInfoConversation,
  seedQueryFailure,
  seedTranscriptMessages,
} from "@/domains/chat/components/chat-info.test-helper";
import {
  toConversationFileAssets,
  useConversationAssets,
} from "@/domains/chat/hooks/use-conversation-assets";
import type { DisplayMessage } from "@/domains/chat/types/types";
import { conversationAttachmentListArgs } from "@/domains/chat/hooks/use-conversation-attachments";
import {
  appsGetQueryKey,
  attachmentsGetInfiniteQueryKey,
  documentsGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type { AppSummary } from "@/types/app-types";
import type { DocumentSummary } from "@/types/document-types";
import { ApiError } from "@/utils/api-errors";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";

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

function seedClient({
  apps = [],
  documents = [],
  client = makeChatInfoQueryClient(),
}: {
  apps?: AppSummary[];
  documents?: DocumentSummary[];
  client?: QueryClient;
} = {}): QueryClient {
  seedChatInfoConversation(client, {
    assistantId: ASSISTANT_ID,
    conversationId: CONVERSATION_ID,
    apps,
    documents,
  });
  return client;
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
  return renderAssets({ client: seedClient({ apps, documents }), refreshKey });
}

function seedMessages(messages: DisplayMessage[]) {
  seedTranscriptMessages(ASSISTANT_ID, CONVERSATION_ID, messages);
}

/** The conversation owns the transcript, with no snapshot and history `loading`. */
function ownWithoutSnapshot(loading: boolean): void {
  useChatSessionStore.setState({
    snapshot: null,
    optimisticSends: [],
    previousAssistantId: ASSISTANT_ID,
    previousConversationId: CONVERSATION_ID,
    isLoadingHistory: loading,
  });
}

let releaseOrgHeader = () => {};
let restoreAssistantVersion = () => {};

/** Reports a version the attachment-listing gate opens on, restored after. */
function openAttachmentListGate(): void {
  restoreAssistantVersion = reportAssistantVersion();
}

/** The two list keys the attachments hook reads, files first. */
const LIST_KEYS = (["exclude", "only"] as const).map((sightFrames) =>
  attachmentsGetInfiniteQueryKey(
    conversationAttachmentListArgs(ASSISTANT_ID, CONVERSATION_ID, sightFrames),
  ),
);

beforeEach(() => {
  // Both daemon queries gate on the org header, so holding it unresolved is
  // what leaves a source a test does not seed unresolved, with nothing
  // requested. Released after the render is torn down, so no query can enable
  // itself on the way out.
  releaseOrgHeader = holdOrgHeaderUnresolved();
  seedMessages([]);
});

afterEach(() => {
  cleanup();
  releaseOrgHeader();
  restoreAssistantVersion();
  restoreAssistantVersion = () => {};
  clearTranscriptMessages();
  // The store is a module singleton, so its loading flag goes back to the
  // value a fresh chat session starts on, and so does TanStack's online
  // manager, which an offline test would otherwise leave offline.
  useChatSessionStore.setState({ isLoadingHistory: true });
  onlineManager.setOnline(true);
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
    // Stubbed before the first render: the mount pass invalidates too, and the
    // real one would send both queries to a daemon this suite does not run.
    const client = seedClient();
    const invalidated: unknown[] = [];
    client.invalidateQueries = (filters) => {
      invalidated.push(filters);
      return Promise.resolve();
    };
    const { rerender } = renderAssets({ client, refreshKey: 1 });
    invalidated.length = 0;

    rerender({ refreshKey: 2 });

    expect(invalidated).toEqual([
      { queryKey: appsGetQueryKey(QUERY_ARGS) },
      { queryKey: documentsGetQueryKey(QUERY_ARGS) },
    ]);
  });
});

describe("useConversationAssets status", () => {
  /** Both daemon queries answered, on a client that asks the daemon nothing. */
  function seededQueries(): QueryClient {
    return seedClient({ client: makePendingChatInfoQueryClient() });
  }

  /** Re-stamps a seeded failure with the error shape the daemon client throws. */
  function failWith(
    client: QueryClient,
    queryKey: readonly unknown[],
    status: number,
  ): void {
    client
      .getQueryCache()
      .find({ queryKey })!
      .setState({ error: new ApiError(status, `HTTP ${status}`) });
  }

  /** Re-stamps a seeded failure with the error a browser throws for itself. */
  function failWithNetworkError(client: QueryClient): void {
    client.removeQueries({ queryKey: documentsGetQueryKey(QUERY_ARGS) });
    seedQueryFailure(client, documentsGetQueryKey(QUERY_ARGS));
    client
      .getQueryCache()
      .find({ queryKey: documentsGetQueryKey(QUERY_ARGS) })!
      .setState({ error: new TypeError("Failed to fetch") });
  }

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

  test("is error when either source failed with nothing cached", () => {
    const client = makePendingChatInfoQueryClient();
    client.setQueryData(appsGetQueryKey(QUERY_ARGS), { apps: [] });
    seedQueryFailure(client, documentsGetQueryKey(QUERY_ARGS));

    const { result } = renderAssets({ client });

    expect(result.current.status).toBe("error");
  });

  // A refetch that fails leaves the last documents in the cache, and those are
  // still the conversation's files: reporting an error would discard them.
  test("stays ready when a failed refetch left its data behind", () => {
    const { result, client } = renderSeeded({
      documents: [makeDocument("doc-1", 1_000)],
    });
    seedQueryFailure(client, documentsGetQueryKey(QUERY_ARGS));

    expect(result.current.status).toBe("ready");
    expect(result.current.files.map((file) => file.id)).toEqual(["doc-doc-1"]);
  });

  test("is ready once every source holds data", () => {
    const { result } = renderAssets({ client: seededQueries() });

    expect(result.current.status).toBe("ready");
  });

  // The transcript is where a conversation's attachments come from, so a chat
  // with nothing but attachments would otherwise read ready and empty until
  // the snapshot lands, and the header trigger would flash and disappear.
  test("is pending until the transcript is loaded", () => {
    clearTranscriptMessages();

    const { result } = renderAssets({ client: seededQueries() });

    expect(result.current.status).toBe("pending");
  });

  test("is pending while another conversation owns the transcript", () => {
    seedTranscriptMessages(ASSISTANT_ID, "conv-2", []);

    const { result } = renderAssets({ client: seededQueries() });

    expect(result.current.status).toBe("pending");
  });

  // The transcript is loaded rather than fetched, and a history load that
  // failed is never coming back: holding the panel pending on a snapshot that
  // will never arrive would hide the trigger for the rest of the session.
  test("is ready once a failed history load has settled the transcript", () => {
    const client = seededQueries();
    ownWithoutSnapshot(false);

    const { result } = renderAssets({ client });

    expect(result.current.status).toBe("ready");
  });

  test("is pending while the history load is still in flight", () => {
    const client = seededQueries();
    ownWithoutSnapshot(true);

    const { result } = renderAssets({ client });

    expect(result.current.status).toBe("pending");
  });

  // A restarting daemon's 503 is retried before it settles, so one that has
  // settled here has spent that budget: nothing else is coming, and a source
  // that reads pending forever would hide the trigger for the whole session.
  test("is error when a transient status settled with nothing cached", () => {
    const client = seededQueries();
    client.removeQueries({ queryKey: documentsGetQueryKey(QUERY_ARGS) });
    seedQueryFailure(client, documentsGetQueryKey(QUERY_ARGS));
    failWith(client, documentsGetQueryKey(QUERY_ARGS), 503);

    const { result } = renderAssets({ client });

    expect(result.current.status).toBe("error");
  });

  // The gate, not the client: an ungated query with nothing cached fetches on
  // mount, and a request sent before the org header can be produced comes back
  // a 400 the panel would then have to report as this conversation's failure.
  test("holds both queries idle while the org header is unresolved", () => {
    const client = makeChatInfoQueryClient();

    const { result } = renderAssets({ client });

    for (const queryKey of [
      appsGetQueryKey(QUERY_ARGS),
      documentsGetQueryKey(QUERY_ARGS),
    ]) {
      const query = client.getQueryCache().find({ queryKey })!;
      expect(query.state.fetchStatus).toBe("idle");
      expect(query.state.status).toBe("pending");
    }
    expect(result.current.status).toBe("pending");
  });

  test("is error when a source settled on a 500 with nothing cached", () => {
    const client = seededQueries();
    client.removeQueries({ queryKey: documentsGetQueryKey(QUERY_ARGS) });
    seedQueryFailure(client, documentsGetQueryKey(QUERY_ARGS));
    failWith(client, documentsGetQueryKey(QUERY_ARGS), 500);

    const { result } = renderAssets({ client });

    expect(result.current.status).toBe("error");
  });

  // A failure named while another source is still coming is one the panel
  // would take back the moment that source lands, so every source settles
  // first and only then does a failed one speak.
  test("is pending while a source failed and the transcript has not landed", () => {
    clearTranscriptMessages();
    const client = seededQueries();
    client.removeQueries({ queryKey: documentsGetQueryKey(QUERY_ARGS) });
    seedQueryFailure(client, documentsGetQueryKey(QUERY_ARGS));

    const { result } = renderAssets({ client });

    expect(result.current.status).toBe("pending");
  });

  test("is pending while one source failed and the other is unresolved", () => {
    const client = makePendingChatInfoQueryClient();
    seedQueryFailure(client, documentsGetQueryKey(QUERY_ARGS));

    const { result } = renderAssets({ client });

    expect(result.current.status).toBe("pending");
  });

  // TanStack refetches every query on reconnect, so a browser that lost the
  // network gets its answer back on its own: that source is still on its way.
  test("is pending when a source failed while the browser is offline", () => {
    const client = seededQueries();
    failWithNetworkError(client);
    onlineManager.setOnline(false);

    const { result } = renderAssets({ client });

    expect(result.current.status).toBe("pending");
  });

  // Nothing reconnects an online browser, and the retries are already spent, so
  // a source left pending here would hide the trigger for the whole session.
  test("is error when a source failed a refused connection while online", () => {
    const client = seededQueries();
    failWithNetworkError(client);

    const { result } = renderAssets({ client });

    expect(result.current.status).toBe("error");
  });
});

describe("useConversationAssets on the daemon attachment lists", () => {
  const PHOTO = makeAttachmentSummary({ id: "photo-1" });
  const FRAME = makeAttachmentSummary({
    id: "frame-1",
    filename: "frame-1.jpg",
    mimeType: "image/jpeg",
    createdAt: 4_000,
    sightFrame: true,
  });

  /** Apps and documents answered, so only the attachments are left to settle. */
  function seedWithDocuments(documents: DocumentSummary[] = []): QueryClient {
    return seedClient({
      documents,
      client: makePendingChatInfoQueryClient(),
    });
  }

  test("counts the daemon's totals alongside the documents", () => {
    openAttachmentListGate();
    const client = seedWithDocuments([makeDocument("doc-1", 1_000)]);
    seedAttachmentList(client, {
      assistantId: ASSISTANT_ID,
      conversationId: CONVERSATION_ID,
      sightFrames: "exclude",
      attachments: [PHOTO],
      total: 4,
    });
    seedAttachmentList(client, {
      assistantId: ASSISTANT_ID,
      conversationId: CONVERSATION_ID,
      sightFrames: "only",
      attachments: [FRAME],
      total: 12,
    });

    const { result } = renderAssets({ client });

    expect(result.current.counts).toEqual({ apps: 0, files: 5, frames: 12 });
    expect(result.current.frames.map((frame) => frame.id)).toEqual([
      "frame-frame-1",
    ]);
    expect(result.current.status).toBe("ready");
  });

  // An empty category means "nothing here" only once every source has said so,
  // and a list still on its way is a source that has not.
  test("is pending while a list is unresolved", () => {
    openAttachmentListGate();
    const client = seedWithDocuments();
    seedAttachmentList(client, {
      assistantId: ASSISTANT_ID,
      conversationId: CONVERSATION_ID,
      sightFrames: "exclude",
      attachments: [PHOTO],
    });

    const { result } = renderAssets({ client });

    expect(result.current.status).toBe("pending");
  });

  test("is error when a list settled with nothing cached", () => {
    openAttachmentListGate();
    const client = seedWithDocuments();
    seedAttachmentList(client, {
      assistantId: ASSISTANT_ID,
      conversationId: CONVERSATION_ID,
      sightFrames: "exclude",
      attachments: [PHOTO],
    });
    seedQueryFailure(client, LIST_KEYS[1]!);

    const { result } = renderAssets({ client });

    expect(result.current.status).toBe("error");
  });

  test("is ready once both lists have answered", () => {
    openAttachmentListGate();
    const client = seedWithDocuments();
    for (const sightFrames of ["exclude", "only"] as const) {
      seedAttachmentList(client, {
        assistantId: ASSISTANT_ID,
        conversationId: CONVERSATION_ID,
        sightFrames,
        attachments: [],
      });
    }

    const { result } = renderAssets({ client });

    expect(result.current.status).toBe("ready");
    expect(result.current.count).toBe(0);
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
