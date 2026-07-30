import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const openWorkspaceFile = mock(async (_path: string) => {});

mock.module("@/utils/open-workspace-file", () => ({ openWorkspaceFile }));

const { LocalFileCard } =
  await import("@/domains/chat/components/local-file/local-file-card");
const { useViewerStore } = await import("@/stores/viewer-store");

const loadWorkspaceFileDocument = mock(
  async (_assistantId: string, _workspacePath: string) => {},
);

beforeEach(() => {
  openWorkspaceFile.mockClear();
  loadWorkspaceFileDocument.mockClear();
  useViewerStore.setState({ loadWorkspaceFileDocument });
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

  test("clicking a ready card opens the workspace file", () => {
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

    expect(openWorkspaceFile).toHaveBeenCalledTimes(1);
    expect(openWorkspaceFile.mock.calls[0]![0]).toBe("data/rows.csv");
    expect(loadWorkspaceFileDocument).not.toHaveBeenCalled();
  });

  test("Enter on a ready card opens the workspace file", () => {
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

    fireEvent.keyDown(screen.getByRole("button", { name: "Open rows.csv" }), {
      key: "Enter",
    });

    expect(openWorkspaceFile).toHaveBeenCalledTimes(1);
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
    ]);
    expect(openWorkspaceFile).not.toHaveBeenCalled();
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
