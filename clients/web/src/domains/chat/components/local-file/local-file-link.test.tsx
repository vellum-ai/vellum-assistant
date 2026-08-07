import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { WorkspaceFilePreviewKind } from "@/stores/viewer-store";

const openWorkspaceFile = mock(async (_path: string) => {});
const toastError = mock((_message: string) => {});

mock.module("@/utils/open-workspace-file", () => ({ openWorkspaceFile }));

// The barrel re-exports this module, so mocking the leaf keeps the rest of the
// design library intact for everything else in the process.
const toastModule = await import("@vellumai/design-library/components/toast");
mock.module("@vellumai/design-library/components/toast", () => ({
  ...toastModule,
  toast: { ...toastModule.toast, error: toastError },
}));

const { LocalFileLink } = await import(
  "@/domains/chat/components/local-file/local-file-link"
);
const { useViewerStore } = await import("@/stores/viewer-store");

const openWorkspaceFilePreview = mock(
  (_workspacePath: string, _previewKind: WorkspaceFilePreviewKind) => {},
);

beforeEach(() => {
  openWorkspaceFile.mockClear();
  toastError.mockClear();
  openWorkspaceFilePreview.mockClear();
  useViewerStore.setState({
    mainView: "chat",
    openedDocumentState: null,
    openWorkspaceFilePreview,
  });
});

afterEach(() => {
  cleanup();
  // Radix locks body pointer events while a menu is open; a test that
  // leaves one open must not disable pointers for the next one.
  document.body.style.pointerEvents = "";
});

describe("LocalFileLink", () => {
  test("renders an anchor with a decorative icon and the markdown label", () => {
    render(
      <LocalFileLink
        href="/workspace/reports/q3.png"
        workspacePath="reports/q3.png"
        assistantId="asst-1"
      >
        the chart
      </LocalFileLink>,
    );

    const link = screen.getByRole("link", { name: "the chart" });
    expect(link.getAttribute("href")).toBe("/workspace/reports/q3.png");

    const icon = link.querySelector("svg");
    expect(icon).not.toBeNull();
    expect(icon!.getAttribute("aria-hidden")).toBe("true");
    expect(icon!.getAttribute("class")).toContain("h-3.5");
  });

  test("stays inline-level and keeps the transcript file-link styling", () => {
    render(
      <LocalFileLink href="/workspace/notes.md" workspacePath="notes.md">
        notes.md
      </LocalFileLink>,
    );

    const className = screen.getByRole("link").getAttribute("class") ?? "";
    expect(className).toContain("inline-flex");
    expect(className).toContain("text-[var(--system-positive-strong)]");
    expect(className).toContain("underline");
  });

  test("clicking opens the file in the drawer instead of navigating", () => {
    render(
      <LocalFileLink
        href="/workspace/logs/run.txt"
        workspacePath="logs/run.txt"
        assistantId="asst-1"
      >
        the log
      </LocalFileLink>,
    );

    const event = new window.MouseEvent("click", {
      bubbles: true,
      cancelable: true,
    });
    fireEvent(screen.getByRole("link"), event);

    expect(event.defaultPrevented).toBe(true);
    expect(openWorkspaceFilePreview).toHaveBeenCalledTimes(1);
    expect(openWorkspaceFilePreview.mock.calls[0]).toEqual([
      "logs/run.txt",
      "text",
    ]);
    expect(openWorkspaceFile).not.toHaveBeenCalled();
  });

  test("clicking a file already open in the drawer closes it", () => {
    const closeDocument = mock(() => {});
    useViewerStore.setState({
      closeDocument,
      mainView: "document",
      openedDocumentState: {
        source: "workspace-file-preview",
        workspacePath: "logs/run.txt",
        documentName: "run.txt",
        previewKind: "text",
      },
    });
    render(
      <LocalFileLink
        href="/workspace/logs/run.txt"
        workspacePath="logs/run.txt"
        assistantId="asst-1"
      >
        the log
      </LocalFileLink>,
    );

    fireEvent.click(screen.getByRole("link"));

    expect(closeDocument).toHaveBeenCalledTimes(1);
    expect(openWorkspaceFilePreview).not.toHaveBeenCalled();
  });

  test("a file with no reader opens the drawer's unsupported state", () => {
    render(
      <LocalFileLink
        href="/workspace/archives/bundle.zip"
        workspacePath="archives/bundle.zip"
        assistantId="asst-1"
      >
        the bundle
      </LocalFileLink>,
    );

    fireEvent.click(screen.getByRole("link"));

    expect(openWorkspaceFilePreview.mock.calls[0]).toEqual([
      "archives/bundle.zip",
      "unsupported",
    ]);
    expect(openWorkspaceFile).not.toHaveBeenCalled();
  });

  test("clicking a previewable file opens the read-only drawer", () => {
    render(
      <LocalFileLink
        href="/workspace/data/rows.csv"
        workspacePath="data/rows.csv"
        assistantId="asst-1"
      >
        the rows
      </LocalFileLink>,
    );

    fireEvent.click(screen.getByRole("link"));

    expect(openWorkspaceFilePreview).toHaveBeenCalledTimes(1);
    expect(openWorkspaceFilePreview.mock.calls[0]).toEqual([
      "data/rows.csv",
      "csv",
    ]);
    expect(openWorkspaceFile).not.toHaveBeenCalled();
  });

  test("clicking a markdown file opens its read-only preview", () => {
    render(
      <LocalFileLink
        href="/workspace/drafts/notes.md"
        workspacePath="drafts/notes.md"
        assistantId="asst-1"
      >
        my notes
      </LocalFileLink>,
    );

    fireEvent.click(screen.getByRole("link"));

    expect(openWorkspaceFilePreview).toHaveBeenCalledTimes(1);
    expect(openWorkspaceFilePreview.mock.calls[0]).toEqual([
      "drafts/notes.md",
      "markdown",
    ]);
    expect(openWorkspaceFile).not.toHaveBeenCalled();
  });

  test("clicking the markdown file already open closes it", () => {
    const closeDocument = mock(() => {});
    useViewerStore.setState({
      closeDocument,
      mainView: "document",
      openedDocumentState: {
        source: "workspace-file-preview",
        workspacePath: "drafts/notes.md",
        documentName: "notes.md",
        previewKind: "markdown",
      },
    });
    render(
      <LocalFileLink
        href="/workspace/drafts/notes.md"
        workspacePath="drafts/notes.md"
        assistantId="asst-1"
      >
        my notes
      </LocalFileLink>,
    );

    fireEvent.click(screen.getByRole("link"));

    expect(closeDocument).toHaveBeenCalledTimes(1);
    expect(openWorkspaceFilePreview).not.toHaveBeenCalled();
  });

  test("a markdown file without an assistant falls back to the workspace", () => {
    render(
      <LocalFileLink href="/workspace/notes.md" workspacePath="notes.md">
        notes.md
      </LocalFileLink>,
    );

    fireEvent.click(screen.getByRole("link"));

    expect(openWorkspaceFilePreview).not.toHaveBeenCalled();
    expect(openWorkspaceFile).toHaveBeenCalledTimes(1);
    expect(openWorkspaceFile.mock.calls[0]![0]).toBe("notes.md");
  });

  test("onActivate takes over the click", () => {
    const onActivate = mock(() => {});
    render(
      <LocalFileLink
        href="/workspace/notes.md"
        workspacePath="notes.md"
        onActivate={onActivate}
      >
        notes.md
      </LocalFileLink>,
    );

    fireEvent.click(screen.getByRole("link"));

    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(openWorkspaceFile).not.toHaveBeenCalled();
  });

  test("an unservable path reports it instead of navigating", () => {
    render(
      <LocalFileLink href="/etc/hosts" workspacePath={null}>
        hosts
      </LocalFileLink>,
    );

    fireEvent.click(screen.getByRole("link"));

    expect(openWorkspaceFile).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError.mock.calls[0]![0]).toBe("This file isn't available here");
  });
});
