/**
 * `ChatInfoPanel` at both of its levels: the three category rows, and the
 * grid a See All drills into.
 *
 * The conversation's assets, the row's measured width, and the window-size
 * axis all arrive through module mocks, since happy-dom reports a zero box for
 * everything and the real hook would want a daemon behind it. What is left is
 * what this component owns: which sections exist, where See All appears, which
 * level renders, and the sequence each tile runs when it is opened.
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
} from "@testing-library/react";
import type { ReactElement } from "react";

import * as appHtmlCache from "@/utils/app-html-cache";
import type * as ConversationAssetsModule from "@/domains/chat/hooks/use-conversation-assets";
import type * as ElementSizeModule from "@/hooks/use-element-size";
import type * as IsMobileModule from "@/hooks/use-is-mobile";
import type { AppSummary } from "@/types/app-types";
import type { ChatInfoCategory } from "@/stores/viewer-store";
import type { DocumentSummary } from "@/types/document-types";

type ConversationAssets = ConversationAssetsModule.ConversationAssets;
type ConversationFileAsset = ConversationAssetsModule.ConversationFileAsset;

const ASSISTANT_ID = "asst-1";
const CONVERSATION_ID = "conv-1";
/** The drawer's body width on the desktop mock: 3 app tiles, 4 file tiles. */
const DRAWER_WIDTH = 569;

// happy-dom implements neither object URLs nor IntersectionObserver.
globalThis.URL.createObjectURL = mock(
  (_obj: Blob | MediaSource): string => "blob:chat-info-panel",
);
globalThis.URL.revokeObjectURL = mock((_url: string): void => undefined);

class ImmediateIntersectionObserver {
  readonly root = null;
  readonly rootMargin = "";
  readonly thresholds: number[] = [];
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe(target: Element): void {
    this.callback(
      [{ isIntersecting: true, target } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}
globalThis.IntersectionObserver =
  ImmediateIntersectionObserver as unknown as typeof IntersectionObserver;

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

const assetsRef = { value: null as ConversationAssets | null };
const assetsTargets: ConversationAssetsModule.ConversationAssetsTarget[] = [];
mock.module(
  "@/domains/chat/hooks/use-conversation-assets",
  (): Partial<typeof ConversationAssetsModule> => ({
    useConversationAssets: (target) => {
      assetsTargets.push(target);
      return assetsRef.value!;
    },
  }),
);

const calls: string[] = [];

const { ChatInfoPanel } =
  await import("@/domains/chat/components/chat-info-panel");
const { useViewerStore } = await import("@/stores/viewer-store");
const { useUnseenDocumentChangesStore } =
  await import("@/domains/chat/unseen-document-changes-store");
const { appsGetQueryKey } =
  await import("@/generated/daemon/@tanstack/react-query.gen");
const { makeDisplayAttachment, SAMPLE_PREVIEWS } =
  await import("@/domains/chat/components/chat-attachments/attachment-fixtures");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const APPS: AppSummary[] = Array.from({ length: 12 }, (_, index) => ({
  id: `app-${index + 1}`,
  name: `App ${index + 1}`,
  icon: "🧭",
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000 + index,
  version: "1.0.0",
  contentId: `content-${index + 1}`,
  origin: "workspace",
}));

function makeDoc(surfaceId: string, title: string): DocumentSummary {
  return {
    surfaceId,
    conversationId: CONVERSATION_ID,
    title,
    wordCount: 120,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_001,
  };
}

const TRIP_NOTES = makeDoc("surface-trip-notes", "Trip Notes");
const PACKING_LIST = makeDoc("surface-packing-list", "Packing List");

function documentAsset(doc: DocumentSummary): ConversationFileAsset {
  return {
    kind: "document",
    id: `doc-${doc.surfaceId}`,
    title: doc.title,
    doc,
  };
}

function imageAsset(index: number): ConversationFileAsset {
  const attachment = makeDisplayAttachment({
    id: `img-${index}`,
    filename: `photo-${index}.png`,
    previewUrl: SAMPLE_PREVIEWS[index]!,
  });
  return {
    kind: "attachment",
    id: `att-${attachment.id}`,
    title: attachment.filename,
    attachment,
  };
}

function frameAsset(index: number): ConversationFileAsset {
  const attachment = makeDisplayAttachment({
    id: `frame-${index}`,
    filename: `frame-${index}.png`,
    previewUrl: SAMPLE_PREVIEWS[index]!,
  });
  return {
    kind: "frame",
    id: `frame-${attachment.id}`,
    title: attachment.filename,
    attachment,
    capturedAt: null,
  };
}

const FILES: ConversationFileAsset[] = [
  documentAsset(TRIP_NOTES),
  documentAsset(PACKING_LIST),
  imageAsset(0),
  imageAsset(1),
];
const FRAMES: ConversationFileAsset[] = [
  frameAsset(2),
  frameAsset(3),
  frameAsset(4),
];

const loadMoreFiles = mock((): void => undefined);
const loadMoreFrames = mock((): void => undefined);

function makeAssets(
  overrides: Partial<ConversationAssets> = {},
): ConversationAssets {
  const apps = overrides.apps ?? APPS;
  const files = overrides.files ?? FILES;
  const frames = overrides.frames ?? FRAMES;
  return {
    apps,
    files,
    frames,
    counts: { apps: apps.length, files: files.length, frames: frames.length },
    count: apps.length + files.length + frames.length,
    hasMoreFiles: false,
    hasMoreFrames: true,
    loadMoreFiles,
    loadMoreFrames,
    ...overrides,
  };
}

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

function renderPanel(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  // Seeded so an app tile's options menu never reaches the daemon for its pin.
  client.setQueryData(
    appsGetQueryKey({ path: { assistant_id: ASSISTANT_ID } }),
    { apps: APPS },
  );
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

/** Awaited so each app tile's preview html settles inside the test. */
async function renderChatInfo(
  category: ChatInfoCategory | null = null,
): Promise<void> {
  await act(async () => {
    renderPanel(
      <ChatInfoPanel
        payload={{
          assistantId: ASSISTANT_ID,
          conversationId: CONVERSATION_ID,
          category,
        }}
        onClose={onClose}
        onSelectCategory={onSelectCategory}
      />,
    );
  });
}

beforeEach(() => {
  assetsRef.value = makeAssets();
  calls.length = 0;
  assetsTargets.length = 0;
  useUnseenDocumentChangesStore.setState({ changedDocuments: {} });
  loadApp.mockClear();
  closeChatInfo.mockClear();
  loadDocument.mockClear();
  loadMoreFiles.mockClear();
  loadMoreFrames.mockClear();
  onClose.mockClear();
  onSelectCategory.mockClear();
  useViewerStore.setState({ closeChatInfo, loadApp, loadDocument });
});

afterEach(() => {
  cleanup();
  useUnseenDocumentChangesStore.setState({ changedDocuments: {} });
});

// `mock.module` is process-global in this runner, so the module graph is put
// back before the next file loads.
afterAll(() => {
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
    expect(screen.getByText("Camera Frames")).toBeDefined();
    expect(screen.getByText("12")).toBeDefined();
    expect(screen.getByText("4")).toBeDefined();
    expect(screen.getByText("3")).toBeDefined();
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
    await renderChatInfo();

    expect(assetsTargets[0]).toEqual({
      assistantId: ASSISTANT_ID,
      conversationId: CONVERSATION_ID,
    });
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
});

describe("ChatInfoPanel See All level", () => {
  test("lists every tile in the category and offers a way back", async () => {
    await renderChatInfo("apps");

    expect(screen.getAllByLabelText(/^Open App \d+$/)).toHaveLength(12);

    fireEvent.click(screen.getByLabelText("Back to chat info"));

    expect(onSelectCategory).toHaveBeenCalledWith(null);
  });

  test("grows a paged category from its Load more control", async () => {
    await renderChatInfo("frames");

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));

    expect(loadMoreFrames).toHaveBeenCalledTimes(1);
    expect(loadMoreFiles).not.toHaveBeenCalled();
  });

  test("holds no Load more for a category that has everything", async () => {
    await renderChatInfo("files");

    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  test("falls back to the top level once the category empties", async () => {
    assetsRef.value = makeAssets({ apps: [] });
    await renderChatInfo("apps");

    expect(screen.getByText("Chat Info")).toBeDefined();
    expect(screen.queryByLabelText("Back to chat info")).toBeNull();
    // Settled in the store too, so a refilled category cannot drill back in
    // on its own and See All on it is not a silent no-op.
    expect(onSelectCategory).toHaveBeenCalledWith(null);
  });
});
