/**
 * Tests for `ConversationAssetsPill`: the Chat Info trigger it registers in the
 * viewer store, and its unseen-document-changes affordance.
 *
 * The pill's asset count comes from TanStack queries, so the suite seeds the
 * cache with `staleTime: Infinity` instead of mocking the SDK: nothing
 * refetches on mount and the count is exactly what a test asks for.
 *
 * Class strings are deliberately not asserted (happy-dom makes those brittle);
 * the dot is located by its `data-testid` and the state it communicates is
 * asserted through the trigger's accessible name. The one exception is the
 * appearance pulse, which has no accessible surface at all: those tests check
 * for the single animation class token on the dot and nothing else.
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
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import * as motionReact from "motion/react";

import { makeDisplayAttachment } from "@/domains/chat/components/chat-attachments/attachment-fixtures";
import {
  attachmentRows,
  clearTranscriptMessages,
  holdOrgHeaderUnresolved,
  installChatInfoDomStubs,
  makeChatInfoQueryClient,
  makeDocumentSummary,
  makePendingChatInfoQueryClient,
  seedChatInfoConversation,
  seedQueryFailure,
  seedTranscriptMessages,
} from "@/domains/chat/components/chat-info.test-helper";
import { documentsGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import { viewportAxesStub } from "@/hooks/viewport-axes.test-helper";
import type { DocumentSummary } from "@/types/document-types";
import { ApiError } from "@/utils/api-errors";

const restoreDomStubs = installChatInfoDomStubs();

const viewport = viewportAxesStub();

// `useReducedMotion` reads a cached media-query singleton, so a per-test
// `matchMedia` stub can't flip it. Override just that export and drive it
// through this toggle instead.
let reducedMotion = false;
mock.module("motion/react", () => ({
  ...motionReact,
  useReducedMotion: () => reducedMotion,
}));

const {
  ConversationAssetsPill,
  ASSETS_PILL_UNSEEN_DOT_TESTID,
  ASSETS_PILL_UNSEEN_DOT_PULSE_CLASS,
} = await import("@/domains/chat/components/conversation-assets-pill");
const { ChatInfoPanel } =
  await import("@/domains/chat/components/chat-info-panel");
const { useUnseenDocumentChangesStore } =
  await import("@/domains/chat/unseen-document-changes-store");
const { useViewerStore } = await import("@/stores/viewer-store");

const ASSISTANT_ID = "asst-1";
const CONVERSATION_ID = "conv-1";
const SURFACE_ID = "surface-1";
const OTHER_CONVERSATION_ID = "conv-2";
const OTHER_SURFACE_ID = "surface-2";

const DOC_TITLE = "Roadmap";

const UNAVAILABLE_LABEL = "Conversation assets, could not be loaded";

// Singular: these fixtures seed one asset, and the ICU `plural` in
// `conversationAssets.ariaLabel` agrees with the count.
const SEEN_LABEL = "Conversation assets, 1 item";
const UNSEEN_LABEL = "Conversation assets, 1 item (unseen changes)";

function makeDocument(
  conversationId = CONVERSATION_ID,
  surfaceId = SURFACE_ID,
): DocumentSummary {
  return makeDocumentSummary({ surfaceId, conversationId, title: DOC_TITLE });
}

function seedConversation(
  client: QueryClient,
  documents: DocumentSummary[],
  conversationId: string,
) {
  seedChatInfoConversation(client, {
    assistantId: ASSISTANT_ID,
    conversationId,
    documents,
  });
}

function renderPill({ withAssets = true }: { withAssets?: boolean } = {}) {
  const client = makeChatInfoQueryClient();
  seedConversation(client, withAssets ? [makeDocument()] : [], CONVERSATION_ID);
  seedConversation(
    client,
    [makeDocument(OTHER_CONVERSATION_ID, OTHER_SURFACE_ID)],
    OTHER_CONVERSATION_ID,
  );

  const pill = (conversationId: string) => (
    <QueryClientProvider client={client}>
      <ConversationAssetsPill
        assistantId={ASSISTANT_ID}
        conversationId={conversationId}
      />
    </QueryClientProvider>
  );

  const view = render(pill(CONVERSATION_ID));

  return {
    unmount: () => view.unmount(),
    /** Swap the prop on the already-mounted pill, as the chat header does. */
    switchConversation: (conversationId: string) => {
      // Every real switch drops the transcript panel payloads before the
      // header re-renders; the store settles the view from there. The chat
      // session follows the header too, so the incoming conversation is the
      // one that owns the loaded transcript.
      act(() => {
        useViewerStore.getState().clearTranscriptPanelPayloads();
        seedTranscriptMessages(ASSISTANT_ID, conversationId, []);
      });
      view.rerender(pill(conversationId));
    },
  };
}

const DOCUMENTS_KEY = documentsGetQueryKey({
  path: { assistant_id: ASSISTANT_ID },
  query: { conversationId: CONVERSATION_ID },
});

/**
 * A client whose documents source failed with nothing cached under it, apps
 * answered: the trigger names a failure only once every source has settled.
 */
function failedDocumentsClient(): QueryClient {
  const client = makePendingChatInfoQueryClient();
  seedConversation(client, [], CONVERSATION_ID);
  client.removeQueries({ queryKey: DOCUMENTS_KEY });
  seedQueryFailure(client, DOCUMENTS_KEY);
  return client;
}

/** The same failure, carrying the status a restarting assistant answers with. */
function unavailableDocumentsClient(): QueryClient {
  const client = failedDocumentsClient();
  client
    .getQueryCache()
    .find({ queryKey: DOCUMENTS_KEY })!
    .setState({ error: new ApiError(503, "HTTP 503") });
  return client;
}

/** Mounts the trigger alone against a client a test has set up itself. */
function renderPillWith(client: QueryClient) {
  render(
    <QueryClientProvider client={client}>
      <ConversationAssetsPill
        assistantId={ASSISTANT_ID}
        conversationId={CONVERSATION_ID}
      />
    </QueryClientProvider>,
  );
}

/**
 * The trigger and the panel together, hosted the way the chat layout hosts
 * them: both read the real viewer store, so what one does the other sees.
 */
function ComposedChatInfo({ client }: { client: QueryClient }) {
  const mainView = useViewerStore.use.mainView();
  const activeChatInfo = useViewerStore.use.activeChatInfo();
  const { closeChatInfo, setChatInfoCategory } = useViewerStore.getState();
  return (
    <QueryClientProvider client={client}>
      <ConversationAssetsPill
        assistantId={ASSISTANT_ID}
        conversationId={CONVERSATION_ID}
      />
      {mainView === "chat-info" && activeChatInfo !== null ? (
        <ChatInfoPanel
          payload={activeChatInfo}
          onClose={closeChatInfo}
          onSelectCategory={setChatInfoCategory}
        />
      ) : null}
    </QueryClientProvider>
  );
}

function renderComposed() {
  const client = makeChatInfoQueryClient();
  seedConversation(client, [makeDocument()], CONVERSATION_ID);
  render(<ComposedChatInfo client={client} />);

  return {
    /** Drop the conversation's last asset, as a delete would. */
    emptyAssets: () => {
      seedConversation(client, [], CONVERSATION_ID);
    },
  };
}

function markUnseen(conversationId = CONVERSATION_ID, surfaceId = SURFACE_ID) {
  useUnseenDocumentChangesStore
    .getState()
    .markDocumentChanged(conversationId, surfaceId);
}

function unseenConversations(): string[] {
  return Object.keys(useUnseenDocumentChangesStore.getState().changedDocuments);
}

function chatInfoState() {
  const { mainView, activeChatInfo } = useViewerStore.getState();
  return { mainView, activeChatInfo };
}

let releaseOrgHeader = () => {};

beforeEach(() => {
  // Both daemon queries gate on the org header, so holding it unresolved is
  // what leaves a source a test does not seed unresolved, with nothing
  // requested.
  releaseOrgHeader = holdOrgHeaderUnresolved();
  // A settled transcript, so the trigger's sources are only as unresolved as
  // a test makes them: an unloaded one holds the count pending on its own.
  seedTranscriptMessages(ASSISTANT_ID, CONVERSATION_ID, []);
  viewport.set({ narrow: false, coarsePointer: false });
  useUnseenDocumentChangesStore.setState({ changedDocuments: {} });
  useViewerStore.getState().reset();
});

afterEach(() => {
  cleanup();
  releaseOrgHeader();
  clearTranscriptMessages();
  viewport.restore();
  reducedMotion = false;
  useUnseenDocumentChangesStore.setState({ changedDocuments: {} });
  useViewerStore.getState().reset();
});

// `mock.module` is process-global in this runner, so the module graph and the
// stubbed browser APIs are put back before the next file loads.
afterAll(() => {
  restoreDomStubs();
  mock.restore();
});

function dotHasPulse(): boolean {
  return screen
    .getByTestId(ASSETS_PILL_UNSEEN_DOT_TESTID)
    .classList.contains(ASSETS_PILL_UNSEEN_DOT_PULSE_CLASS);
}

describe("desktop pill", () => {
  test("shows the dot and names the state when a change is unseen", () => {
    markUnseen();
    renderPill();

    expect(screen.getByTestId(ASSETS_PILL_UNSEEN_DOT_TESTID)).toBeTruthy();
    expect(screen.getByRole("button", { name: UNSEEN_LABEL })).toBeTruthy();
  });

  test("shows no dot and the plain name when nothing is unseen", () => {
    renderPill();

    expect(screen.queryByTestId(ASSETS_PILL_UNSEEN_DOT_TESTID)).toBeNull();
    expect(screen.getByRole("button", { name: SEEN_LABEL })).toBeTruthy();
  });

  // The dot survives the click here: the panel is what clears it, and this
  // suite renders the trigger alone.
  test("opening the panel sets mainView to chat-info", () => {
    markUnseen();
    renderPill();

    fireEvent.click(screen.getByRole("button", { name: UNSEEN_LABEL }));

    expect(chatInfoState()).toEqual({
      mainView: "chat-info",
      activeChatInfo: {
        assistantId: ASSISTANT_ID,
        conversationId: CONVERSATION_ID,
        category: null,
      },
    });
    expect(unseenConversations()).toEqual([CONVERSATION_ID]);
  });

  test("clicking while open closes the panel", () => {
    renderPill();

    fireEvent.click(screen.getByRole("button", { name: SEEN_LABEL }));
    expect(chatInfoState().mainView).toBe("chat-info");

    fireEvent.click(screen.getByRole("button", { name: SEEN_LABEL }));

    expect(chatInfoState()).toEqual({
      mainView: "chat",
      activeChatInfo: null,
    });
  });

  test("aria-expanded reflects the store", () => {
    renderPill();

    const trigger = screen.getByRole("button", { name: SEEN_LABEL });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    // Store-first, so the attribute tracks the view however it was opened,
    // not just the trigger's own click.
    act(() => {
      useViewerStore.getState().openChatInfo({
        assistantId: ASSISTANT_ID,
        conversationId: CONVERSATION_ID,
      });
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    act(() => {
      useViewerStore.getState().closeChatInfo();
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("narrow window with a mouse", () => {
  // Room decides whether the count fits in the header cluster: a narrow window
  // gets the compact trigger and the same panel.
  beforeEach(() => {
    viewport.set({ narrow: true, coarsePointer: false });
  });

  test("trigger is icon-only and keeps its accessible name", () => {
    renderPill();

    expect(screen.getByRole("button", { name: SEEN_LABEL }).textContent).toBe(
      "",
    );
  });

  test("opening the panel sets mainView to chat-info", () => {
    markUnseen();
    renderPill();

    fireEvent.click(screen.getByRole("button", { name: UNSEEN_LABEL }));

    expect(chatInfoState().mainView).toBe("chat-info");
  });
});

describe("conversation switch while the panel is open", () => {
  /**
   * The chat header renders one unkeyed pill and swaps `conversationId` on it,
   * so the open panel would otherwise survive the switch. The store settles it
   * from `clearTranscriptPanelPayloads`, which every switch runs: the incoming
   * conversation's assets are never put on screen unasked, and its changes
   * stay marked unseen until the user opens the panel.
   */
  test("closes the panel and keeps the incoming dot", () => {
    markUnseen(OTHER_CONVERSATION_ID, OTHER_SURFACE_ID);
    const { switchConversation } = renderPill();

    fireEvent.click(screen.getByRole("button", { name: SEEN_LABEL }));
    expect(chatInfoState().mainView).toBe("chat-info");

    switchConversation(OTHER_CONVERSATION_ID);

    expect(chatInfoState()).toEqual({
      mainView: "chat",
      activeChatInfo: null,
    });
    expect(screen.getByTestId(ASSETS_PILL_UNSEEN_DOT_TESTID)).toBeTruthy();
    expect(screen.getByRole("button", { name: UNSEEN_LABEL })).toBeTruthy();
    expect(unseenConversations()).toEqual([OTHER_CONVERSATION_ID]);
  });
});

describe("the last asset leaving while the panel is open", () => {
  // The panel says it is empty and carries its own close control, so the
  // trigger going does not have to take it down.
  test("leaves the panel showing the empty copy, trigger gone", async () => {
    const { emptyAssets } = renderComposed();

    fireEvent.click(screen.getByRole("button", { name: SEEN_LABEL }));
    expect(screen.getByLabelText(`Open ${DOC_TITLE}`)).toBeTruthy();

    emptyAssets();

    await waitFor(() => {
      expect(screen.getByText("No assets in this chat yet")).toBeTruthy();
    });
    expect(screen.queryByRole("button", { name: /^Conversation assets/ })).toBe(
      null,
    );
    expect(chatInfoState().mainView).toBe("chat-info");
  });
});

describe("pill unmount while the panel is open", () => {
  test("closes the panel it owns", () => {
    const { unmount } = renderPill();
    fireEvent.click(screen.getByRole("button", { name: SEEN_LABEL }));
    expect(useViewerStore.getState().mainView).toBe("chat-info");

    unmount();

    expect(useViewerStore.getState().mainView).toBe("chat");
    expect(useViewerStore.getState().activeChatInfo).toBeNull();
  });
});

describe("appearance pulse", () => {
  // One `layersIcon` node feeds both the mobile trigger and the desktop pill,
  // so the pulse has a single render site and needs no per-platform case.
  test("pulses the dot when a change lands", () => {
    markUnseen();
    renderPill();

    expect(dotHasPulse()).toBe(true);
  });

  test("appears without animating when reduced motion is preferred", () => {
    reducedMotion = true;
    markUnseen();
    renderPill();

    expect(screen.getByTestId(ASSETS_PILL_UNSEEN_DOT_TESTID)).toBeTruthy();
    expect(dotHasPulse()).toBe(false);
  });
});

describe("empty asset list", () => {
  /**
   * Pins the deliberate trade-off: the pill renders nothing at all without
   * assets, so there is no Layers icon to carry a dot. An unseen change in
   * that window stays recorded in the store and the dot appears as soon as
   * the documents query reports the asset, rather than the pill being forced
   * to render a trigger for an empty panel.
   */
  test("renders nothing even when a change is unseen", () => {
    markUnseen();
    renderPill({ withAssets: false });

    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByTestId(ASSETS_PILL_UNSEEN_DOT_TESTID)).toBeNull();
    expect(unseenConversations()).toEqual([CONVERSATION_ID]);
  });

  // Counting nothing yet is not counting nothing: a trigger that appears with
  // "0 items" on every uncached chat and vanishes a frame later is worse than
  // no trigger at all.
  test("renders nothing while its sources are still unresolved", () => {
    renderPillWith(makePendingChatInfoQueryClient());

    expect(screen.queryByRole("button")).toBeNull();
  });

  // The three sources resolve one at a time, so a total counted before they
  // all have is a number the trigger would have to take back.
  test("renders nothing while a source is unresolved, whatever it has counted", () => {
    seedTranscriptMessages(
      ASSISTANT_ID,
      CONVERSATION_ID,
      attachmentRows([makeDisplayAttachment({ id: "att-1" })]),
    );

    renderPillWith(makePendingChatInfoQueryClient());

    expect(screen.queryByRole("button")).toBeNull();
  });

  // A first load that failed also counts nothing, and hiding the trigger there
  // would leave the user no way to reach the panel that reports the failure.
  // It names the failure rather than a count it cannot know.
  test("keeps the trigger when a source could not be loaded", () => {
    renderPillWith(failedDocumentsClient());

    expect(
      screen.getByRole("button", { name: UNAVAILABLE_LABEL }),
    ).toBeTruthy();
  });

  // A restart's 503 is retried before it settles, so one that settled anyway
  // is a source that is not coming back inside this conversation's lifetime.
  test("keeps the trigger when a transient status settled", () => {
    renderPillWith(unavailableDocumentsClient());

    expect(
      screen.getByRole("button", { name: UNAVAILABLE_LABEL }),
    ).toBeTruthy();
  });

  // The dot points at changes inside a list the trigger could not load, and
  // the name beside it no longer mentions them.
  test("drops the unseen dot when a source could not be loaded", () => {
    markUnseen();
    renderPillWith(failedDocumentsClient());

    expect(
      screen.getByRole("button", { name: UNAVAILABLE_LABEL }),
    ).toBeTruthy();
    expect(screen.queryByTestId(ASSETS_PILL_UNSEEN_DOT_TESTID)).toBeNull();
  });
});

describe("desktop tooltip", () => {
  // The count and the failure copy reach the screen nowhere else on a roomy
  // window: the glyph carries no label of its own.
  test("carries the count the trigger holds", async () => {
    renderPill();

    act(() => {
      screen.getByRole("button", { name: SEEN_LABEL }).focus();
    });

    expect((await screen.findByRole("tooltip")).textContent).toBe("1 asset");
  });

  test("names the failure instead of a count it cannot know", async () => {
    renderPillWith(failedDocumentsClient());

    act(() => {
      screen.getByRole("button", { name: UNAVAILABLE_LABEL }).focus();
    });

    expect((await screen.findByRole("tooltip")).textContent).toBe(
      "Assets could not be loaded",
    );
  });
});
