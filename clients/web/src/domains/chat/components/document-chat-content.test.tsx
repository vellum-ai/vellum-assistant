import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "@vellumai/design-library/components/toast";
import { createRef } from "react";

import type * as ErrorCapture from "@/lib/sentry/capture-error";
import type { OpenedDocumentState } from "@/stores/viewer-store";

import type * as Surfaces from "../api/surfaces";
import type * as DocumentComments from "../api/document-comments";
import type { DocumentViewerContainerHandle } from "./document-viewer-container";
import type * as DocumentCommentPanel from "./document-comment-panel";
import type * as TiptapDocumentEditor from "./tiptap-document-editor";

const downloadDocumentPdf = mock(
  async (
    _assistantId: string,
    _surfaceId: string,
    _title: string | null | undefined,
  ) => {},
);
const captureError = mock(() => {});
const documentComments = await import("../api/document-comments");
mock.module(
  "../api/surfaces",
  (): Partial<typeof Surfaces> => ({
    downloadDocumentPdf,
  }),
);
mock.module(
  "../api/document-comments",
  (): Partial<typeof DocumentComments> => ({
    ...documentComments,
    fetchComments: async () => [],
  }),
);
mock.module(
  "@/lib/sentry/capture-error",
  (): Partial<typeof ErrorCapture> => ({
    captureError,
  }),
);
mock.module(
  "./document-comment-panel",
  (): Partial<typeof DocumentCommentPanel> => ({
    DocumentCommentPanel: () => <div />,
  }),
);
mock.module(
  "./tiptap-document-editor",
  (): Partial<typeof TiptapDocumentEditor> => ({
    TiptapDocumentEditor: () => <div data-testid="editor" />,
  }),
);

const { DocumentChatContent } = await import("./document-chat-content");

const openedDocument: OpenedDocumentState = {
  source: "document",
  assistantId: "assistant-1",
  surfaceId: "surface-1",
  conversationId: "conv-1",
  documentName: "Notes",
  content: "# Notes",
};

function renderDocument() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const editorRef = createRef<DocumentViewerContainerHandle>();
  const view = (document: OpenedDocumentState) => (
    <QueryClientProvider client={queryClient}>
      <DocumentChatContent
        assistantId="assistant-1"
        surfaceId="surface-1"
        document={document}
        loading={false}
        error={null}
        editorRef={editorRef}
        onClose={() => {}}
        onRetry={() => {}}
        onSubmitFeedback={() => {}}
      />
    </QueryClientProvider>
  );
  const page = render(view(openedDocument));
  return {
    rename: (documentName: string) =>
      page.rerender(view({ ...openedDocument, documentName })),
  };
}

async function exportFromMenu() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Document options" }));
  await user.click(await screen.findByRole("menuitem", { name: "Export" }));
}

beforeEach(() => {
  downloadDocumentPdf.mockReset();
  downloadDocumentPdf.mockImplementation(async () => {});
  captureError.mockClear();
});

afterEach(() => {
  cleanup();
  mock.restore();
  document.body.style.pointerEvents = "";
});

describe("DocumentChatContent PDF export", () => {
  test("the editor menu exports the active document with its current name", async () => {
    const page = renderDocument();
    await exportFromMenu();
    expect(downloadDocumentPdf).toHaveBeenLastCalledWith(
      "assistant-1",
      "surface-1",
      "Notes",
    );

    page.rename("Updated notes");
    await exportFromMenu();
    expect(downloadDocumentPdf).toHaveBeenLastCalledWith(
      "assistant-1",
      "surface-1",
      "Updated notes",
    );
  });

  test("export failure is reported without dismissing the document", async () => {
    const error = new Error("Export unavailable");
    downloadDocumentPdf.mockRejectedValueOnce(error);
    const errorToast = spyOn(toast, "error").mockReturnValue("export-error");
    renderDocument();
    await exportFromMenu();
    await waitFor(() =>
      expect(errorToast).toHaveBeenCalledWith("Failed to export PDF"),
    );
    expect(captureError).toHaveBeenCalledWith(error, {
      context: "document_export",
    });
    expect(
      screen.getByRole("button", { name: "Document options" }),
    ).toBeTruthy();
  });
});
