/**
 * The standalone `/assistant/documents/:surfaceId` route is a second way into
 * a document, so opening one there clears its unseen-change record just as the
 * in-chat viewer does. It also hosts the mobile document composer outside the
 * fixed, keyboard-tracking overlay shell, so it owns the composer's bottom
 * safe-area inset itself.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";

import type { DocumentsByIdGetResponse } from "@/generated/daemon/types.gen";
import type { VisibleViewport } from "@/hooks/use-visible-viewport";
import { useUnseenDocumentChangesStore } from "@/domains/chat/unseen-document-changes-store";

const daemonSdk = await import("@/generated/daemon/sdk.gen");

type DocumentResult = { data: DocumentsByIdGetResponse | null };

let documentResult: () => Promise<DocumentResult> = () =>
  Promise.reject(new Error("not stubbed"));

mock.module("@/generated/daemon/sdk.gen", () => ({
  ...daemonSdk,
  documentsByIdGet: () => documentResult(),
}));

mock.module("@/stores/resolved-assistants-store", () => ({
  useResolvedAssistantsStore: { use: { activeAssistantId: () => "asst-1" } },
}));

// The editor is a heavy Tiptap tree with nothing to say about the record.
mock.module("./components/document-viewer-container", () => ({
  DocumentViewerContainer: () => <div data-testid="viewer" />,
}));

let mockIsMobile = false;
mock.module("@/hooks/use-is-mobile", () => ({
  useIsMobile: () => mockIsMobile,
}));

// The composer's bottom inset is keyboard-aware, so the viewport it reads is
// driven explicitly here. Spread the real module to keep the threshold
// constant `useKeyboardOpen` compares against.
const visibleViewportModule = await import("@/hooks/use-visible-viewport");
let mockVisibleViewport: VisibleViewport | null = null;
mock.module(
  "@/hooks/use-visible-viewport",
  (): typeof visibleViewportModule => ({
    ...visibleViewportModule,
    useVisibleViewport: () => mockVisibleViewport,
  }),
);

let composerPanelProps: Record<string, unknown> | null = null;
mock.module("@/domains/chat/components/document-composer-panel", () => ({
  DocumentComposerPanel: (props: Record<string, unknown>) => {
    composerPanelProps = props;
    return <div data-testid="doc-composer-panel" />;
  },
}));

const { useOverlaySafeAreaBottomInset } = await import(
  "@/hooks/use-mobile-overlay-viewport-style"
);
const { DocumentViewerPage } = await import(
  "@/domains/chat/document-viewer-page"
);

/** The inset the shared hook resolves to under the current mocked viewport. */
function expectedBottomInset(): string {
  let captured = "";
  function Probe() {
    captured = useOverlaySafeAreaBottomInset();
    return null;
  }
  const { unmount } = render(<Probe />);
  unmount();
  return captured;
}

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

function renderPage(surfaceId: string) {
  return render(
    <MemoryRouter initialEntries={[`/assistant/documents/${surfaceId}`]}>
      <Routes>
        <Route
          path="/assistant/documents/:surfaceId"
          element={<DocumentViewerPage />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

function unseenFor(conversationId: string): string[] {
  const changed =
    useUnseenDocumentChangesStore.getState().changedDocuments[conversationId];
  return [...(changed ?? [])];
}

beforeEach(() => {
  useUnseenDocumentChangesStore.setState({ changedDocuments: {} });
  mockIsMobile = false;
  mockVisibleViewport = null;
  composerPanelProps = null;
});

afterEach(() => {
  cleanup();
});

describe("DocumentViewerPage", () => {
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

  test("pads the composer with the shared safe-area inset while the keyboard is closed", async () => {
    // This route lays out in normal flow, so it has no
    // `--overlay-safe-area-bottom` ancestor to read and computes the same
    // value `useMobileOverlayViewportStyle` would have published.
    mockIsMobile = true;
    mockVisibleViewport = {
      height: 800,
      keyboardHeight: 0,
      offsetTop: 0,
      offsetLeft: 0,
    };
    documentResult = () => Promise.resolve({ data: documentSurface() });

    const { findByTestId } = renderPage("surf-1");
    await findByTestId("doc-composer-panel");

    expect(composerPanelProps?.bottomInset).toBe(expectedBottomInset());
    expect(composerPanelProps?.bottomInset).toContain("safe-area-inset-bottom");
  });

  test("drops the composer's bottom inset to zero while the keyboard is open", async () => {
    mockIsMobile = true;
    mockVisibleViewport = {
      height: 500,
      keyboardHeight: 300,
      offsetTop: 40,
      offsetLeft: 0,
    };
    documentResult = () => Promise.resolve({ data: documentSurface() });

    const { findByTestId } = renderPage("surf-1");
    await findByTestId("doc-composer-panel");

    // A fixed safe-area literal would leave dead space above the keyboard.
    expect(composerPanelProps?.bottomInset).toBe(expectedBottomInset());
    expect(composerPanelProps?.bottomInset).toBe("0px");
  });
});
