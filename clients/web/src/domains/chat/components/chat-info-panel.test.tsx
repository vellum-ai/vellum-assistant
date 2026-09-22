/**
 * `ChatInfoPanel` at both of its levels: the three category rows, and the
 * grid a See All drills into.
 *
 * The conversation's assets arrive through the real hook, seeded at both of
 * its sources: the query cache holds the apps and documents, the chat-session
 * store holds the transcript rows the attachments come from. Only the row's
 * measured width is mocked, since happy-dom reports a zero box for everything,
 * and the window-size axis comes from a `matchMedia` stub. What is left is
 * what this component owns: which sections exist, where See All appears, which
 * level renders, what it says while the sources are unresolved, and the
 * sequence each tile runs when it is opened.
 *
 * Camera frames and paged categories are not exercised here: these tests seed
 * the transcript rather than the daemon's attachment listing, and the
 * transcript can produce neither. The listing itself is covered by
 * `use-conversation-attachments.test.tsx`.
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
import { MemoryRouter } from "react-router";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import {
  attachmentRows,
  CHAT_INFO_BODY_WIDTH_PX,
  CHAT_INFO_T0,
  chatInfoAppHtmlCacheMock,
  clearTranscriptMessages,
  holdOrgHeaderUnresolved,
  installChatInfoDomStubs,
  makeAppSummary,
  makeChatInfoQueryClient,
  makeDocumentSummary,
  makeElementSizeMock,
  makePendingChatInfoQueryClient,
  makeTranscriptRow,
  reportAssistantVersion,
  seedChatInfoConversation,
  seedQueryFailure,
  seedTranscriptMessages,
} from "@/domains/chat/components/chat-info.test-helper";
import { conversationAttachmentListArgs } from "@/domains/chat/hooks/use-conversation-attachments";
import type { DisplayMessage } from "@/domains/chat/types/types";
import {
  currentLocation,
  LocationProbe,
} from "@/hooks/router-probe.test-helper";
import { viewportAxesStub } from "@/hooks/viewport-axes.test-helper";
import type { AppSummary } from "@/types/app-types";
import type { DocumentSummary } from "@/types/document-types";
import type { ChatInfoCategory } from "@/stores/viewer-store";
import { routes } from "@/utils/routes";

const ASSISTANT_ID = "asst-1";
const CONVERSATION_ID = "conv-1";
const OTHER_CONVERSATION_ID = "conv-2";
const APP_ID = "app-1";
const CONVERSATION_PATH = routes.conversation(CONVERSATION_ID);
const APP_PATH = routes.conversation(CONVERSATION_ID, APP_ID);

const restoreDomStubs = installChatInfoDomStubs();

mock.module("@/hooks/use-element-size", () =>
  makeElementSizeMock(() => CHAT_INFO_BODY_WIDTH_PX),
);

// The app tile's live preview would otherwise call the daemon's open endpoint.
mock.module("@/utils/app-html-cache", chatInfoAppHtmlCacheMock);

const calls: string[] = [];
/** Where the route stood at each `closeChatInfo`, for the open sequence. */
const routeAtClose: string[] = [];

const { ChatInfoPanel } = await import(
  "@/domains/chat/components/chat-info-panel"
);
const { useViewerStore } = await import("@/stores/viewer-store");
const { useResolvedAssistantsStore } = await import(
  "@/stores/resolved-assistants-store"
);
const { showPath } = await import("@/stores/open-app.test-helper");
const { useUnseenDocumentChangesStore } = await import(
  "@/domains/chat/unseen-document-changes-store"
);
const {
  appsGetQueryKey,
  attachmentsGetInfiniteQueryKey,
  documentsGetQueryKey,
} = await import("@/generated/daemon/@tanstack/react-query.gen");
const { makeDisplayAttachment, SAMPLE_PREVIEWS } = await import(
  "@/domains/chat/components/chat-attachments/attachment-fixtures"
);

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

/** One image per row, oldest first, each with a preview of its own. */
function imageRows(count: number): DisplayMessage[] {
  return attachmentRows(
    Array.from({ length: count }, (_, index) =>
      makeDisplayAttachment({
        id: `img-${index}`,
        filename: `photo-${index}.png`,
        previewUrl: SAMPLE_PREVIEWS[index]!,
      }),
    ),
  );
}

const IMAGE_ROWS: DisplayMessage[] = imageRows(2);

/** Two legacy rows whose attachments carry the same synthetic id. */
const LEGACY_ROWS: DisplayMessage[] = [
  makeTranscriptRow({
    id: "msg-old",
    timestamp: CHAT_INFO_T0,
    attachments: [
      makeDisplayAttachment({
        id: "rehydrated:0",
        filename: "legacy-old.png",
      }),
    ],
  }),
  makeTranscriptRow({
    id: "msg-new",
    timestamp: CHAT_INFO_T0 + 1_000,
    attachments: [
      makeDisplayAttachment({
        id: "rehydrated:0",
        filename: "legacy-new.png",
      }),
    ],
  }),
];

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const closeChatInfo = mock((): void => {
  calls.push("closeChatInfo");
  routeAtClose.push(currentLocation().pathname);
});
const loadApp = mock(
  async (_assistantId: string, _appId: string): Promise<boolean> => {
    calls.push("loadApp");
    return true;
  },
);
const loadDocument = mock(
  async (_assistantId: string, _surfaceId: string): Promise<void> => {
    calls.push("loadDocument");
  },
);

const viewport = viewportAxesStub();

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
const realActiveAssistantId =
  useResolvedAssistantsStore.getState().activeAssistantId;

interface Seed {
  apps?: AppSummary[];
  documents?: DocumentSummary[];
  messages?: DisplayMessage[];
  client?: QueryClient;
  /** Runs once the conversation is seeded, for a test that then breaks it. */
  afterSeed?: (client: QueryClient) => void;
  /**
   * Where both routes the app opener straddles start: the probe router's and
   * the window's, which the imperative route helpers read.
   */
  path?: string;
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
  const path = seed.path ?? CONVERSATION_PATH;
  showPath(path);
  await act(async () => {
    render(
      <MemoryRouter initialEntries={[path]}>
        <LocationProbe />
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
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
}

let releaseOrgHeader = () => {};

beforeEach(() => {
  // Both daemon queries gate on the org header, so holding it unresolved is
  // what leaves a source a test takes back out unresolved, with nothing
  // requested.
  releaseOrgHeader = holdOrgHeaderUnresolved();
  calls.length = 0;
  routeAtClose.length = 0;
  viewport.set({ narrow: false, coarsePointer: false });
  useUnseenDocumentChangesStore.setState({ changedDocuments: {} });
  loadApp.mockClear();
  closeChatInfo.mockClear();
  loadDocument.mockClear();
  onClose.mockClear();
  onSelectCategory.mockClear();
  useViewerStore.setState({ closeChatInfo, loadApp, loadDocument });
  // The shared opener the app tiles go through reads the active assistant.
  useResolvedAssistantsStore.setState({ activeAssistantId: ASSISTANT_ID });
});

afterEach(() => {
  cleanup();
  releaseOrgHeader();
  viewport.restore();
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
  useResolvedAssistantsStore.setState({
    activeAssistantId: realActiveAssistantId,
  });
  restoreDomStubs();
  mock.restore();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ChatInfoPanel top level", () => {
  test("shows exact app totals and omits transcript-only file totals", async () => {
    await renderChatInfo();

    expect(screen.getByText("Apps")).toBeDefined();
    expect(screen.getByText("Documents & Images")).toBeDefined();
    expect(screen.getByText("12")).toBeDefined();
    expect(screen.queryByText("4")).toBeNull();
    expect(
      screen.getByText("Attachments are from the loaded chat history only."),
    ).toBeDefined();
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

  // The files row is the panel's own composition of `ChatInfoFileRow`: two
  // documents and three attachments are one more than the four tiles the
  // drawer's width fits, so the row offers the drill-in.
  test("drills into the files category once its row overflows", async () => {
    await renderChatInfo(null, { messages: imageRows(3) });

    fireEvent.click(screen.getByLabelText("See all documents and images"));

    expect(onSelectCategory).toHaveBeenCalledWith("files");
  });

  test("closes from the header control", async () => {
    await renderChatInfo();

    fireEvent.click(screen.getByLabelText("Close chat info"));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("leaves the panel, then opens the app as a navigation", async () => {
    await renderChatInfo();

    fireEvent.click(screen.getByLabelText("Open App 1"));

    // The panel is gone before the app route lands, so the app opens where
    // the panel was rather than behind it, and the app hangs off the
    // conversation the payload names.
    expect(calls).toEqual(["closeChatInfo"]);
    expect(routeAtClose).toEqual([CONVERSATION_PATH]);
    expect(loadApp).not.toHaveBeenCalled();
    expect(currentLocation().pathname).toBe(APP_PATH);
  });

  // Through the shared opener, so the route the user is already on reloads
  // rather than collecting a second history entry for itself.
  test("reloads in place when the route already names the app", async () => {
    await renderChatInfo(null, { path: APP_PATH });

    fireEvent.click(screen.getByLabelText("Open App 1"));

    expect(calls).toEqual(["closeChatInfo", "loadApp"]);
    expect(loadApp).toHaveBeenCalledWith(ASSISTANT_ID, APP_ID);
    expect(currentLocation().pathname).toBe(APP_PATH);
  });

  test("dismisses itself when another assistant takes over", async () => {
    await renderChatInfo();
    expect(closeChatInfo).not.toHaveBeenCalled();

    await act(async () => {
      useResolvedAssistantsStore.setState({ activeAssistantId: "asst-2" });
    });

    expect(closeChatInfo).toHaveBeenCalledTimes(1);
  });

  test("stays open while no assistant is active", async () => {
    await renderChatInfo();

    await act(async () => {
      useResolvedAssistantsStore.setState({ activeAssistantId: null });
    });

    expect(closeChatInfo).not.toHaveBeenCalled();

    await act(async () => {
      useResolvedAssistantsStore.setState({ activeAssistantId: ASSISTANT_ID });
    });

    expect(closeChatInfo).not.toHaveBeenCalled();
  });

  // The dismissal lands in an effect, so a tile clicked in the same commit
  // still has to refuse: its app id belongs to the payload's assistant.
  test("opens no app while its assistant is not the active one", async () => {
    useResolvedAssistantsStore.setState({ activeAssistantId: "asst-2" });

    await renderChatInfo();
    fireEvent.click(screen.getByLabelText("Open App 1"));

    expect(loadApp).not.toHaveBeenCalled();
    expect(currentLocation().pathname).toBe(CONVERSATION_PATH);
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
  const APPS_KEY = appsGetQueryKey({
    path: { assistant_id: ASSISTANT_ID },
    query: { conversationId: CONVERSATION_ID },
  });
  const DOCUMENTS_KEY = documentsGetQueryKey({
    path: { assistant_id: ASSISTANT_ID },
    query: { conversationId: CONVERSATION_ID },
  });

  /** Leaves the documents source failed with nothing cached under it. */
  function failDocuments(client: QueryClient): void {
    client.removeQueries({ queryKey: DOCUMENTS_KEY });
    seedQueryFailure(client, DOCUMENTS_KEY);
  }

  /**
   * Takes both daemon sources back out of the client the seed filled, so a
   * pending client really is pending: `setQueryData` answers a disabled query
   * as readily as an enabled one.
   */
  function unresolveSources(client: QueryClient): void {
    client.removeQueries({ queryKey: APPS_KEY });
    client.removeQueries({ queryKey: DOCUMENTS_KEY });
  }

  /** The panel against sources that have answered nothing yet. */
  function renderLoading(
    category: ChatInfoCategory | null = null,
    seed: Seed = {},
  ): Promise<void> {
    return renderChatInfo(category, {
      ...seed,
      client: makePendingChatInfoQueryClient(),
      afterSeed: unresolveSources,
    });
  }

  test("says nothing at all while the sources are loading", async () => {
    await renderLoading(null, { messages: [] });

    expect(screen.getByText("Chat Info")).toBeDefined();
    expect(screen.queryByText("No assets in this chat yet")).toBeNull();
    expect(screen.queryByText("Assets could not be loaded")).toBeNull();
  });

  test("lists the transcript's files while the sources are loading", async () => {
    await renderLoading();

    expect(screen.getByLabelText("Preview photo-0.png")).toBeDefined();
    expect(screen.queryByText("No assets in this chat yet")).toBeNull();
    expect(screen.queryByText("Assets could not be loaded")).toBeNull();
  });

  // Seeded with no apps at all, so the fallback to the top level is what this
  // would catch: a category that reads empty before its source has answered.
  test("keeps the payload's category while the sources are loading", async () => {
    await renderLoading("apps", { apps: [] });

    expect(screen.getByLabelText("Back to chat info")).toBeDefined();
    expect(onSelectCategory).not.toHaveBeenCalled();
  });

  test("says so once a conversation with nothing has loaded", async () => {
    await renderChatInfo(null, { apps: [], documents: [], messages: [] });

    expect(screen.getByText("No assets in this chat yet")).toBeDefined();
  });

  test("keeps listing documents a failed refetch left cached", async () => {
    await renderChatInfo(null, {
      afterSeed: (client) => seedQueryFailure(client, DOCUMENTS_KEY),
    });

    expect(screen.getByLabelText("Open Trip Notes")).toBeDefined();
    expect(screen.queryByText("Assets could not be loaded")).toBeNull();
  });

  test("places a document failure inside Files alongside available attachments", async () => {
    await renderChatInfo(null, { apps: [], afterSeed: failDocuments });

    const notice = screen.getByText("Documents could not be loaded.");
    const filesTitle = screen.getByText("Documents & Images");
    expect(screen.getByLabelText("Preview photo-0.png")).toBeDefined();
    expect(
      notice.compareDocumentPosition(filesTitle) &
        Node.DOCUMENT_POSITION_PRECEDING,
    ).toBeGreaterThan(0);
  });

  // The notice sits above the body at every level, so a category drilled into
  // while a source is down is not a silent grid.
  test("names the failed source in its drilled-in category", async () => {
    await renderChatInfo("files", { apps: [], afterSeed: failDocuments });

    // Nothing of the source loaded, so it is an error, announced as one.
    expect(screen.getByRole("alert").textContent).toContain(
      "Documents could not be loaded.",
    );
    expect(screen.getByLabelText("Preview photo-0.png")).toBeDefined();
  });
});

describe("ChatInfoPanel retry controls", () => {
  test("retries only documents and preserves the selected Files view and existing tiles", async () => {
    const client = makeChatInfoQueryClient();
    const documentKey = documentsGetQueryKey({
      path: { assistant_id: ASSISTANT_ID },
      query: { conversationId: CONVERSATION_ID },
    });
    await renderChatInfo("files", {
      client,
      afterSeed: (cache) => {
        seedQueryFailure(cache, documentKey);
      },
    });
    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    let release: (() => void) | undefined;
    const response = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchMock: typeof fetch = async (input) => {
      requests.push(input instanceof Request ? input.url : String(input));
      await response;
      return new Response(JSON.stringify({ documents: DOCUMENTS }), {
        headers: { "content-type": "application/json" },
      });
    };
    fetchMock.preconnect = originalFetch.preconnect;
    globalThis.fetch = fetchMock;
    try {
      const existingTile = screen.getByLabelText("Preview photo-0.png");
      fireEvent.click(screen.getByRole("button", { name: "Retry Documents" }));
      await waitFor(() => expect(requests).toHaveLength(1));
      await waitFor(() =>
        expect(
          (
            screen.getByRole("button", {
              name: "Retry Documents",
            }) as HTMLButtonElement
          ).disabled,
        ).toBe(true),
      );
      fireEvent.click(screen.getByRole("button", { name: "Retry Documents" }));
      expect(requests).toHaveLength(1);
      expect(screen.getByLabelText("Preview photo-0.png")).toBe(existingTile);
      expect(screen.getByLabelText("Back to chat info")).toBeDefined();
      expect(onSelectCategory).not.toHaveBeenCalled();
      expect(closeChatInfo).not.toHaveBeenCalled();
      release!();
      await waitFor(() =>
        expect(
          Boolean(
            screen.queryByText(
              "Documents could not be refreshed. Showing saved results.",
            ),
          ),
        ).toBe(false),
      );
      expect(screen.getByLabelText("Open Trip Notes")).toBeDefined();
      expect(requests[0]).toContain("/documents?");
      expect(requests).toHaveLength(1);
    } finally {
      release?.();
      globalThis.fetch = originalFetch;
    }
  });

  test("offers one full-failure Retry that recovers every failed source", async () => {
    const restoreVersion = reportAssistantVersion();
    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    const fetchMock: typeof fetch = async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      requests.push(url);
      const data = url.includes("/apps?")
        ? { apps: [] }
        : url.includes("/documents?")
          ? { documents: [] }
          : { attachments: [], total: 0, hasMore: false };
      return new Response(JSON.stringify(data), {
        headers: { "content-type": "application/json" },
      });
    };
    fetchMock.preconnect = originalFetch.preconnect;
    try {
      await renderChatInfo(null, {
        apps: [],
        documents: [],
        messages: [],
        afterSeed: (cache) => {
          const args = {
            path: { assistant_id: ASSISTANT_ID },
            query: { conversationId: CONVERSATION_ID },
          };
          const keys = [
            appsGetQueryKey(args),
            documentsGetQueryKey(args),
            ...(["exclude", "only"] as const).map((filter) =>
              attachmentsGetInfiniteQueryKey(
                conversationAttachmentListArgs(
                  ASSISTANT_ID,
                  CONVERSATION_ID,
                  filter,
                ),
              ),
            ),
          ];
          for (const queryKey of keys) {
            cache.removeQueries({ queryKey });
            seedQueryFailure(cache, queryKey);
          }
        },
      });
      expect(screen.getByText("Assets could not be loaded")).toBeDefined();
      expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(1);
      globalThis.fetch = fetchMock;
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await screen.findByText("No assets in this chat yet");
      expect(requests).toHaveLength(4);
      expect(screen.queryByText("Assets could not be loaded")).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
      act(() => restoreVersion());
    }
  });

  test("does not put a document failure above a healthy Apps view", async () => {
    await renderChatInfo("apps", {
      afterSeed: (cache) => {
        const queryKey = documentsGetQueryKey({
          path: { assistant_id: ASSISTANT_ID },
          query: { conversationId: CONVERSATION_ID },
        });
        cache.removeQueries({ queryKey });
        seedQueryFailure(cache, queryKey);
      },
    });
    expect(screen.getAllByLabelText(/^Open App \d+$/)).toHaveLength(12);
    expect(screen.queryByText("Documents could not be loaded.")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Retry Documents" }),
    ).toBeNull();
  });
});
