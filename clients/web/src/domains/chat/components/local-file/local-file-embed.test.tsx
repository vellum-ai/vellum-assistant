import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

let serve: (request: ContentRequest) => ContentResult;

const workspaceFileContentGet = mock(
  async (request: ContentRequest): Promise<ContentResult> => serve(request),
);

mock.module("@/generated/daemon/sdk.gen", () => ({
  ...daemonSdk,
  workspaceFileContentGet,
}));

mock.module("@/domains/chat/components/chat-attachments/pdf-preview", () => ({
  PdfPreview: ({ url }: { url: string }) => (
    <span data-testid="pdf-preview" data-url={url} />
  ),
}));

const { LocalFileEmbed } =
  await import("@/domains/chat/components/local-file/local-file-embed");

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Bytes with no recognizable signature, so the extension decides the type. */
const OPAQUE_BYTES = new Uint8Array([0x00, 0x01, 0x02, 0x03]);

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52,
]);

const ZIP_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00]);

/**
 * Answer both requests the components make for a file: the ranged probe (which
 * reads a stream and reports the total size) and the full blob fetch.
 */
function serveFile(opts: {
  bytes: Uint8Array;
  contentType: string;
  size?: number;
}): (request: ContentRequest) => ContentResult {
  return (request) => {
    if (request.parseAs === "blob") {
      return {
        data: new Blob([new Uint8Array(opts.bytes)], {
          type: opts.contentType,
        }),
        error: null,
        response: new Response(null, { status: 200 }),
      };
    }
    const total = opts.size ?? opts.bytes.byteLength;
    return {
      data: streamOf(opts.bytes),
      error: null,
      response: new Response(null, {
        status: 206,
        headers: {
          "Content-Type": opts.contentType,
          "Content-Range": `bytes 0-${opts.bytes.byteLength - 1}/${total}`,
        },
      }),
    };
  };
}

function notFound(): ContentResult {
  return {
    data: undefined,
    error: { error: "File not found" },
    response: new Response(null, { status: 404 }),
  };
}

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function renderEmbed(href: string, alt = "") {
  return render(<LocalFileEmbed href={href} alt={alt} assistantId="asst-1" />, {
    wrapper,
  });
}

beforeEach(() => {
  workspaceFileContentGet.mockClear();
  serve = serveFile({ bytes: PNG_BYTES, contentType: "image/png" });
});

afterEach(() => {
  cleanup();
  // Radix locks body pointer events while a menu is open; a test that
  // leaves one open must not disable pointers for the next one.
  document.body.style.pointerEvents = "";
  delete (document as { pictureInPictureEnabled?: boolean })
    .pictureInPictureEnabled;
});

/** happy-dom has no Picture in Picture API, so stand one in. */
function enablePictureInPicture() {
  Object.defineProperty(document, "pictureInPictureEnabled", {
    configurable: true,
    value: true,
  });
}

async function openFileActions() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "File actions" }));
  await waitFor(() =>
    expect(screen.getAllByRole("menuitem").length).toBeGreaterThan(0),
  );
}

describe("LocalFileEmbed media", () => {
  test("image bytes render an inline image from an object URL", async () => {
    const { container } = renderEmbed(
      "vellum://workspace/scratch/chart.png",
      "the chart",
    );

    await waitFor(() => expect(container.querySelector("img")).not.toBeNull());
    const img = container.querySelector("img")!;
    expect(img.getAttribute("alt")).toBe("the chart");
    expect(img.getAttribute("src")?.startsWith("blob:")).toBe(true);
    expect(img.getAttribute("class")).toContain("max-h-[400px]");
  });

  test.each([
    ["clip.mp3", "audio/mpeg"],
    ["clip.wav", "audio/wav"],
  ])("%s renders an audio player", async (filename) => {
    serve = serveFile({
      bytes: OPAQUE_BYTES,
      contentType: "application/octet-stream",
    });

    const { container } = renderEmbed(
      `vellum://workspace/media/${filename}`,
      "a recording",
    );

    await waitFor(() =>
      expect(container.querySelector("audio")).not.toBeNull(),
    );
    const audio = container.querySelector("audio")!;
    expect(audio.hasAttribute("controls")).toBe(true);
    expect(audio.getAttribute("aria-label")).toBe("a recording");
    expect(container.querySelector("img")).toBeNull();
  });

  test.each([["clip.mp4"], ["clip.mov"], ["clip.webm"]])(
    "%s renders a video player",
    async (filename) => {
      serve = serveFile({
        bytes: OPAQUE_BYTES,
        contentType: "application/octet-stream",
      });

      const { container } = renderEmbed(
        `vellum://workspace/media/${filename}`,
        "a clip",
      );

      await waitFor(() =>
        expect(container.querySelector("video")).not.toBeNull(),
      );
      const video = container.querySelector("video")!;
      expect(video.hasAttribute("controls")).toBe(true);
      expect(video.hasAttribute("playsinline")).toBe(true);
      expect(video.getAttribute("preload")).toBe("metadata");
    },
  );

  test("pdf bytes render a file card, not an inline preview", async () => {
    serve = serveFile({
      bytes: bytesOf("%PDF-1.7\n%stub"),
      contentType: "application/pdf",
      size: 4096,
    });

    renderEmbed("vellum://workspace/reports/q3.pdf", "Q3 report");

    // A page preview inside the transcript reads as an attempt to be the
    // document, so a pdf embeds as the card and its link opens the drawer.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Open q3.pdf" })).toBeTruthy(),
    );
    expect(screen.queryByTestId("pdf-preview")).toBeNull();
    expect(screen.getByText("Q3 report")).toBeTruthy();
    expect(screen.getByText("q3.pdf")).toBeTruthy();
    expect(screen.getByText("4.0 KB")).toBeTruthy();
  });

  test("a video's menu offers Picture in Picture", async () => {
    enablePictureInPicture();
    serve = serveFile({
      bytes: OPAQUE_BYTES,
      contentType: "application/octet-stream",
    });

    const { container } = renderEmbed(
      "vellum://workspace/media/clip.mp4",
      "a clip",
    );

    await waitFor(() =>
      expect(container.querySelector("video")).not.toBeNull(),
    );
    await openFileActions();

    expect(
      screen.getByRole("menuitem", { name: "Picture in Picture" }),
    ).toBeTruthy();
  });

  test("an audio menu has no Picture in Picture", async () => {
    enablePictureInPicture();
    serve = serveFile({
      bytes: OPAQUE_BYTES,
      contentType: "application/octet-stream",
    });

    const { container } = renderEmbed(
      "vellum://workspace/media/clip.mp3",
      "a recording",
    );

    await waitFor(() =>
      expect(container.querySelector("audio")).not.toBeNull(),
    );
    await openFileActions();

    expect(
      screen.queryByRole("menuitem", { name: "Picture in Picture" }),
    ).toBeNull();
  });

  test("every media variant carries the file actions menu", async () => {
    const { container } = renderEmbed("vellum://workspace/scratch/chart.png");

    await waitFor(() => expect(container.querySelector("img")).not.toBeNull());
    expect(screen.getByRole("button", { name: "File actions" })).toBeTruthy();
  });
});

describe("LocalFileEmbed cards", () => {
  test("a markdown file renders a card, never an image", async () => {
    serve = serveFile({
      bytes: bytesOf("# Notes\n"),
      contentType: "text/markdown",
      size: 8,
    });

    const { container } = renderEmbed(
      "vellum://workspace/notes.md",
      "my notes",
    );

    await waitFor(() => expect(screen.getByText("my notes")).toBeTruthy());
    expect(screen.getByText("notes.md")).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
  });

  test.each([
    ["data.csv", "text/csv"],
    [
      "brief.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
  ])("%s renders a card with its size", async (filename, contentType) => {
    serve = serveFile({
      bytes: OPAQUE_BYTES,
      contentType,
      size: 4096,
    });

    const { container } = renderEmbed(`vellum://workspace/files/${filename}`);

    await waitFor(() => expect(screen.getByText(filename)).toBeTruthy());
    expect(screen.getByText("4.0 KB")).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
  });

  test("an archive renders a card with its size", async () => {
    serve = serveFile({
      bytes: ZIP_BYTES,
      contentType: "application/zip",
      size: 2048,
    });

    renderEmbed("vellum://workspace/files/bundle.zip");

    await waitFor(() => expect(screen.getByText("bundle.zip")).toBeTruthy());
    expect(screen.getByText("2.0 KB")).toBeTruthy();
  });

  test("a missing file renders the not-found card", async () => {
    serve = notFound;

    const { container } = renderEmbed(
      "vellum://workspace/scratch/gone.png",
      "gone",
    );

    await waitFor(() =>
      expect(screen.getByText("File not found")).toBeTruthy(),
    );
    expect(container.querySelector("img")).toBeNull();
  });

  test("no assistant id renders a card instead of probing", async () => {
    const { container } = render(
      <LocalFileEmbed href="vellum://workspace/scratch/chart.png" alt="chart" />,
      { wrapper },
    );

    await waitFor(() => expect(screen.getByText("chart")).toBeTruthy());
    expect(container.querySelector("img")).toBeNull();
    expect(workspaceFileContentGet).not.toHaveBeenCalled();
  });

  test("a reference outside the workspace renders the unavailable card", async () => {
    renderEmbed("/etc/hosts", "hosts");

    await waitFor(() =>
      expect(screen.getByText("File isn't available here")).toBeTruthy(),
    );
    expect(workspaceFileContentGet).not.toHaveBeenCalled();
  });

  test("bytes that contradict the extension render a card", async () => {
    serve = serveFile({ bytes: ZIP_BYTES, contentType: "image/png" });

    const { container } = renderEmbed(
      "vellum://workspace/scratch/chart.png",
      "chart",
    );

    await waitFor(() => expect(screen.getByText("chart")).toBeTruthy());
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("chart.png")).toBeTruthy();
  });

  test("media over the inline size cap renders a card and never fetches the bytes", async () => {
    serve = serveFile({
      bytes: PNG_BYTES,
      contentType: "image/png",
      size: 200 * 1024 * 1024,
    });

    const { container } = renderEmbed(
      "vellum://workspace/scratch/huge.png",
      "huge",
    );

    await waitFor(() => expect(screen.getByText("200 MB")).toBeTruthy());
    expect(container.querySelector("img")).toBeNull();
    expect(workspaceFileContentGet).toHaveBeenCalledTimes(1);
    expect(workspaceFileContentGet.mock.calls[0]![0].parseAs).toBe("stream");
  });
});

describe("LocalFileEmbed href resolution", () => {
  test("percent-encoded segments decode to the workspace path", async () => {
    const { container } = renderEmbed(
      "vellum://workspace/notes/my%20file%20%C3%A9.png",
      "unicode chart",
    );

    await waitFor(() => expect(container.querySelector("img")).not.toBeNull());
    expect(workspaceFileContentGet.mock.calls[0]![0].query.path).toBe(
      "notes/my file é.png",
    );
  });

  test("a decoded filename renders as text, not markup", async () => {
    serve = serveFile({
      bytes: bytesOf("plain"),
      contentType: "text/plain",
      size: 5,
    });

    const { container } = renderEmbed(
      "vellum://workspace/notes/%3Cb%3Ereport%3Cb%3E%20final.txt",
    );

    await waitFor(() =>
      expect(screen.getByText("<b>report<b> final.txt")).toBeTruthy(),
    );
    expect(container.querySelector("b")).toBeNull();
  });

  test("an absolute workspace path resolves to its relative form", async () => {
    const { container } = renderEmbed(
      "/workspace/scratch/chart.png",
      "abs chart",
    );

    await waitFor(() => expect(container.querySelector("img")).not.toBeNull());
    expect(workspaceFileContentGet.mock.calls[0]![0].query.path).toBe(
      "scratch/chart.png",
    );
  });

  test("a relative path resolves against the workspace root", async () => {
    const { container } = renderEmbed("./scratch/chart.png", "rel chart");

    await waitFor(() => expect(container.querySelector("img")).not.toBeNull());
    expect(workspaceFileContentGet.mock.calls[0]![0].query.path).toBe(
      "scratch/chart.png",
    );
  });
});
