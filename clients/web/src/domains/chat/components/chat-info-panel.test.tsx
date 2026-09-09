/**
 * `ChatInfoPanel` at both of its levels: the three category rows, and the
 * grid a See All drills into.
 *
 * The conversation's assets arrive through the real hook, seeded at both of
 * its sources: the query cache holds the apps and documents, the chat-session
 * store holds the transcript rows the attachments come from. Only the row's
 * measured width and the window-size axis are mocked, since happy-dom reports
 * a zero box for everything. What is left is what this component owns: which
 * sections exist, where See All appears, which level renders, what it says
 * while the sources are unresolved, and the sequence each tile runs when it is
 * opened.
 *
 * Camera frames and paged categories are not exercised here: the transcript is
 * the hook's only source today and it can produce neither.
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";

import * as appHtmlCache from "@/utils/app-html-cache";
import {
  CHAT_INFO_T0,
  clearTranscriptMessages,
  installChatInfoDomStubs,
  makeAppSummary,
  makeChatInfoQueryClient,
  makeDocumentSummary,
  makePendingChatInfoQueryClient,
  seedChatInfoConversation,
  seedQueryFailure,
  seedTranscriptMessages,
} from "@/domains/chat/components/chat-info.test-helper";
import type { DisplayMessage } from "@/domains/chat/types/types";
import type * as ElementSizeModule from "@/hooks/use-element-size";
import type * as IsMobileModule from "@/hooks/use-is-mobile";
import type { AppSummary } from "@/types/app-types";
import type { DocumentSummary } from "@/types/document-types";
import type { ChatInfoCategory } from "@/stores/viewer-store";

const ASSISTANT_ID = "asst-1";
const CONVERSATION_ID = "conv-1";
const OTHER_CONVERSATION_ID = "conv-2";
/** The drawer's body width on the desktop mock: 3 app tiles, 4 file tiles. */
const DRAWER_WIDTH = 569;

installChatInfoDomStubs();

mock.module(
  "@/hooks/use-element-size",
  (): Partial<typeof ElementSizeModule> => ({
    useElementSize: () => ({ ref: () => {}, size: { w: DRAWER_WIDTH, h: 0 } }),
  }),
);

mock.module(
  "@/hooks/use-is-mobile",
  (): Partial<typeof IsMobileModule> => ({
    useIsMobile: () => false,
    MOBILE_MEDIA_QUERY: "(max-width: 767px)",
  }),
);

// The app tile's live preview would otherwise call the daemon's open endpoint.
mock.module(
  "@/utils/app-html-cache",
  (): Partial<typeof appHtmlCache> => ({
    ...appHtmlCache,
    getCachedAppHtml: async () => "<!doctype html><title>App</title>",
  }),
);

const calls: string[] = [];

const { ChatInfoPanel } =
  await import("@/domains/chat/components/chat-info-panel");
const { useViewerStore } = await import("@/stores/viewer-store");
const { useUnseenDocumentChangesStore } =
  await import("@/domains/chat/unseen-document-changes-store");
const { documentsGetQueryKey } =
  await import("@/generated/daemon/@tanstack/react-query.gen");
const { makeDisplayAttachment, SAMPLE_PREVIEWS } =
  await import("@/domains/chat/components/chat-attachments/attachment-fixtures");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Newest first once the hook sorts them, so App 1 heads the fitted row.
const APPS: AppSummary[] = Array.from({ length: 12 }, (_, index) =>
  makeAppSummary({
    id: `app-${index + 1}`,
    name: `App ${index + 1}`,
    contentId: `content-${index + 1}`,
    updatedAt: CHAT_INFO_T0 - index,
  }),
);

const TRIP_NOTES = makeDocumentSummary({
  surfaceId: "surface-trip-notes",
  conversationId: CONVERSATION_ID,
  title: "Trip Notes",
});
const PACKING_LIST = makeDocumentSummary({
  surfaceId: "surface-packing-list",
  conversationId: CONVERSATION_ID,
  title: "Packing List",
  updatedAt: CHAT_INFO_T0 - 1,
});
const DOCUMENTS = [TRIP_NOTES, PACKING_LIST];

function imageRow(id: string, index: number, timestamp: number) {
  return {
    id,
    role: "user" as const,
    timestamp,
    attachments: [
      makeDisplayAttachment({
        id: `img-${index}`,
        filename: `photo-${index}.png`,
        previewUrl: SAMPLE_PREVIEWS[index]!,
      }),
    ],
  };
}

const IMAGE_ROWS: DisplayMessage[] = [
  imageRow("msg-1", 0, CHAT_INFO_T0),
  imageRow("msg-2", 1, CHAT_INFO_T0 + 1_000),
];

/** Two legacy rows whose attachments carry the same synthetic id. */
const LEGACY_ROWS: DisplayMessage[] = [
  {
    id: "msg-old",
    role: "user",
    timestamp: CHAT_INFO_T0,
    attachments: [
      makeDisplayAttachment({
        id: "rehydrated:0",
        filename: "legacy-old.png",
      }),
    ],
  },
  {
    id: "msg-new",
    role: "user",
    timestamp: CHAT_INFO_T0 + 1_000,
    attachments: [
      makeDisplayAttachment({
        id: "rehydrated:0",
        filename: "legacy-new.png",
      }),
    ],
  },
];

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const closeChatInfo = mock((): void => {
  calls.push("closeChatInfo");
});
const loadApp = mock(
  async (_assistantId: string, _appId: string): Promise<void> => {
    calls.push("loadApp");
  },
);
const loadDocument = mock(
  async (_assistantId: string, _surfaceId: string): Promise<void> => {
    calls.push("loadDocument");
  },
);

const onClose = mock((): void => undefined);
const onSelectCategory = mock(
  (_category: ChatInfoCategory | null): void => undefined,
);

// The viewer store is a module singleton, so the real actions this suite
// stands in for are put back before the next file loads.
const {
  closeChatInfo: realCloseChatInfo,
  loadApp: realLoadApp,
  loadDocument: realLoadDocument,
} = useViewerStore.getState();

interface Seed {
  apps?: AppSummary[];
  documents?: DocumentSummary[];
  messages?: DisplayMessage[];
  client?: QueryClient;
  /** Runs once the conversation is seeded, for a test that then breaks it. */
  afterSeed?: (client: QueryClient) => void;
}

/** Fills both sources the panel's hook reads, and returns its client. */
function seedPanel({
  apps = APPS,
  documents = DOCUMENTS,
  messages = IMAGE_ROWS,
  client = makeChatInfoQueryClient(),
  afterSeed,
}: Seed = {}): QueryClient {
  seedChatInfoConversation(client, {
    assistantId: ASSISTANT_ID,
    conversationId: CONVERSATION_ID,
    apps,
    documents,
  });
  seedTranscriptMessages(ASSISTANT_ID, CONVERSATION_ID, messages);
  afterSeed?.(client);
  return client;
}

/** Awaited so each app tile's preview html settles inside the test. */
async function renderChatInfo(
  category: ChatInfoCategory | null = null,
  seed: Seed = {},
): Promise<void> {
  const client = seedPanel(seed);
  await act(async () => {
    render(
      <QueryClientProvider client={client}>
        <ChatInfoPanel
          payload={{
            assistantId: ASSISTANT_ID,
            conversationId: CONVERSATION_ID,
            category,
          }}
          onClose={onClose}
          onSelectCategory={onSelectCategory}
        />
      </QueryClientProvider>,
    );
  });
}

beforeEach(() => {
  calls.length = 0;
  useUnseenDocumentChangesStore.setState({ changedDocuments: {} });
  loadApp.mockClear();
  closeChatInfo.mockClear();
  loadDocument.mockClear();
  onClose.mockClear();
  onSelectCategory.mockClear();
  useViewerStore.setState({ closeChatInfo, loadApp, loadDocument });
});

afterEach(() => {
  cleanup();
  clearTranscriptMessages();
  useUnseenDocumentChangesStore.setState({ changedDocuments: {} });
});

// `mock.module` is process-global in this runner, so the module graph is put
// back before the next file loads.
afterAll(() => {
  useViewerStore.setState({
    closeChatInfo: realCloseChatInfo,
    loadApp: realLoadApp,
    loadDocument: realLoadDocument,
  });
  mock.restore();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ChatInfoPanel top level", () => {
  test("heads every non-empty category with its title and exact total", async () => {
    await renderChatInfo();

    expect(screen.getByText("Apps")).toBeDefined();
    expect(screen.getByText("Documents & Images")).toBeDefined();
    expect(screen.getByText("12")).toBeDefined();
    expect(screen.getByText("4")).toBeDefined();
    // Nothing carries the camera-frame tag on the transcript path.
    expect(screen.queryByText("Camera Frames")).toBeNull();
  });

  test("offers See All only where the total exceeds the fitted row", async () => {
    await renderChatInfo();

    expect(screen.getByLabelText("See all apps")).toBeDefined();
    expect(screen.queryByLabelText("See all documents and images")).toBeNull();
  });

  test("drills into a category from its See All control", async () => {
    await renderChatInfo();

    fireEvent.click(screen.getByLabelText("See all apps"));

    expect(onSelectCategory).toHaveBeenCalledWith("apps");
  });

  test("closes from the header control", async () => {
    await renderChatInfo();

    fireEvent.click(screen.getByLabelText("Close chat info"));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("leaves the panel before opening an app, under the payload's assistant", async () => {
    await renderChatInfo();

    fireEvent.click(screen.getByLabelText("Open App 1"));

    expect(calls).toEqual(["closeChatInfo", "loadApp"]);
    expect(loadApp).toHaveBeenCalledWith(ASSISTANT_ID, "app-1");
  });

  test("reads the assets of the conversation its payload names", async () => {
    const client = makeChatInfoQueryClient();
    seedChatInfoConversation(client, {
      assistantId: ASSISTANT_ID,
      conversationId: OTHER_CONVERSATION_ID,
      documents: [
        makeDocumentSummary({
          surfaceId: "surface-other",
          conversationId: OTHER_CONVERSATION_ID,
          title: "Someone Else's Notes",
        }),
      ],
    });
    await renderChatInfo(null, { client });

    expect(screen.getByLabelText("Open Trip Notes")).toBeDefined();
    expect(screen.queryByLabelText("Open Someone Else's Notes")).toBeNull();
  });

  test("clears the conversation's unseen dot while it is open", async () => {
    useUnseenDocumentChangesStore
      .getState()
      .markDocumentChanged(CONVERSATION_ID, TRIP_NOTES.surfaceId);

    await renderChatInfo();

    expect(useUnseenDocumentChangesStore.getState().changedDocuments).toEqual(
      {},
    );
  });

  test("clears a change that lands while it is already open", async () => {
    await renderChatInfo();

    await act(async () => {
      useUnseenDocumentChangesStore
        .getState()
        .markDocumentChanged(CONVERSATION_ID, PACKING_LIST.surfaceId);
    });

    expect(useUnseenDocumentChangesStore.getState().changedDocuments).toEqual(
      {},
    );
  });

  test("leaves the panel before opening a document", async () => {
    await renderChatInfo();

    fireEvent.click(screen.getByLabelText("Open Trip Notes"));

    expect(calls).toEqual(["closeChatInfo", "loadDocument"]);
    expect(loadDocument).toHaveBeenCalledWith(
      ASSISTANT_ID,
      TRIP_NOTES.surfaceId,
    );
  });

  test("opens an image attachment in the shared preview, panel still open", async () => {
    await renderChatInfo();

    fireEvent.click(screen.getByLabelText("Preview photo-0.png"));

    expect(screen.getByRole("dialog")).toBeDefined();
    expect(closeChatInfo).not.toHaveBeenCalled();
  });

  test("opens the gallery at the clicked tile, not at the first row sharing its id", async () => {
    await renderChatInfo(null, { documents: [], messages: LEGACY_ROWS });

    // Newest first, so the older row is the second of the two.
    fireEvent.click(screen.getByLabelText("Preview legacy-old.png"));

    expect(screen.getByText("2 / 2")).toBeDefined();
  });
});

describe("ChatInfoPanel See All level", () => {
  test("lists every tile in the category and offers a way back", async () => {
    await renderChatInfo("apps");

    expect(screen.getAllByLabelText(/^Open App \d+$/)).toHaveLength(12);

    fireEvent.click(screen.getByLabelText("Back to chat info"));

    expect(onSelectCategory).toHaveBeenCalledWith(null);
  });

  test("holds no Load more for a category that has everything", async () => {
    await renderChatInfo("files");

    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  test("falls back to the top level once the category empties", async () => {
    await renderChatInfo("apps", { apps: [] });

    expect(screen.getByText("Chat Info")).toBeDefined();
    expect(screen.queryByLabelText("Back to chat info")).toBeNull();
    // Settled in the store too, so a refilled category cannot drill back in
    // on its own and See All on it is not a silent no-op.
    expect(onSelectCategory).toHaveBeenCalledWith(null);
  });
});

describe("ChatInfoPanel unsettled sources", () => {
  test("says nothing at all while the sources are loading", async () => {
    await renderChatInfo(null, { client: makePendingChatInfoQueryClient() });

    expect(screen.getByText("Chat Info")).toBeDefined();
    expect(screen.queryByText("No assets in this chat yet")).toBeNull();
    expect(screen.queryByText("Assets could not be loaded")).toBeNull();
  });

  test("keeps the payload's category while the sources are loading", async () => {
    await renderChatInfo("apps", { client: makePendingChatInfoQueryClient() });

    expect(screen.getByLabelText("Back to chat info")).toBeDefined();
    expect(onSelectCategory).not.toHaveBeenCalled();
  });

  test("says so once a conversation with nothing has loaded", async () => {
    await renderChatInfo(null, { apps: [], documents: [], messages: [] });

    expect(screen.getByText("No assets in this chat yet")).toBeDefined();
  });

  test("says so when a source could not be loaded", async () => {
    await renderChatInfo(null, {
      afterSeed: (client) =>
        seedQueryFailure(
          client,
          documentsGetQueryKey({
            path: { assistant_id: ASSISTANT_ID },
            query: { conversationId: CONVERSATION_ID },
          }),
        ),
    });

    expect(screen.getByText("Assets could not be loaded")).toBeDefined();
  });
});
