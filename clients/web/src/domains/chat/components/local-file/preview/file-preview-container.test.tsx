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

type ContentResult = { data: unknown; error: unknown };

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
