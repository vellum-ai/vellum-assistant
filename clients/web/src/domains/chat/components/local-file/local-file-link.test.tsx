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

const { LocalFileLink } =
  await import("@/domains/chat/components/local-file/local-file-link");
const { useViewerStore } = await import("@/stores/viewer-store");

const loadWorkspaceFileDocument = mock(
  async (_assistantId: string, _workspacePath: string) => {},
);
const openWorkspaceFilePreview = mock(
  (_workspacePath: string, _previewKind: WorkspaceFilePreviewKind) => {},
);

beforeEach(() => {
  openWorkspaceFile.mockClear();
  toastError.mockClear();
  loadWorkspaceFileDocument.mockClear();
  openWorkspaceFilePreview.mockClear();
  useViewerStore.setState({
    loadWorkspaceFileDocument,
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

  test("clicking opens the workspace file instead of navigating", () => {
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
    expect(openWorkspaceFile).toHaveBeenCalledTimes(1);
    expect(openWorkspaceFile.mock.calls[0]![0]).toBe("logs/run.txt");
    expect(loadWorkspaceFileDocument).not.toHaveBeenCalled();
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

  test("clicking a markdown file opens it in the document drawer", () => {
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

    expect(loadWorkspaceFileDocument).toHaveBeenCalledTimes(1);
    expect(loadWorkspaceFileDocument.mock.calls[0]).toEqual([
      "asst-1",
      "drafts/notes.md",
    ]);
    expect(openWorkspaceFile).not.toHaveBeenCalled();
  });

  test("a markdown file without an assistant falls back to the workspace", () => {
    render(
      <LocalFileLink href="/workspace/notes.md" workspacePath="notes.md">
        notes.md
      </LocalFileLink>,
    );

    fireEvent.click(screen.getByRole("link"));

    expect(loadWorkspaceFileDocument).not.toHaveBeenCalled();
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
