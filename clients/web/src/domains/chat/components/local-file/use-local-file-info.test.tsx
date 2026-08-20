import { beforeEach, describe, expect, mock, test } from "bun:test";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import * as daemonSdk from "@/generated/daemon/sdk.gen";

type ContentRequest = {
  path: { assistant_id: string };
  query: { path: string };
  headers?: Record<string, string>;
  parseAs?: string;
};

type ContentResult = {
  data: unknown;
  error: unknown;
  response?: Response;
};

let nextResult: () => ContentResult;

const workspaceFileContentGet = mock(
  async (_request: ContentRequest): Promise<ContentResult> => nextResult(),
);

mock.module("@/generated/daemon/sdk.gen", () => ({
  ...daemonSdk,
  workspaceFileContentGet,
}));

const { useLocalFileInfo } = await import(
  "@/domains/chat/components/local-file/use-local-file-info"
);

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

const PNG_HEAD = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52,
]);

const ZIP_HEAD = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00]);

function partialContent(bytes: Uint8Array, contentType: string, size: number) {
  return () => ({
    data: streamOf(bytes),
    error: null,
    response: new Response(null, {
      status: 206,
      headers: {
        "Content-Type": contentType,
        "Content-Range": `bytes 0-${bytes.byteLength - 1}/${size}`,
      },
    }),
  });
}

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  workspaceFileContentGet.mockClear();
  nextResult = partialContent(PNG_HEAD, "image/png", 12345);
});

describe("useLocalFileInfo", () => {
  test("classifies a ranged 206 response and reads the total size", async () => {
    const { result } = renderHook(
      () => useLocalFileInfo("scratch/a.png", "asst-1"),
      { wrapper },
    );

    expect(result.current).toEqual({ status: "loading" });

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current).toEqual({
      status: "ready",
      kind: "image",
      mime: "image/png",
      sizeBytes: 12345,
      workspacePath: "scratch/a.png",
      filename: "a.png",
    });

    const request = workspaceFileContentGet.mock.calls[0]![0];
    expect(request.path.assistant_id).toBe("asst-1");
    expect(request.query.path).toBe("scratch/a.png");
    expect(request.headers?.Range).toBe("bytes=0-511");
    expect(request.parseAs).toBe("stream");
  });

  test("reports a 404 as missing", async () => {
    nextResult = () => ({
      data: undefined,
      error: { error: "File not found" },
      response: new Response(null, { status: 404 }),
    });

    const { result } = renderHook(
      () => useLocalFileInfo("scratch/gone.png", "asst-1"),
      { wrapper },
    );

    await waitFor(() => expect(result.current.status).toBe("unavailable"));
    expect(result.current).toEqual({
      status: "unavailable",
      reason: "missing",
    });
  });

  test("classifies a 416 as an existing empty file, by extension", async () => {
    nextResult = () => ({
      data: undefined,
      error: { error: "Range Not Satisfiable" },
      response: new Response(null, { status: 416 }),
    });

    const { result } = renderHook(
      () => useLocalFileInfo("scratch/empty.md", "asst-1"),
      { wrapper },
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current).toMatchObject({
      status: "ready",
      kind: "file",
      sizeBytes: 0,
      filename: "empty.md",
    });
  });

  test("reports other failures as errors", async () => {
    nextResult = () => ({
      data: undefined,
      error: { error: "boom" },
      response: new Response(null, { status: 500 }),
    });

    const { result } = renderHook(
      () => useLocalFileInfo("scratch/a.png", "asst-1"),
      { wrapper },
    );

    await waitFor(() => expect(result.current.status).toBe("unavailable"));
    expect(result.current).toEqual({ status: "unavailable", reason: "error" });
  });

  test("the bytes override an extension-derived server type", async () => {
    nextResult = partialContent(ZIP_HEAD, "image/png", 900);

    const { result } = renderHook(
      () => useLocalFileInfo("scratch/chart.png", "asst-1"),
      { wrapper },
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current).toEqual({
      status: "ready",
      kind: "file",
      mime: "application/zip",
      sizeBytes: 900,
      workspacePath: "scratch/chart.png",
      filename: "chart.png",
    });
  });

  test("reads only the head of a 200 and falls back to Content-Length", async () => {
    // A server that ignores the Range header streams the whole file. The probe
    // must stop at the head and cancel instead of buffering it, so this source
    // never ends.
    let chunksPulled = 0;
    let cancelled = false;
    const endlessBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunksPulled += 1;
        const chunk = new Uint8Array(256);
        if (chunksPulled === 1) {
          chunk.set(PNG_HEAD, 0);
        }
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    nextResult = () => ({
      data: endlessBody,
      error: null,
      response: new Response(null, {
        status: 200,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": "4096",
        },
      }),
    });

    const { result } = renderHook(
      () => useLocalFileInfo("scratch/a.png", "asst-1"),
      { wrapper },
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current).toEqual({
      status: "ready",
      kind: "image",
      mime: "image/png",
      sizeBytes: 4096,
      workspacePath: "scratch/a.png",
      filename: "a.png",
    });
    expect(cancelled).toBe(true);
    // 512 head bytes is two 256-byte chunks, plus whatever the stream queues.
    expect(chunksPulled).toBeLessThanOrEqual(4);
  });

  test("a null path is outside the workspace and never fetches", () => {
    const { result } = renderHook(() => useLocalFileInfo(null, "asst-1"), {
      wrapper,
    });

    expect(result.current).toEqual({
      status: "unavailable",
      reason: "outside-workspace",
    });
    expect(workspaceFileContentGet).not.toHaveBeenCalled();
  });

  test("stays loading until an assistant id is available", () => {
    const { result } = renderHook(
      () => useLocalFileInfo("scratch/a.png", undefined),
      { wrapper },
    );

    expect(result.current).toEqual({ status: "loading" });
    expect(workspaceFileContentGet).not.toHaveBeenCalled();
  });
});
