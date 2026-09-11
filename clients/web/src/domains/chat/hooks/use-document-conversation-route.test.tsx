import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";

import type { DocumentContent } from "@/types/document-types";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useViewerStore } from "@/stores/viewer-store";

const documentData: DocumentContent = {
  success: true,
  surfaceId: "surface-1",
  conversationId: "conv-1",
  title: "Notes",
  content: "Body",
  wordCount: 1,
  createdAt: 1,
  updatedAt: 1,
};
const sdk = await import("@/generated/daemon/sdk.gen");
const load = mock(async () => ({ data: documentData }));
mock.module("@/generated/daemon/sdk.gen", () => ({
  ...sdk,
  documentsByIdGet: load,
  conversationsByIdGet: async ({ path }: { path: { id: string } }) => ({
    data: { conversation: { id: path.id } },
    response: new Response(null, { status: 200 }),
  }),
}));
mock.module("@/hooks/use-is-org-ready", () => ({
  useOrgHeaderReadiness: () => "ready",
}));
mock.module("@/lib/sentry/capture-error", () => ({
  captureError: mock(() => {}),
}));
const { useDocumentConversationRoute } = await import(
  "./use-document-conversation-route"
);

function Harness() {
  const session = useDocumentConversationRoute();
  const location = useLocation();
  return (
    <>
      <div data-testid="url">
        {location.pathname}
        {location.search}
      </div>
      <div data-testid="status">
        {session.isLoading ? "loading" : (session.error ?? "ready")}
      </div>
      <button onClick={session.closeDocument}>Close</button>
      <button onClick={session.viewConversation}>View conversation</button>
      <button onClick={session.reopenDocument}>Reopen document</button>
      <button onClick={session.reloadDocument}>Retry</button>
    </>
  );
}

function renderRoute(conversationId = "conv-1") {
  return render(
    <MemoryRouter
      initialEntries={[
        `/assistant/conversations/${conversationId}?document=surface-1&documentReturn=%2Fassistant%2Flibrary`,
      ]}
    >
      <Routes>
        <Route
          path="/assistant/conversations/:conversationId"
          element={<Harness />}
        />
        <Route
          path="/assistant/library"
          element={<div data-testid="library" />}
        />
        <Route
          path="/assistant/documents/:surfaceId"
          element={<div data-testid="entry-adapter" />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

let selection: ReturnType<typeof useResolvedAssistantsStore.getState>;
let viewer: ReturnType<typeof useViewerStore.getState>;
beforeEach(() => {
  selection = useResolvedAssistantsStore.getState();
  viewer = useViewerStore.getState();
  useResolvedAssistantsStore.setState({ activeAssistantId: "assistant-1" });
  useViewerStore.setState({
    mainView: "chat",
    openedDocumentState: null,
    activeDocumentTarget: null,
  });
  load.mockReset();
  load.mockImplementation(async () => ({ data: documentData }));
});
afterEach(() => {
  cleanup();
  useResolvedAssistantsStore.setState(selection, true);
  useViewerStore.setState(viewer, true);
});

describe("document conversation route", () => {
  test("refresh loads the document into the current linked session", async () => {
    const page = renderRoute();
    await waitFor(() =>
      expect(page.getByTestId("status").textContent).toBe("ready"),
    );
    expect(useViewerStore.getState().openedDocumentState).toMatchObject({
      assistantId: "assistant-1",
      surfaceId: "surface-1",
      conversationId: "conv-1",
    });
    expect(useViewerStore.getState().mainView).toBe("document");
  });

  test("transcript and document presentation switches do not reload the editor", async () => {
    const page = renderRoute();
    await waitFor(() =>
      expect(page.getByTestId("status").textContent).toBe("ready"),
    );
    const opened = useViewerStore.getState().openedDocumentState;
    fireEvent.click(page.getByText("View conversation"));
    expect(page.getByTestId("url").textContent).toContain("documentView=chat");
    expect(useViewerStore.getState().mainView).toBe("chat");
    fireEvent.click(page.getByText("Reopen document"));
    expect(useViewerStore.getState().mainView).toBe("document");
    expect(useViewerStore.getState().openedDocumentState).toBe(opened);
    expect(load).toHaveBeenCalledTimes(1);
  });

  test("closing during refresh cannot reopen the document when the request settles", async () => {
    let resolveLoad!: (value: { data: DocumentContent }) => void;
    load.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLoad = resolve;
        }),
    );
    const page = renderRoute();
    fireEvent.click(page.getByText("Close"));
    await page.findByTestId("library");
    await act(async () => resolveLoad({ data: documentData }));
    expect(useViewerStore.getState().openedDocumentState).toBeNull();
    expect(page.queryByTestId("url")).toBeNull();
  });

  test("a document URL for a different conversation goes through the entry adapter", async () => {
    const page = renderRoute("conv-other");
    await page.findByTestId("entry-adapter");
    expect(useViewerStore.getState().openedDocumentState).toBeNull();
  });

  test("a failed load is retryable in the same session", async () => {
    load.mockImplementationOnce(async () => {
      throw new Error("offline");
    });
    const page = renderRoute();
    await waitFor(() =>
      expect(page.getByTestId("status").textContent).toContain(
        "Unable to open",
      ),
    );
    fireEvent.click(page.getByText("Retry"));
    await waitFor(() =>
      expect(page.getByTestId("status").textContent).toBe("ready"),
    );
    expect(load).toHaveBeenCalledTimes(2);
  });
});
