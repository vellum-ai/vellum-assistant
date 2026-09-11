/**
 * The standalone `/assistant/documents/:surfaceId` route is a second way into
 * a document, so opening one there clears its unseen-change record just as the
 * in-chat viewer does. It also hosts the mobile document composer inside
 * `RootLayout`'s app shell, which already pads the bottom safe area, so the
 * composer is handed no inset of its own.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";

import type { DocumentsByIdGetResponse } from "@/generated/daemon/types.gen";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useUnseenDocumentChangesStore } from "@/domains/chat/unseen-document-changes-store";
import { useViewerStore } from "@/stores/viewer-store";

const daemonSdk = await import("@/generated/daemon/sdk.gen");

type DocumentResult = { data: DocumentsByIdGetResponse | null };

let documentResult: () => Promise<DocumentResult> = () =>
  Promise.reject(new Error("not stubbed"));
const conversationsPostMock = mock(async (_options: unknown) => ({
  data: { id: "conv-minted" },
}));

mock.module("@/generated/daemon/sdk.gen", () => ({
  ...daemonSdk,
  documentsByIdGet: () => documentResult(),
  conversationsPost: (options: unknown) => conversationsPostMock(options),
}));

const compatibilityUtils = await import("@/lib/backwards-compat/utils");
let assistantVersionKnown = true;
const whenAssistantVersionKnownForMock = mock(
  async (_assistantId: string) => {},
);
mock.module("@/lib/backwards-compat/utils", () => ({
  ...compatibilityUtils,
  assistantVersionKnownFor: () => assistantVersionKnown,
  whenAssistantVersionKnownFor: (assistantId: string) =>
    whenAssistantVersionKnownForMock(assistantId),
}));

const toastModule = await import("@vellumai/design-library/components/toast");
const toastErrorMock = mock((..._args: unknown[]) => {});
mock.module("@vellumai/design-library/components/toast", () => ({
  ...toastModule,
  toast: {
    ...toastModule.toast,
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}));

let mockIsMobile = false;
mock.module("@/hooks/use-is-mobile", () => ({
  useIsMobile: () => mockIsMobile,
}));

let composerPanelProps: Record<string, unknown> | null = null;
let viewerProps: Record<string, unknown> | null = null;
mock.module("@/domains/chat/components/document-composer-panel", () => ({
  DocumentComposerPanel: (props: Record<string, unknown>) => {
    composerPanelProps = props;
    return <div data-testid="doc-composer-panel" />;
  },
}));

mock.module("./components/document-viewer-container", () => ({
  DocumentViewerContainer: (props: Record<string, unknown>) => {
    viewerProps = props;
    return <div data-testid="viewer" />;
  },
}));

const { DocumentViewerPage } =
  await import("@/domains/chat/document-viewer-page");

function documentSurface(
  overrides: Partial<DocumentsByIdGetResponse> = {},
): DocumentsByIdGetResponse {
  return {
    success: true,
    surfaceId: "surf-1",
    conversationId: "conv-1",
    title: "Notes",
    content: "# Notes",
    wordCount: 2,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function GoTo({ to }: { to: string }) {
  const navigate = useNavigate();
  return (
    <button type="button" data-testid="go" onClick={() => navigate(to)}>
      go
    </button>
  );
}

function renderPage(surfaceId: string, navigateTo?: string) {
  return render(
    <MemoryRouter initialEntries={[`/assistant/documents/${surfaceId}`]}>
      <Routes>
        <Route
          path="/assistant/documents/:surfaceId"
          element={<DocumentViewerPage />}
        />
      </Routes>
      {navigateTo ? <GoTo to={navigateTo} /> : null}
    </MemoryRouter>,
  );
}

function unseenFor(conversationId: string): string[] {
  const changed =
    useUnseenDocumentChangesStore.getState().changedDocuments[conversationId];
  return [...(changed ?? [])];
}

beforeEach(() => {
  useResolvedAssistantsStore.setState({ activeAssistantId: "asst-1" });
  useUnseenDocumentChangesStore.setState({ changedDocuments: {} });
  useViewerStore.getState().reset();
  mockIsMobile = false;
  assistantVersionKnown = true;
  composerPanelProps = null;
  viewerProps = null;
  conversationsPostMock.mockClear();
  whenAssistantVersionKnownForMock.mockClear();
  toastErrorMock.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("DocumentViewerPage", () => {
  test("does not submit feedback while the assistant version is unknown", async () => {
    assistantVersionKnown = false;
    documentResult = () => Promise.resolve({ data: documentSurface() });

    const { findByTestId } = renderPage("surf-1");
    await findByTestId("viewer");

    const submitFeedback = viewerProps?.onSubmitFeedback;
    expect(typeof submitFeedback).toBe("function");
    await act(async () => {
      await (submitFeedback as () => Promise<void>)();
    });

    expect(whenAssistantVersionKnownForMock).toHaveBeenCalledWith("asst-1");
    expect(conversationsPostMock).not.toHaveBeenCalled();
    expect(useViewerStore.getState().openedDocumentState).toBeNull();
    expect(toastErrorMock).toHaveBeenCalledTimes(1);
  });

  test("abandons feedback after the assistant switches away and back", async () => {
    documentResult = () => Promise.resolve({ data: documentSurface() });
    let resolveVersion: () => void = () => {};
    whenAssistantVersionKnownForMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveVersion = resolve;
        }),
    );

    const { findByTestId } = renderPage("surf-1");
    await findByTestId("viewer");
    const submitFeedback = viewerProps?.onSubmitFeedback;
    expect(typeof submitFeedback).toBe("function");

    let submitted: Promise<void> = Promise.resolve();
    await act(async () => {
      submitted = (submitFeedback as () => Promise<void>)();
    });
    act(() => {
      useResolvedAssistantsStore.setState({ activeAssistantId: "asst-2" });
    });
    await waitFor(() => expect(viewerProps?.assistantId).toBe("asst-2"));
    act(() => {
      useResolvedAssistantsStore.setState({ activeAssistantId: "asst-1" });
    });
    await waitFor(() => expect(viewerProps?.assistantId).toBe("asst-1"));

    await act(async () => {
      resolveVersion();
      await submitted;
    });

    expect(useViewerStore.getState().openedDocumentState).toBeNull();
  });

  test("a stale feedback attempt cannot unlock a newer attempt for the same document", async () => {
    documentResult = () => Promise.resolve({ data: documentSurface() });
    let resolveFirstVersion: () => void = () => {};
    let resolveSecondVersion: () => void = () => {};
    let resolveThirdVersion: () => void = () => {};
    whenAssistantVersionKnownForMock
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveFirstVersion = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveSecondVersion = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveThirdVersion = resolve;
          }),
      );

    const { findByTestId } = renderPage("surf-1");
    await findByTestId("viewer");
    let firstAttempt: Promise<void> = Promise.resolve();
    await act(async () => {
      firstAttempt = (viewerProps?.onSubmitFeedback as () => Promise<void>)();
    });

    act(() => {
      useResolvedAssistantsStore.setState({ activeAssistantId: "asst-2" });
    });
    await waitFor(() => expect(viewerProps?.assistantId).toBe("asst-2"));
    let secondAttempt: Promise<void> = Promise.resolve();
    await act(async () => {
      secondAttempt = (viewerProps?.onSubmitFeedback as () => Promise<void>)();
    });

    act(() => {
      useResolvedAssistantsStore.setState({ activeAssistantId: "asst-1" });
    });
    await waitFor(() => expect(viewerProps?.assistantId).toBe("asst-1"));
    const currentSubmit = viewerProps?.onSubmitFeedback as () => Promise<void>;
    let thirdAttempt: Promise<void> = Promise.resolve();
    await act(async () => {
      thirdAttempt = currentSubmit();
    });

    await act(async () => {
      resolveFirstVersion();
      await firstAttempt;
    });
    await act(async () => {
      await currentSubmit();
    });

    expect(whenAssistantVersionKnownForMock).toHaveBeenCalledTimes(3);

    assistantVersionKnown = false;
    await act(async () => {
      resolveSecondVersion();
      resolveThirdVersion();
      await Promise.all([secondAttempt, thirdAttempt]);
    });
  });

  test("clears the unseen change for the document it loaded", async () => {
    useUnseenDocumentChangesStore
      .getState()
      .markDocumentChanged("conv-1", "surf-1");
    documentResult = () => Promise.resolve({ data: documentSurface() });

    const { findByTestId } = renderPage("surf-1");
    await findByTestId("viewer");

    expect(unseenFor("conv-1")).toEqual([]);
  });

  test("leaves the conversation's other unseen documents alone", async () => {
    const unseen = useUnseenDocumentChangesStore.getState();
    unseen.markDocumentChanged("conv-1", "surf-1");
    unseen.markDocumentChanged("conv-1", "surf-2");
    documentResult = () => Promise.resolve({ data: documentSurface() });

    const { findByTestId } = renderPage("surf-1");
    await findByTestId("viewer");

    expect(unseenFor("conv-1")).toEqual(["surf-2"]);
  });

  test("clears a change recorded against a conversation other than the document's", async () => {
    useUnseenDocumentChangesStore
      .getState()
      .markDocumentChanged("conv-2", "surf-1");
    documentResult = () =>
      Promise.resolve({ data: documentSurface({ conversationId: "conv-1" }) });

    const { findByTestId } = renderPage("surf-1");
    await findByTestId("viewer");

    expect(unseenFor("conv-2")).toEqual([]);
  });

  test("keeps the unseen change when the load fails", async () => {
    useUnseenDocumentChangesStore
      .getState()
      .markDocumentChanged("conv-1", "surf-1");
    documentResult = () => Promise.reject(new Error("boom"));

    renderPage("surf-1");
    await waitFor(() => {
      expect(unseenFor("conv-1")).toEqual(["surf-1"]);
    });
  });
});

describe("DocumentViewerPage: mobile composer", () => {
  test("renders no document composer on desktop", async () => {
    mockIsMobile = false;
    documentResult = () => Promise.resolve({ data: documentSurface() });

    const { findByTestId, queryByTestId } = renderPage("surf-1");
    await findByTestId("viewer");

    expect(queryByTestId("doc-composer-panel")).toBeNull();
  });

  test("pins a document composer below the viewer on mobile", async () => {
    mockIsMobile = true;
    documentResult = () => Promise.resolve({ data: documentSurface() });

    const { findByTestId } = renderPage("surf-1");
    await findByTestId("viewer");
    await findByTestId("doc-composer-panel");

    expect(composerPanelProps?.assistantId).toBe("asst-1");
    expect(composerPanelProps?.doc).toEqual({
      surfaceId: "surf-1",
      conversationId: "conv-1",
    });
  });

  test("flushes the mobile viewer before the composer submits", async () => {
    mockIsMobile = true;
    documentResult = () => Promise.resolve({ data: documentSurface() });
    const flushPendingSave = mock(async () => {});

    const { findByTestId } = renderPage("surf-1");
    await findByTestId("viewer");
    await findByTestId("doc-composer-panel");

    const handleRef = viewerProps?.handleRef as {
      current: Record<string, unknown> | null;
    };
    handleRef.current = {
      refreshComments: async () => {},
      flushPendingSave,
    };
    await (composerPanelProps?.beforeSubmit as () => Promise<void>)();

    expect(flushPendingSave).toHaveBeenCalledTimes(1);
  });
});

describe("DocumentViewerPage: the document the page renders", () => {
  test("holds the loading state while the loaded document is not the route's", async () => {
    // GIVEN a fetch that answers with a document the route does not name.
    mockIsMobile = true;
    let loads = 0;
    documentResult = () => {
      loads += 1;
      return Promise.resolve({
        data: documentSurface({ surfaceId: "surf-2" }),
      });
    };

    // WHEN the page renders that route and the answer settles.
    const { queryByTestId } = renderPage("surf-1");
    await waitFor(() => {
      expect(loads).toBe(1);
    });
    await act(async () => {});

    // THEN neither the viewer nor the composer reaches the screen.
    expect(queryByTestId("document-loading")).not.toBeNull();
    expect(queryByTestId("viewer")).toBeNull();
    expect(queryByTestId("doc-composer-panel")).toBeNull();
  });

  test("withholds the page while the active assistant moves ahead of the load", async () => {
    // GIVEN a document loaded under the assistant that was active.
    mockIsMobile = true;
    documentResult = () => Promise.resolve({ data: documentSurface() });

    const { findByTestId, queryByTestId } = renderPage("surf-1");
    await findByTestId("viewer");

    // WHEN another assistant becomes active and its fetch is still in flight.
    let resolveReload: (result: DocumentResult) => void = () => {};
    documentResult = () =>
      new Promise<DocumentResult>((resolve) => {
        resolveReload = resolve;
      });
    act(() => {
      useResolvedAssistantsStore.setState({ activeAssistantId: "asst-2" });
    });

    // THEN the loading state stands in for the document the switch left behind.
    await findByTestId("document-loading");
    expect(queryByTestId("viewer")).toBeNull();
    expect(queryByTestId("doc-composer-panel")).toBeNull();

    // AND the new assistant's document renders once its fetch resolves.
    await act(async () => {
      resolveReload({ data: documentSurface({ conversationId: "conv-2" }) });
    });
    await findByTestId("viewer");
    await findByTestId("doc-composer-panel");

    expect(composerPanelProps?.assistantId).toBe("asst-2");
    expect(composerPanelProps?.doc).toEqual({
      surfaceId: "surf-1",
      conversationId: "conv-2",
    });
  });

  test("withholds the page while the route moves ahead of the load", async () => {
    // GIVEN a document loaded for the surface the route named.
    mockIsMobile = true;
    documentResult = () => Promise.resolve({ data: documentSurface() });

    const { findByTestId, getByTestId, queryByTestId } = renderPage(
      "surf-1",
      "/assistant/documents/surf-2",
    );
    await findByTestId("viewer");

    // WHEN the route names another document and its fetch is still in flight.
    let resolveReload: (result: DocumentResult) => void = () => {};
    documentResult = () =>
      new Promise<DocumentResult>((resolve) => {
        resolveReload = resolve;
      });
    fireEvent.click(getByTestId("go"));

    // THEN the loading state stands in for the document the route left behind.
    await findByTestId("document-loading");
    expect(queryByTestId("viewer")).toBeNull();
    expect(queryByTestId("doc-composer-panel")).toBeNull();

    // AND the document the route names renders once its fetch resolves.
    await act(async () => {
      resolveReload({
        data: documentSurface({
          surfaceId: "surf-2",
          conversationId: "conv-2",
        }),
      });
    });
    await findByTestId("viewer");
    await findByTestId("doc-composer-panel");

    expect(composerPanelProps?.doc).toEqual({
      surfaceId: "surf-2",
      conversationId: "conv-2",
    });
  });

  test("shows the error state when the refetch fails, not the loaded document", async () => {
    // GIVEN a document already on screen.
    mockIsMobile = true;
    documentResult = () => Promise.resolve({ data: documentSurface() });

    const { findByTestId, findByText, queryByTestId } = renderPage("surf-1");
    await findByTestId("viewer");

    // WHEN another assistant becomes active and its fetch fails.
    documentResult = () => Promise.reject(new Error("boom"));
    act(() => {
      useResolvedAssistantsStore.setState({ activeAssistantId: "asst-2" });
    });

    // THEN the failure replaces the document rather than leaving it up.
    await findByText("Failed to load document.");
    expect(queryByTestId("viewer")).toBeNull();
    expect(queryByTestId("doc-composer-panel")).toBeNull();
  });

  test("drops a previous failure once a later fetch resolves", async () => {
    // GIVEN a first load that failed.
    mockIsMobile = true;
    documentResult = () => Promise.reject(new Error("boom"));

    const { findByTestId, findByText, queryByText } = renderPage("surf-1");
    await findByText("Failed to load document.");

    // WHEN another assistant becomes active and its fetch resolves.
    documentResult = () => Promise.resolve({ data: documentSurface() });
    act(() => {
      useResolvedAssistantsStore.setState({ activeAssistantId: "asst-2" });
    });

    // THEN the document renders with no failure left over it.
    await findByTestId("viewer");
    expect(queryByText("Failed to load document.")).toBeNull();
  });
});
