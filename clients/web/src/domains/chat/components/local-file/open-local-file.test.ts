import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { WorkspaceFilePreviewKind } from "@/stores/viewer-store";

const openWorkspaceFile = mock(async (_path: string) => {});
mock.module("@/utils/open-workspace-file", () => ({ openWorkspaceFile }));

const {
  isWorkspaceFileOpen,
  openLocalFile,
  opensInDocumentDrawer,
  previewKindFor,
  toggleLocalFile,
  usesDocumentDrawer,
} = await import("@/domains/chat/components/local-file/open-local-file");
const { useViewerStore } = await import("@/stores/viewer-store");

const loadWorkspaceFileDocument = mock(
  async (_assistantId: string, _workspacePath: string) => {},
);
const openWorkspaceFilePreview = mock(
  (_workspacePath: string, _previewKind: WorkspaceFilePreviewKind) => {},
);
const closeDocument = mock(() => {});

/** The store shape a drawer showing `workspacePath` would have. */
function openDrawerState(workspacePath: string) {
  return {
    mainView: "document" as const,
    openedDocumentState: {
      source: "workspace-file" as const,
      workspacePath,
      documentName: "notes.md",
      content: "# notes",
    },
  };
}

/** The store shape a drawer previewing `workspacePath` would have. */
function openPreviewState(workspacePath: string) {
  return {
    mainView: "document" as const,
    openedDocumentState: {
      source: "workspace-file-preview" as const,
      workspacePath,
      documentName: "rows.csv",
      previewKind: "csv" as const,
    },
  };
}

beforeEach(() => {
  openWorkspaceFile.mockClear();
  loadWorkspaceFileDocument.mockClear();
  openWorkspaceFilePreview.mockClear();
  closeDocument.mockClear();
  useViewerStore.setState({
    mainView: "chat",
    openedDocumentState: null,
    loadWorkspaceFileDocument,
    openWorkspaceFilePreview,
    closeDocument,
  });
});

describe("opensInDocumentDrawer", () => {
  test("markdown extensions open in the drawer", () => {
    expect(opensInDocumentDrawer("notes.md")).toBe(true);
    expect(opensInDocumentDrawer("NOTES.MD")).toBe(true);
    expect(opensInDocumentDrawer("readme.markdown")).toBe(true);
  });

  test("other text formats do not, since the editor would rewrite them", () => {
    expect(opensInDocumentDrawer("data.csv")).toBe(false);
    expect(opensInDocumentDrawer("notes.txt")).toBe(false);
    expect(opensInDocumentDrawer("index.mdx")).toBe(false);
    expect(opensInDocumentDrawer("Makefile")).toBe(false);
    expect(opensInDocumentDrawer(".md")).toBe(false);
  });
});

describe("previewKindFor", () => {
  test("delimited text reads through the csv preview", () => {
    expect(previewKindFor("rows.csv")).toBe("csv");
    expect(previewKindFor("ROWS.CSV")).toBe("csv");
    expect(previewKindFor("rows.tsv")).toBe("csv");
  });

  test("the office packages read through their own previews", () => {
    expect(previewKindFor("report.docx")).toBe("docx");
    expect(previewKindFor("deck.pptx")).toBe("pptx");
  });

  test("everything else has no preview", () => {
    expect(previewKindFor("notes.md")).toBeNull();
    expect(previewKindFor("notes.txt")).toBeNull();
    expect(previewKindFor("report.doc")).toBeNull();
    expect(previewKindFor("Makefile")).toBeNull();
    expect(previewKindFor(".csv")).toBeNull();
  });
});

describe("openLocalFile", () => {
  test("a markdown file opens in the document drawer", () => {
    openLocalFile("drafts/notes.md", "notes.md", "asst-1");

    expect(loadWorkspaceFileDocument).toHaveBeenCalledTimes(1);
    expect(loadWorkspaceFileDocument.mock.calls[0]).toEqual([
      "asst-1",
      "drafts/notes.md",
    ]);
    expect(openWorkspaceFile).not.toHaveBeenCalled();
  });

  test("a previewable file opens read-only in the same drawer", () => {
    openLocalFile("data/rows.csv", "rows.csv", "asst-1");

    expect(openWorkspaceFilePreview).toHaveBeenCalledTimes(1);
    expect(openWorkspaceFilePreview.mock.calls[0]).toEqual([
      "data/rows.csv",
      "csv",
    ]);
    expect(loadWorkspaceFileDocument).not.toHaveBeenCalled();
    expect(openWorkspaceFile).not.toHaveBeenCalled();
  });

  test("each previewable format carries its own reader", () => {
    openLocalFile("docs/report.docx", "report.docx", "asst-1");
    openLocalFile("decks/plan.pptx", "plan.pptx", "asst-1");

    expect(openWorkspaceFilePreview.mock.calls).toEqual([
      ["docs/report.docx", "docx"],
      ["decks/plan.pptx", "pptx"],
    ]);
  });

  test("any other file opens in the workspace browser", () => {
    openLocalFile("logs/run.txt", "run.txt", "asst-1");

    expect(loadWorkspaceFileDocument).not.toHaveBeenCalled();
    expect(openWorkspaceFilePreview).not.toHaveBeenCalled();
    expect(openWorkspaceFile).toHaveBeenCalledTimes(1);
    expect(openWorkspaceFile.mock.calls[0]![0]).toBe("logs/run.txt");
  });

  test("without an assistant, markdown falls back to the workspace browser", () => {
    openLocalFile("drafts/notes.md", "notes.md");

    expect(loadWorkspaceFileDocument).not.toHaveBeenCalled();
    expect(openWorkspaceFile).toHaveBeenCalledTimes(1);
    expect(openWorkspaceFile.mock.calls[0]![0]).toBe("drafts/notes.md");
  });

  test("without an assistant, a previewable file does too", () => {
    openLocalFile("data/rows.csv", "rows.csv");

    expect(openWorkspaceFilePreview).not.toHaveBeenCalled();
    expect(openWorkspaceFile).toHaveBeenCalledTimes(1);
    expect(openWorkspaceFile.mock.calls[0]![0]).toBe("data/rows.csv");
  });
});

describe("usesDocumentDrawer", () => {
  test("markdown with an assistant opens the drawer", () => {
    expect(usesDocumentDrawer("notes.md", "asst-1")).toBe(true);
  });

  test("markdown without an assistant navigates instead", () => {
    expect(usesDocumentDrawer("notes.md")).toBe(false);
  });

  test("a previewable file with an assistant opens the drawer too", () => {
    expect(usesDocumentDrawer("rows.csv", "asst-1")).toBe(true);
    expect(usesDocumentDrawer("report.docx", "asst-1")).toBe(true);
  });

  test("other formats navigate whatever the assistant", () => {
    expect(usesDocumentDrawer("run.txt", "asst-1")).toBe(false);
    expect(usesDocumentDrawer("rows.csv")).toBe(false);
  });
});

describe("isWorkspaceFileOpen", () => {
  const opened = openDrawerState("drafts/notes.md").openedDocumentState;

  test("matches the file the drawer is showing", () => {
    expect(isWorkspaceFileOpen("document", opened, "drafts/notes.md")).toBe(
      true,
    );
  });

  test("does not match a different file", () => {
    expect(isWorkspaceFileOpen("document", opened, "drafts/other.md")).toBe(
      false,
    );
  });

  test("does not match while another view is on top", () => {
    expect(isWorkspaceFileOpen("chat", opened, "drafts/notes.md")).toBe(false);
  });

  test("does not match a db-backed document", () => {
    expect(
      isWorkspaceFileOpen(
        "document",
        {
          source: "document",
          surfaceId: "surface-1",
          conversationId: "conv-1",
          documentName: "notes.md",
          content: "",
        },
        "drafts/notes.md",
      ),
    ).toBe(false);
  });

  test("does not match while nothing is loaded", () => {
    expect(isWorkspaceFileOpen("document", null, "drafts/notes.md")).toBe(
      false,
    );
  });

  test("a previewed file counts as open", () => {
    expect(
      isWorkspaceFileOpen(
        "document",
        openPreviewState("data/rows.csv").openedDocumentState,
        "data/rows.csv",
      ),
    ).toBe(true);
  });
});

describe("toggleLocalFile", () => {
  test("a closed markdown file opens in the document drawer", () => {
    toggleLocalFile("drafts/notes.md", "notes.md", "asst-1");

    expect(loadWorkspaceFileDocument).toHaveBeenCalledTimes(1);
    expect(closeDocument).not.toHaveBeenCalled();
  });

  test("an open markdown file closes the drawer", () => {
    useViewerStore.setState(openDrawerState("drafts/notes.md"));

    toggleLocalFile("drafts/notes.md", "notes.md", "asst-1");

    expect(closeDocument).toHaveBeenCalledTimes(1);
    expect(loadWorkspaceFileDocument).not.toHaveBeenCalled();
    expect(openWorkspaceFile).not.toHaveBeenCalled();
  });

  test("a different open file still opens rather than closing", () => {
    useViewerStore.setState(openDrawerState("drafts/other.md"));

    toggleLocalFile("drafts/notes.md", "notes.md", "asst-1");

    expect(loadWorkspaceFileDocument).toHaveBeenCalledTimes(1);
    expect(closeDocument).not.toHaveBeenCalled();
  });

  test("a navigating file has nothing to toggle", () => {
    useViewerStore.setState(openDrawerState("logs/run.txt"));

    toggleLocalFile("logs/run.txt", "run.txt", "asst-1");

    expect(openWorkspaceFile).toHaveBeenCalledTimes(1);
    expect(closeDocument).not.toHaveBeenCalled();
  });

  test("a closed previewable file opens the preview", () => {
    toggleLocalFile("data/rows.csv", "rows.csv", "asst-1");

    expect(openWorkspaceFilePreview).toHaveBeenCalledTimes(1);
    expect(closeDocument).not.toHaveBeenCalled();
  });

  test("an open preview closes the drawer", () => {
    useViewerStore.setState(openPreviewState("data/rows.csv"));

    toggleLocalFile("data/rows.csv", "rows.csv", "asst-1");

    expect(closeDocument).toHaveBeenCalledTimes(1);
    expect(openWorkspaceFilePreview).not.toHaveBeenCalled();
    expect(openWorkspaceFile).not.toHaveBeenCalled();
  });

  test("a different open preview still opens rather than closing", () => {
    useViewerStore.setState(openPreviewState("data/other.csv"));

    toggleLocalFile("data/rows.csv", "rows.csv", "asst-1");

    expect(openWorkspaceFilePreview).toHaveBeenCalledTimes(1);
    expect(closeDocument).not.toHaveBeenCalled();
  });
});
