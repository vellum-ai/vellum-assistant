import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { WorkspaceFilePreviewKind } from "@/stores/viewer-store";

const openWorkspaceFile = mock(async (_path: string) => {});

mock.module("@/utils/open-workspace-file", () => ({ openWorkspaceFile }));

const { LocalFileCard } = await import(
  "@/domains/chat/components/local-file/local-file-card"
);
const { useViewerStore } = await import("@/stores/viewer-store");
const { useConversationStore } = await import("@/stores/conversation-store");

const loadWorkspaceFileDocument = mock(
  async (
    _assistantId: string,
    _workspacePath: string,
    _conversationId: string,
  ) => {},
);
const openWorkspaceFilePreview = mock(
  (_workspacePath: string, _previewKind: WorkspaceFilePreviewKind) => {},
);
const closeDocument = mock(() => {});

/** Put the viewer store where it would be with `workspacePath` in the drawer. */
function openDrawerWith(workspacePath: string) {
  useViewerStore.setState({
    mainView: "document",
    openedDocumentState: {
      source: "document",
      surfaceId: "surf-file",
      conversationId: "conv-1",
      workspacePath,
      documentName: "notes.md",
      content: "# notes",
    },
  });
}

/** Put the viewer store where it would be previewing `workspacePath`. */
function openPreviewWith(workspacePath: string) {
  useViewerStore.setState({
    mainView: "document",
    openedDocumentState: {
      source: "workspace-file-preview",
      workspacePath,
      documentName: "rows.csv",
      previewKind: "csv",
    },
  });
}

beforeEach(() => {
  openWorkspaceFile.mockClear();
  loadWorkspaceFileDocument.mockClear();
  openWorkspaceFilePreview.mockClear();
  closeDocument.mockClear();
  // Markdown opens as a document bound to the open conversation, so the card
  // needs one to reach the drawer at all.
  useConversationStore.setState({ activeConversationId: "conv-1" });
  useViewerStore.setState({
    mainView: "chat",
    openedDocumentState: null,
    loadWorkspaceFileDocument,
    openWorkspaceFilePreview,
    closeDocument,
  });
});

afterEach(() => {
  cleanup();
  // Radix locks body pointer events while a menu is open; a test that
  // leaves one open must not disable pointers for the next one.
  document.body.style.pointerEvents = "";
});

describe("LocalFileCard", () => {
  test("a ready file shows its label, size, and file actions", () => {
    render(
      <LocalFileCard
        displayName="notes.md"
        filename="notes.md"
        sizeBytes={2048}
        kind="file"
        state="ready"
        workspacePath="drafts/notes.md"
        assistantId="asst-1"
      />,
    );

    expect(screen.getByText("notes.md")).toBeTruthy();
    expect(screen.getByText("2.0 KB")).toBeTruthy();
    expect(screen.getByRole("button", { name: "File actions" })).toBeTruthy();
  });

  test("a label that differs from the filename adds a secondary line", () => {
    render(
      <LocalFileCard
        displayName="Q3 report"
        filename="q3.pdf"
        sizeBytes={null}
        kind="pdf"
        state="ready"
        workspacePath="reports/q3.pdf"
        assistantId="asst-1"
      />,
    );

    expect(screen.getByText("Q3 report")).toBeTruthy();
    expect(screen.getByText("q3.pdf")).toBeTruthy();
  });

  test("a label equal to the filename is not repeated", () => {
    render(
      <LocalFileCard
        displayName="q3.pdf"
        filename="q3.pdf"
        sizeBytes={null}
        kind="pdf"
        state="ready"
        workspacePath="reports/q3.pdf"
        assistantId="asst-1"
      />,
    );

    expect(screen.getAllByText("q3.pdf").length).toBe(1);
  });

  test("no size is rendered when the size is unknown", () => {
    render(
      <LocalFileCard
        displayName="notes.md"
        filename="notes.md"
        sizeBytes={null}
        kind="file"
        state="ready"
        workspacePath="drafts/notes.md"
      />,
    );

    expect(screen.queryByText(/\d+ (B|KB|MB|GB)/)).toBeNull();
  });

  test("clicking a ready card without an assistant opens the workspace file", () => {
    render(
      <LocalFileCard
        displayName="run.txt"
        filename="run.txt"
        sizeBytes={12}
        kind="file"
        state="ready"
        workspacePath="logs/run.txt"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open run.txt" }));

    expect(openWorkspaceFile).toHaveBeenCalledTimes(1);
    expect(openWorkspaceFile.mock.calls[0]![0]).toBe("logs/run.txt");
    expect(loadWorkspaceFileDocument).not.toHaveBeenCalled();
  });

  test("Enter on a ready card opens it the same way a click does", () => {
    render(
      <LocalFileCard
        displayName="run.txt"
        filename="run.txt"
        sizeBytes={12}
        kind="file"
        state="ready"
        workspacePath="logs/run.txt"
        assistantId="asst-1"
      />,
    );

    fireEvent.keyDown(screen.getByRole("button", { name: "Open run.txt" }), {
      key: "Enter",
    });

    expect(openWorkspaceFilePreview).toHaveBeenCalledTimes(1);
    expect(openWorkspaceFilePreview.mock.calls[0]).toEqual([
      "logs/run.txt",
      "text",
    ]);
  });

  test("clicking a card with no reader opens the unsupported preview", () => {
    render(
      <LocalFileCard
        displayName="bundle.zip"
        filename="bundle.zip"
        sizeBytes={12}
        kind="file"
        state="ready"
        workspacePath="archives/bundle.zip"
        assistantId="asst-1"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open bundle.zip" }));

    expect(openWorkspaceFilePreview).toHaveBeenCalledTimes(1);
    expect(openWorkspaceFilePreview.mock.calls[0]).toEqual([
      "archives/bundle.zip",
      "unsupported",
    ]);
    expect(openWorkspaceFile).not.toHaveBeenCalled();
  });

  test("clicking a markdown card opens it in the document drawer", () => {
    render(
      <LocalFileCard
        displayName="notes.md"
        filename="notes.md"
        sizeBytes={12}
        kind="file"
        state="ready"
        workspacePath="drafts/notes.md"
        assistantId="asst-1"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open notes.md" }));

    expect(loadWorkspaceFileDocument).toHaveBeenCalledTimes(1);
    expect(loadWorkspaceFileDocument.mock.calls[0]).toEqual([
      "asst-1",
      "drafts/notes.md",
      "conv-1",
    ]);
    expect(openWorkspaceFile).not.toHaveBeenCalled();
  });

  test("clicking a previewable card opens it read-only in the drawer", () => {
    render(
      <LocalFileCard
        displayName="rows.csv"
        filename="rows.csv"
        sizeBytes={12}
        kind="file"
        state="ready"
        workspacePath="data/rows.csv"
        assistantId="asst-1"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open rows.csv" }));

    expect(openWorkspaceFilePreview).toHaveBeenCalledTimes(1);
    expect(openWorkspaceFilePreview.mock.calls[0]).toEqual([
      "data/rows.csv",
      "csv",
    ]);
    expect(openWorkspaceFile).not.toHaveBeenCalled();
  });

  test("a markdown card with no open conversation falls back to the workspace", () => {
    useConversationStore.setState({ activeConversationId: null });

    render(
      <LocalFileCard
        displayName="notes.md"
        filename="notes.md"
        sizeBytes={12}
        kind="file"
        state="ready"
        workspacePath="drafts/notes.md"
        assistantId="asst-1"
      />,
    );

    expect(screen.getByText("Open in workspace")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Open notes.md" }));

    expect(loadWorkspaceFileDocument).not.toHaveBeenCalled();
    expect(openWorkspaceFilePreview).not.toHaveBeenCalled();
    expect(openWorkspaceFile).toHaveBeenCalledTimes(1);
  });

  test("a markdown card without an assistant falls back to the workspace", () => {
    render(
      <LocalFileCard
        displayName="notes.md"
        filename="notes.md"
        sizeBytes={12}
        kind="file"
        state="ready"
        workspacePath="drafts/notes.md"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open notes.md" }));

    expect(loadWorkspaceFileDocument).not.toHaveBeenCalled();
    expect(openWorkspaceFile).toHaveBeenCalledTimes(1);
  });

  test("a missing file reports it and is not interactive", () => {
    render(
      <LocalFileCard
        displayName="gone.png"
        filename="gone.png"
        sizeBytes={null}
        kind="image"
        state="missing"
        workspacePath="scratch/gone.png"
        assistantId="asst-1"
      />,
    );

    expect(screen.getByText("File not found")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Open/ })).toBeNull();
  });

  test("an unavailable file reports it and is not interactive", () => {
    render(
      <LocalFileCard
        displayName="secret.png"
        filename="secret.png"
        sizeBytes={null}
        kind="image"
        state="unavailable"
        workspacePath={null}
      />,
    );

    expect(screen.getByText("File isn't available here")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Open/ })).toBeNull();
  });

  test("a ready card without a servable path is not interactive", () => {
    render(
      <LocalFileCard
        displayName="notes.md"
        filename="notes.md"
        sizeBytes={null}
        kind="file"
        state="ready"
        workspacePath={null}
      />,
    );

    expect(screen.queryByRole("button", { name: /^Open/ })).toBeNull();
  });
});

describe("LocalFileCard click hint", () => {
  test("a markdown card says the click opens the editor", () => {
    render(
      <LocalFileCard
        displayName="notes.md"
        filename="notes.md"
        sizeBytes={null}
        kind="file"
        state="ready"
        workspacePath="drafts/notes.md"
        assistantId="asst-1"
      />,
    );

    expect(screen.getByText("Open in editor")).toBeTruthy();
    expect(screen.queryByText("Open in workspace")).toBeNull();
  });

  test("a navigating card says the click leaves for the workspace", () => {
    render(
      <LocalFileCard
        displayName="run.txt"
        filename="run.txt"
        sizeBytes={null}
        kind="file"
        state="ready"
        workspacePath="logs/run.txt"
      />,
    );

    expect(screen.getByText("Open in workspace")).toBeTruthy();
  });

  test("a previewable card says the click opens a preview", () => {
    for (const filename of [
      "rows.csv",
      "report.docx",
      "deck.pptx",
      "run.txt",
      "report.pdf",
      "shot.png",
      "demo.mp4",
      "bundle.zip",
    ]) {
      render(
        <LocalFileCard
          displayName={filename}
          filename={filename}
          sizeBytes={null}
          kind="file"
          state="ready"
          workspacePath={`data/${filename}`}
          assistantId="asst-1"
        />,
      );

      expect(screen.getByText("Open preview")).toBeTruthy();
      expect(screen.queryByText("Open in workspace")).toBeNull();
      expect(screen.queryByText("Open in editor")).toBeNull();
      cleanup();
    }
  });

  test("a previewable card without an assistant navigates, and says so", () => {
    render(
      <LocalFileCard
        displayName="rows.csv"
        filename="rows.csv"
        sizeBytes={null}
        kind="file"
        state="ready"
        workspacePath="data/rows.csv"
      />,
    );

    expect(screen.getByText("Open in workspace")).toBeTruthy();
  });

  test("a markdown card without an assistant navigates, and says so", () => {
    render(
      <LocalFileCard
        displayName="notes.md"
        filename="notes.md"
        sizeBytes={null}
        kind="file"
        state="ready"
        workspacePath="drafts/notes.md"
      />,
    );

    expect(screen.getByText("Open in workspace")).toBeTruthy();
  });

  test("the hint is revealed on hover and focus, never on layout", () => {
    render(
      <LocalFileCard
        displayName="notes.md"
        filename="notes.md"
        sizeBytes={null}
        kind="file"
        state="ready"
        workspacePath="drafts/notes.md"
        assistantId="asst-1"
      />,
    );

    const hint = screen.getByText("Open in editor").parentElement;
    expect(hint?.className).toContain("opacity-0");
    expect(hint?.className).toContain(
      "group-hover/local-file-card:opacity-100",
    );
    expect(hint?.className).toContain(
      "group-focus-visible/local-file-card:opacity-100",
    );
    expect(hint?.className).toContain("[@media(pointer:coarse)]:opacity-100");
  });

  test("cards that cannot be opened carry no hint", () => {
    render(
      <LocalFileCard
        displayName="gone.md"
        filename="gone.md"
        sizeBytes={null}
        kind="file"
        state="missing"
        workspacePath="drafts/gone.md"
        assistantId="asst-1"
      />,
    );

    expect(screen.queryByText(/^Open in/)).toBeNull();
  });

  test("a ready card with no servable path carries no hint", () => {
    render(
      <LocalFileCard
        displayName="notes.md"
        filename="notes.md"
        sizeBytes={null}
        kind="file"
        state="ready"
        workspacePath={null}
        assistantId="asst-1"
      />,
    );

    expect(screen.queryByText(/^Open in/)).toBeNull();
  });
});

describe("LocalFileCard open state", () => {
  test("the card for the file in the drawer reads as open", () => {
    openDrawerWith("drafts/notes.md");

    render(
      <LocalFileCard
        displayName="notes.md"
        filename="notes.md"
        sizeBytes={null}
        kind="file"
        state="ready"
        workspacePath="drafts/notes.md"
        assistantId="asst-1"
      />,
    );

    const card = screen.getByRole("button", {
      name: "Close editor for notes.md",
    });
    expect(card.getAttribute("aria-expanded")).toBe("true");
    expect(card.className).toContain("border-[var(--border-active)]");
    expect(card.className).toContain("bg-[var(--surface-active)]");

    // The highlighted state carries the open signal on its own; no hint chip.
    expect(screen.queryByText("Close editor")).toBeNull();
    expect(screen.queryByText("Open in editor")).toBeNull();
  });

  test("the card for the previewed file reads as open", () => {
    openPreviewWith("data/rows.csv");

    render(
      <LocalFileCard
        displayName="rows.csv"
        filename="rows.csv"
        sizeBytes={null}
        kind="file"
        state="ready"
        workspacePath="data/rows.csv"
        assistantId="asst-1"
      />,
    );

    const card = screen.getByRole("button", {
      name: "Close preview for rows.csv",
    });
    expect(card.getAttribute("aria-expanded")).toBe("true");
    expect(card.className).toContain("border-[var(--border-active)]");
    expect(screen.queryByText("Close preview")).toBeNull();
    expect(screen.queryByText("Open preview")).toBeNull();
  });

  test("clicking an open preview card closes the drawer", () => {
    openPreviewWith("data/rows.csv");

    render(
      <LocalFileCard
        displayName="rows.csv"
        filename="rows.csv"
        sizeBytes={null}
        kind="file"
        state="ready"
        workspacePath="data/rows.csv"
        assistantId="asst-1"
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Close preview for rows.csv" }),
    );

    expect(closeDocument).toHaveBeenCalledTimes(1);
    expect(openWorkspaceFilePreview).not.toHaveBeenCalled();
  });

  test("a closed markdown card reports the collapsed drawer", () => {
    render(
      <LocalFileCard
        displayName="notes.md"
        filename="notes.md"
        sizeBytes={null}
        kind="file"
        state="ready"
        workspacePath="drafts/notes.md"
        assistantId="asst-1"
      />,
    );

    const card = screen.getByRole("button", { name: "Open notes.md" });
    expect(card.getAttribute("aria-expanded")).toBe("false");
    expect(card.className).toContain("bg-[var(--surface-lift)]");
  });

  test("a navigating card has no expanded state to report", () => {
    render(
      <LocalFileCard
        displayName="run.txt"
        filename="run.txt"
        sizeBytes={null}
        kind="file"
        state="ready"
        workspacePath="logs/run.txt"
      />,
    );

    expect(
      screen
        .getByRole("button", { name: "Open run.txt" })
        .getAttribute("aria-expanded"),
    ).toBeNull();
  });

  test("another file in the drawer leaves this card closed", () => {
    openDrawerWith("drafts/other.md");

    render(
      <LocalFileCard
        displayName="notes.md"
        filename="notes.md"
        sizeBytes={null}
        kind="file"
        state="ready"
        workspacePath="drafts/notes.md"
        assistantId="asst-1"
      />,
    );

    expect(screen.getByRole("button", { name: "Open notes.md" })).toBeTruthy();
  });

  test("clicking an open card closes the drawer", () => {
    openDrawerWith("drafts/notes.md");

    render(
      <LocalFileCard
        displayName="notes.md"
        filename="notes.md"
        sizeBytes={null}
        kind="file"
        state="ready"
        workspacePath="drafts/notes.md"
        assistantId="asst-1"
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Close editor for notes.md" }),
    );

    expect(closeDocument).toHaveBeenCalledTimes(1);
    expect(loadWorkspaceFileDocument).not.toHaveBeenCalled();
  });

  test("clicking a closed card opens the drawer", () => {
    render(
      <LocalFileCard
        displayName="notes.md"
        filename="notes.md"
        sizeBytes={null}
        kind="file"
        state="ready"
        workspacePath="drafts/notes.md"
        assistantId="asst-1"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open notes.md" }));

    expect(loadWorkspaceFileDocument).toHaveBeenCalledTimes(1);
    expect(loadWorkspaceFileDocument.mock.calls[0]).toEqual([
      "asst-1",
      "drafts/notes.md",
      "conv-1",
    ]);
    expect(closeDocument).not.toHaveBeenCalled();
  });
});
