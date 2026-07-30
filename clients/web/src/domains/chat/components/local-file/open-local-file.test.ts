import { beforeEach, describe, expect, mock, test } from "bun:test";

const openWorkspaceFile = mock(async (_path: string) => {});
mock.module("@/utils/open-workspace-file", () => ({ openWorkspaceFile }));

const { openLocalFile, opensInDocumentDrawer } = await import(
  "@/domains/chat/components/local-file/open-local-file"
);
const { useViewerStore } = await import("@/stores/viewer-store");

const loadWorkspaceFileDocument = mock(
  async (_assistantId: string, _workspacePath: string) => {},
);

beforeEach(() => {
  openWorkspaceFile.mockClear();
  loadWorkspaceFileDocument.mockClear();
  useViewerStore.setState({ loadWorkspaceFileDocument });
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

  test("any other file opens in the workspace browser", () => {
    openLocalFile("data/rows.csv", "rows.csv", "asst-1");

    expect(loadWorkspaceFileDocument).not.toHaveBeenCalled();
    expect(openWorkspaceFile).toHaveBeenCalledTimes(1);
    expect(openWorkspaceFile.mock.calls[0]![0]).toBe("data/rows.csv");
  });

  test("without an assistant, markdown falls back to the workspace browser", () => {
    openLocalFile("drafts/notes.md", "notes.md");

    expect(loadWorkspaceFileDocument).not.toHaveBeenCalled();
    expect(openWorkspaceFile).toHaveBeenCalledTimes(1);
    expect(openWorkspaceFile.mock.calls[0]![0]).toBe("drafts/notes.md");
  });
});
