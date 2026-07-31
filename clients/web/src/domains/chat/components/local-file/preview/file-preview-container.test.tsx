import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import * as daemonSdk from "@/generated/daemon/sdk.gen";

type ContentResult = { data: unknown; error: unknown; response?: Response };

let nextResult: () => ContentResult;

const workspaceFileContentGet = mock(
  async (_request: unknown): Promise<ContentResult> => nextResult(),
);

mock.module("@/generated/daemon/sdk.gen", () => ({
  ...daemonSdk,
  workspaceFileContentGet,
}));

const downloadWorkspaceFile = mock(async (_opts: unknown) => {});
mock.module("@/utils/download-workspace-file", () => ({
  downloadWorkspaceFile,
}));

const openWorkspaceFile = mock(async (_path: string) => {});
mock.module("@/utils/open-workspace-file", () => ({ openWorkspaceFile }));

// The readers are lazy chunks of their own. Stubbing them keeps this test on
// the container's job — fetch, gate, dispatch — and off the parsers'.
mock.module("@/domains/chat/components/local-file/preview/csv-preview", () => ({
  CsvPreview: ({ filename }: { blob: Blob; filename: string }) => (
    <div>{`csv preview of ${filename}`}</div>
  ),
}));
mock.module("@/domains/chat/components/local-file/preview/docx-preview", () => ({
  DocxPreview: ({ filename }: { blob: Blob; filename: string }) => (
    <div>{`docx preview of ${filename}`}</div>
  ),
}));
mock.module("@/domains/chat/components/local-file/preview/pptx-preview", () => ({
  PptxPreview: ({ filename }: { blob: Blob; filename: string }) => (
    <div>{`pptx preview of ${filename}`}</div>
  ),
}));

const { FilePreviewContainer } = await import(
  "@/domains/chat/components/local-file/preview/file-preview-container"
);

function blobResult(bytes: number): () => ContentResult {
  return () => ({ data: new Blob([new Uint8Array(bytes)]), error: null });
}

function textResult(text: string): () => ContentResult {
  return () => ({ data: new Blob([text], { type: "text/plain" }), error: null });
}

/**
 * What the ranged classification probe answers for a file of `sizeBytes`: a
 * 206 with no body, since only the total size is read off it.
 */
function probeResult(sizeBytes: number): () => ContentResult {
  return () => ({
    data: null,
    error: null,
    response: new Response(null, {
      status: 206,
      headers: { "Content-Range": `bytes 0-511/${sizeBytes}` },
    }),
  });
}

function renderPreview(
  props: Partial<Parameters<typeof FilePreviewContainer>[0]> = {},
): { onClose: ReturnType<typeof mock> } {
  const onClose = mock(() => {});
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  render(
    <FilePreviewContainer
      assistantId="asst-1"
      workspacePath="data/rows.csv"
      documentName="rows.csv"
      previewKind="csv"
      onClose={onClose}
      {...props}
    />,
    { wrapper },
  );
  return { onClose };
}

beforeEach(() => {
  workspaceFileContentGet.mockClear();
  downloadWorkspaceFile.mockClear();
  openWorkspaceFile.mockClear();
  nextResult = blobResult(64);
});

afterEach(() => {
  cleanup();
});

describe("FilePreviewContainer", () => {
  test("names the file and its path while the bytes are in flight", () => {
    nextResult = () => new Promise<ContentResult>(() => {}) as never;

    renderPreview();

    expect(screen.getByText("rows.csv").getAttribute("title")).toBe(
      "data/rows.csv",
    );
    expect(screen.getByLabelText("Loading preview")).toBeTruthy();
  });

  test("reads the bytes through the shared workspace file query", async () => {
    renderPreview();

    await waitFor(() =>
      expect(screen.getByText("csv preview of rows.csv")).toBeTruthy(),
    );
    const request = workspaceFileContentGet.mock.calls[0]![0] as {
      path: { assistant_id: string };
      query: { path: string };
      parseAs: string;
    };
    expect(request.path.assistant_id).toBe("asst-1");
    expect(request.query.path).toBe("data/rows.csv");
    expect(request.parseAs).toBe("blob");
  });

  test("dispatches each kind to its own reader", async () => {
    renderPreview({
      workspacePath: "docs/report.docx",
      documentName: "report.docx",
      previewKind: "docx",
    });

    await waitFor(() =>
      expect(screen.getByText("docx preview of report.docx")).toBeTruthy(),
    );
    cleanup();

    renderPreview({
      workspacePath: "decks/plan.pptx",
      documentName: "plan.pptx",
      previewKind: "pptx",
    });

    await waitFor(() =>
      expect(screen.getByText("pptx preview of plan.pptx")).toBeTruthy(),
    );
  });

  test("a failed fetch offers a retry that fetches again", async () => {
    nextResult = () => ({ data: null, error: { error: "boom" } });

    renderPreview();

    await waitFor(() =>
      expect(screen.getByText("Couldn't load this file")).toBeTruthy(),
    );

    nextResult = blobResult(64);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() =>
      expect(screen.getByText("csv preview of rows.csv")).toBeTruthy(),
    );
    expect(workspaceFileContentGet.mock.calls.length).toBe(2);
  });

  test("a file over the size cap is offered as a download instead", async () => {
    nextResult = blobResult(26 * 1024 * 1024);

    renderPreview();

    await waitFor(() =>
      expect(screen.getByText("This file is too large to preview")).toBeTruthy(),
    );
    expect(screen.queryByText("csv preview of rows.csv")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(downloadWorkspaceFile).toHaveBeenCalledTimes(1);
    expect(downloadWorkspaceFile.mock.calls[0]![0]).toEqual({
      assistantId: "asst-1",
      path: "data/rows.csv",
      filename: "rows.csv",
    });
  });

  test("a text file renders its contents verbatim", async () => {
    nextResult = textResult("first line\nsecond line");

    renderPreview({
      workspacePath: "logs/run.log",
      documentName: "run.log",
      previewKind: "text",
    });

    // The query normalizes whitespace, so the newline is matched as a space.
    const block = await waitFor(() =>
      screen.getByText("first line second line"),
    );
    expect(block.tagName).toBe("PRE");
    expect(block.textContent).toBe("first line\nsecond line");
    expect(screen.queryByText("Showing the first 2 MB")).toBeNull();
  });

  test("text past the display cap ends with a truncation notice", async () => {
    nextResult = textResult("x".repeat(2 * 1024 * 1024 + 1));

    renderPreview({
      workspacePath: "logs/run.log",
      documentName: "run.log",
      previewKind: "text",
    });

    await waitFor(() =>
      expect(screen.getByText("Showing the first 2 MB")).toBeTruthy(),
    );
  });

  test("a file with no reader names it and offers both ways on", async () => {
    nextResult = probeResult(4096);

    renderPreview({
      workspacePath: "archives/bundle.zip",
      documentName: "bundle.zip",
      previewKind: "unsupported",
    });

    await waitFor(() =>
      expect(screen.getByText("No preview for this file type")).toBeTruthy(),
    );
    expect(screen.getByText("4.0 KB")).toBeTruthy();
    // The bytes are never pulled for a file nothing can read.
    for (const call of workspaceFileContentGet.mock.calls) {
      expect((call[0] as { parseAs?: string }).parseAs).toBe("stream");
    }

    fireEvent.click(screen.getByRole("button", { name: "Go to file" }));
    expect(openWorkspaceFile.mock.calls[0]![0]).toBe("archives/bundle.zip");

    fireEvent.click(screen.getByRole("button", { name: "Download file" }));
    expect(downloadWorkspaceFile.mock.calls[0]![0]).toEqual({
      assistantId: "asst-1",
      path: "archives/bundle.zip",
      filename: "bundle.zip",
    });
  });

  test("media is refused only past the larger inline-media cap", async () => {
    nextResult = blobResult(26 * 1024 * 1024);

    renderPreview({
      workspacePath: "clips/demo.mp4",
      documentName: "demo.mp4",
      previewKind: "video",
    });

    await waitFor(() => expect(screen.getByLabelText("demo.mp4")).toBeTruthy());
    expect(screen.queryByText("This file is too large to preview")).toBeNull();
  });

  test("the navbar downloads the file and closes the drawer", async () => {
    const { onClose } = renderPreview();

    await waitFor(() =>
      expect(screen.getByText("csv preview of rows.csv")).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Download rows.csv" }));
    expect(downloadWorkspaceFile).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
