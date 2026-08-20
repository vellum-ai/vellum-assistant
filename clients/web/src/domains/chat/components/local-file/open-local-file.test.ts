import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { WorkspaceFilePreviewKind } from "@/stores/viewer-store";

const openWorkspaceFile = mock(async (_path: string) => {});
mock.module("@/utils/open-workspace-file", () => ({ openWorkspaceFile }));

const {
  isDocumentOpen,
  isWorkspaceFileOpen,
  openLocalFile,
  previewKindFor,
  toggleLocalFile,
  usesDocumentDrawer,
} = await import("@/domains/chat/components/local-file/open-local-file");
const { useViewerStore } = await import("@/stores/viewer-store");

const openWorkspaceFilePreview = mock(
  (_workspacePath: string, _previewKind: WorkspaceFilePreviewKind) => {},
);
const closeDocument = mock(() => {});

/** The store shape a drawer showing a document surface would have. */
function openDocumentState() {
  return {
    mainView: "document" as const,
    openedDocumentState: {
      source: "document" as const,
      surfaceId: "surf-file",
      conversationId: "conv-1",
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
  openWorkspaceFilePreview.mockClear();
  closeDocument.mockClear();
  useViewerStore.setState({
    mainView: "chat",
    openedDocumentState: null,
    openWorkspaceFilePreview,
    closeDocument,
  });
});

describe("previewKindFor", () => {
  test("delimited text reads through the csv preview", () => {
    expect(previewKindFor("rows.csv")).toBe("csv");
    expect(previewKindFor("ROWS.CSV")).toBe("csv");
    expect(previewKindFor("rows.tsv")).toBe("csv");
  });

  test("markdown reads through its own formatted preview", () => {
    expect(previewKindFor("notes.md")).toBe("markdown");
    expect(previewKindFor("NOTES.MD")).toBe("markdown");
    expect(previewKindFor("readme.markdown")).toBe("markdown");
  });

  test("plain-text formats share one reader", () => {
    expect(previewKindFor("run.log")).toBe("text");
    expect(previewKindFor("notes.txt")).toBe("text");
    expect(previewKindFor("config.json")).toBe("text");
    expect(previewKindFor("deploy.yaml")).toBe("text");
    expect(previewKindFor("deploy.yml")).toBe("text");
    expect(previewKindFor("feed.xml")).toBe("text");
  });

  test("media and pdf read through their own players", () => {
    expect(previewKindFor("report.pdf")).toBe("pdf");
    expect(previewKindFor("shot.png")).toBe("image");
    expect(previewKindFor("shot.JPEG")).toBe("image");
    expect(previewKindFor("logo.svg")).toBe("image");
    expect(previewKindFor("take.mp3")).toBe("audio");
    expect(previewKindFor("take.flac")).toBe("audio");
    expect(previewKindFor("demo.mp4")).toBe("video");
    expect(previewKindFor("demo.mov")).toBe("video");
  });

  test("formats with no reader of their own report none", () => {
    expect(previewKindFor("index.mdx")).toBeNull();
    expect(previewKindFor("report.doc")).toBeNull();
    expect(previewKindFor("report.docx")).toBeNull();
    expect(previewKindFor("deck.pptx")).toBeNull();
    expect(previewKindFor("bundle.zip")).toBeNull();
    expect(previewKindFor("Makefile")).toBeNull();
    expect(previewKindFor(".csv")).toBeNull();
    expect(previewKindFor(".md")).toBeNull();
  });
});

describe("openLocalFile", () => {
  test("a markdown file opens read-only in the drawer", () => {
    openLocalFile("drafts/notes.md", "notes.md", "asst-1");

    expect(openWorkspaceFilePreview).toHaveBeenCalledTimes(1);
    expect(openWorkspaceFilePreview.mock.calls[0]).toEqual([
      "drafts/notes.md",
      "markdown",
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
    expect(openWorkspaceFile).not.toHaveBeenCalled();
  });

  test("every other extension lands in the drawer, in its own reader", () => {
    const cases: [string, WorkspaceFilePreviewKind][] = [
      ["notes.md", "markdown"],
      ["run.txt", "text"],
      ["run.log", "text"],
      ["config.json", "text"],
      ["report.pdf", "pdf"],
      ["shot.png", "image"],
      ["logo.svg", "image"],
      ["take.mp3", "audio"],
      ["demo.mp4", "video"],
    ];

    for (const [filename] of cases) {
      openLocalFile(`files/${filename}`, filename, "asst-1");
    }

    expect(openWorkspaceFilePreview.mock.calls).toEqual(
      cases.map(([filename, previewKind]) => [
        `files/${filename}`,
        previewKind,
      ]),
    );
    expect(openWorkspaceFile).not.toHaveBeenCalled();
  });

  test("a file with no reader still opens, as the unsupported preview", () => {
    openLocalFile("archives/bundle.zip", "bundle.zip", "asst-1");
    openLocalFile("bin/tool", "tool", "asst-1");
    openLocalFile("docs/report.docx", "report.docx", "asst-1");
    openLocalFile("decks/plan.pptx", "plan.pptx", "asst-1");

    expect(openWorkspaceFilePreview.mock.calls).toEqual([
      ["archives/bundle.zip", "unsupported"],
      ["bin/tool", "unsupported"],
      ["docs/report.docx", "unsupported"],
      ["decks/plan.pptx", "unsupported"],
    ]);
    expect(openWorkspaceFile).not.toHaveBeenCalled();
  });

  test("without an assistant, markdown falls back to the workspace browser", () => {
    openLocalFile("drafts/notes.md", "notes.md");

    expect(openWorkspaceFilePreview).not.toHaveBeenCalled();
    expect(openWorkspaceFile).toHaveBeenCalledTimes(1);
    expect(openWorkspaceFile.mock.calls[0]![0]).toBe("drafts/notes.md");
  });

  test("without an assistant, a previewable file does too", () => {
    openLocalFile("data/rows.csv", "rows.csv");

    expect(openWorkspaceFilePreview).not.toHaveBeenCalled();
    expect(openWorkspaceFile).toHaveBeenCalledTimes(1);
    expect(openWorkspaceFile.mock.calls[0]![0]).toBe("data/rows.csv");
  });

  test("without an assistant, a file with no reader does too", () => {
    openLocalFile("archives/bundle.zip", "bundle.zip");

    expect(openWorkspaceFilePreview).not.toHaveBeenCalled();
    expect(openWorkspaceFile).toHaveBeenCalledTimes(1);
    expect(openWorkspaceFile.mock.calls[0]![0]).toBe("archives/bundle.zip");
  });
});

describe("usesDocumentDrawer", () => {
  test("every file type opens the drawer with an assistant", () => {
    for (const filename of [
      "notes.md",
      "rows.csv",
      "report.docx",
      "run.txt",
      "report.pdf",
      "shot.png",
      "demo.mp4",
      "bundle.zip",
      "Makefile",
    ]) {
      expect(usesDocumentDrawer(filename, "asst-1")).toBe(true);
    }
  });

  test("without an assistant every file navigates instead", () => {
    for (const filename of ["notes.md", "rows.csv", "run.txt", "bundle.zip"]) {
      expect(usesDocumentDrawer(filename)).toBe(false);
    }
  });
});

describe("isWorkspaceFileOpen", () => {
  const opened = openPreviewState("drafts/notes.md").openedDocumentState;

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

  test("does not match a document surface, which has no file behind it", () => {
    expect(
      isWorkspaceFileOpen(
        "document",
        openDocumentState().openedDocumentState,
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

describe("isDocumentOpen", () => {
  const drawer = openDocumentState();
  const preview = openPreviewState("data/rows.csv");

  test("matches the document the viewer is showing", () => {
    useViewerStore.setState(drawer);

    expect(
      isDocumentOpen("document", drawer.openedDocumentState, "surf-file"),
    ).toBe(true);
  });

  test("does not match a different document", () => {
    useViewerStore.setState(drawer);

    expect(
      isDocumentOpen("document", drawer.openedDocumentState, "surf-other"),
    ).toBe(false);
  });

  test("does not match while another view is on top", () => {
    const behind = { ...drawer, mainView: "chat" as const };
    useViewerStore.setState(behind);

    expect(
      isDocumentOpen("chat", behind.openedDocumentState, "surf-file"),
    ).toBe(false);
  });

  test("does not match while nothing is loaded", () => {
    useViewerStore.setState({
      mainView: "document",
      openedDocumentState: null,
    });

    expect(isDocumentOpen("document", null, "surf-file")).toBe(false);
  });

  test("does not match a preview, which is not a document surface", () => {
    useViewerStore.setState(preview);

    expect(
      isDocumentOpen("document", preview.openedDocumentState, "surf-file"),
    ).toBe(false);
  });
});

describe("toggleLocalFile", () => {
  test("a closed markdown file opens in the drawer", () => {
    toggleLocalFile("drafts/notes.md", "notes.md", "asst-1");

    expect(openWorkspaceFilePreview.mock.calls[0]).toEqual([
      "drafts/notes.md",
      "markdown",
    ]);
    expect(closeDocument).not.toHaveBeenCalled();
  });

  test("an open markdown preview closes the drawer", () => {
    useViewerStore.setState(openPreviewState("drafts/notes.md"));

    toggleLocalFile("drafts/notes.md", "notes.md", "asst-1");

    expect(closeDocument).toHaveBeenCalledTimes(1);
    expect(openWorkspaceFilePreview).not.toHaveBeenCalled();
    expect(openWorkspaceFile).not.toHaveBeenCalled();
  });

  test("a different open file still opens rather than closing", () => {
    useViewerStore.setState(openPreviewState("drafts/other.md"));

    toggleLocalFile("drafts/notes.md", "notes.md", "asst-1");

    expect(openWorkspaceFilePreview).toHaveBeenCalledTimes(1);
    expect(closeDocument).not.toHaveBeenCalled();
  });

  test("a document surface leaves every path untoggled", () => {
    useViewerStore.setState(openDocumentState());

    toggleLocalFile("drafts/notes.md", "notes.md", "asst-1");

    expect(closeDocument).not.toHaveBeenCalled();
    expect(openWorkspaceFilePreview).toHaveBeenCalledTimes(1);
  });

  test("a navigating file has nothing to toggle", () => {
    useViewerStore.setState(openPreviewState("logs/run.txt"));

    toggleLocalFile("logs/run.txt", "run.txt");

    expect(openWorkspaceFile).toHaveBeenCalledTimes(1);
    expect(closeDocument).not.toHaveBeenCalled();
  });

  test("an open file with no reader closes the drawer like any other", () => {
    useViewerStore.setState({
      mainView: "document",
      openedDocumentState: {
        source: "workspace-file-preview",
        workspacePath: "archives/bundle.zip",
        documentName: "bundle.zip",
        previewKind: "unsupported",
      },
    });

    toggleLocalFile("archives/bundle.zip", "bundle.zip", "asst-1");

    expect(closeDocument).toHaveBeenCalledTimes(1);
    expect(openWorkspaceFilePreview).not.toHaveBeenCalled();
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
