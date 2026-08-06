/**
 * Tests for the chat-domain ChatMarkdownMessage.
 *
 * Generic rendering tests live in `packages/design-library/`. These tests cover
 * what the chat-domain wrapper injects: OAuth popup links, and the dispatch of
 * markdown links and images onto attachment previews, workspace file media, and
 * remote images.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import * as daemonSdk from "@/generated/daemon/sdk.gen";
import { shouldOpenMarkdownLinkInOAuthPopup } from "@/domains/chat/utils/oauth-popup-links";
import { workspaceTreeQueryOptions } from "@/lib/workspace-tree-query";
import type { ChatMarkdownMessageProps } from "@/domains/chat/components/chat-markdown-message";
import type { DisplayAttachment } from "@/types/attachment-types";

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52,
]);

type ContentRequest = {
  path: { assistant_id: string };
  query: { path: string };
  headers?: Record<string, string>;
  parseAs?: string;
};

type ContentResult = { data: unknown; error: unknown; response?: Response };

/**
 * Answer the two requests a workspace file reference makes: the ranged probe
 * that classifies the bytes, and the full blob fetch for inline media.
 */
function serveFile(opts: {
  bytes: Uint8Array;
  contentType: string;
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
    return {
      data: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(opts.bytes);
          controller.close();
        },
      }),
      error: null,
      response: new Response(null, {
        status: 206,
        headers: {
          "Content-Type": opts.contentType,
          "Content-Range": `bytes 0-${opts.bytes.byteLength - 1}/${opts.bytes.byteLength}`,
        },
      }),
    };
  };
}

let serve: (request: ContentRequest) => ContentResult;

const workspaceFileContentGet = mock(
  async (request: ContentRequest): Promise<ContentResult> => serve(request),
);

const attachmentsByIdContentGet = mock(async () => ({
  data: new Blob([new Uint8Array(PNG_BYTES)], { type: "image/png" }),
  error: null,
}));

mock.module("@/generated/daemon/sdk.gen", () => ({
  ...daemonSdk,
  workspaceFileContentGet,
  attachmentsByIdContentGet,
}));

mock.module("@/domains/chat/components/chat-attachments/pdf-preview", () => ({
  PdfPreview: ({ url }: { url: string }) => (
    <span data-testid="pdf-preview" data-url={url} />
  ),
}));

const openWorkspaceFile = mock(async (_path: string) => {});

mock.module("@/utils/open-workspace-file", () => ({ openWorkspaceFile }));

const { ChatMarkdownMessage, isVellumLink } = await import(
  "@/domains/chat/components/chat-markdown-message"
);
const { useViewerStore } = await import("@/stores/viewer-store");

function makeAttachment(
  overrides: Pick<DisplayAttachment, "filename" | "mimeType"> &
    Partial<DisplayAttachment>,
): DisplayAttachment {
  return { id: "att-1", sizeBytes: 1024, previewUrl: null, ...overrides };
}

function renderMarkdown(props: ChatMarkdownMessageProps) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<ChatMarkdownMessage {...props} />, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
}

beforeEach(() => {
  workspaceFileContentGet.mockClear();
  attachmentsByIdContentGet.mockClear();
  openWorkspaceFile.mockClear();
  serve = serveFile({ bytes: PNG_BYTES, contentType: "image/png" });
  // File links open the real drawer, so each test starts from a closed one.
  useViewerStore.setState({ mainView: "chat", openedDocumentState: null });
});

afterEach(() => {
  cleanup();
});

describe("ChatMarkdownMessage (OAuth link handling)", () => {
  test("detects OAuth authorization links for popup handling", () => {
    const oauthUrl =
      "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=client-1&redirect_uri=http%3A%2F%2Flocalhost%3A8000%2Fcallback";

    expect(shouldOpenMarkdownLinkInOAuthPopup(oauthUrl)).toBe(true);
    expect(shouldOpenMarkdownLinkInOAuthPopup("https://example.com/docs")).toBe(
      false,
    );
    expect(
      shouldOpenMarkdownLinkInOAuthPopup("mailto:support@example.com"),
    ).toBe(false);
  });

  test("normal links include noopener noreferrer", () => {
    const html = renderToStaticMarkup(
      createElement(ChatMarkdownMessage, {
        content: "[Docs](https://example.com/docs)",
      }),
    );

    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  test("OAuth links omit rel to allow popup communication", () => {
    const oauthUrl =
      "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=client-1&redirect_uri=http%3A%2F%2Flocalhost%3A8000%2Fcallback";
    const html = renderToStaticMarkup(
      createElement(ChatMarkdownMessage, {
        content: `[Connect](${oauthUrl})`,
      }),
    );

    expect(html).toContain('target="_blank"');
    expect(html).not.toContain('rel="noopener noreferrer"');
  });

  test("remote links stay on the OAuth-aware anchor, handler or not", () => {
    const html = renderToStaticMarkup(
      createElement(ChatMarkdownMessage, {
        content: "[Docs](https://example.com)",
        onVellumLinkClick: () => {},
      }),
    );

    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
});

describe("isVellumLink", () => {
  test("returns true for vellum://workspace/ links", () => {
    expect(isVellumLink("vellum://workspace/scratch/report.pdf")).toBe(true);
  });

  test("returns true for vellum://host/ links", () => {
    expect(isVellumLink("vellum://host/Users/me/doc.pdf")).toBe(true);
  });

  test("returns false for unknown vellum:// authority", () => {
    expect(isVellumLink("vellum://evil/payload")).toBe(false);
  });

  test("returns false for https links", () => {
    expect(isVellumLink("https://example.com")).toBe(false);
  });

  test("returns false for undefined", () => {
    expect(isVellumLink(undefined)).toBe(false);
  });
});

describe("ChatMarkdownMessage (file link dispatch)", () => {
  test("with an assistant a file link opens the drawer, not the modal", () => {
    const onVellumLinkClick = mock((_href: string, _text: string) => {});
    const { container } = renderMarkdown({
      content: "[Open](vellum://workspace/scratch/report.pdf)",
      onVellumLinkClick,
      assistantId: "asst-1",
    });

    fireEvent.click(container.querySelector("a")!);

    expect(onVellumLinkClick).not.toHaveBeenCalled();
    expect(openWorkspaceFile).not.toHaveBeenCalled();
    const opened = useViewerStore.getState().openedDocumentState;
    expect(opened).toEqual({
      source: "workspace-file-preview",
      workspacePath: "scratch/report.pdf",
      documentName: "report.pdf",
      previewKind: "pdf",
    });
  });

  test("a workspace path link opens the drawer the same way", () => {
    const onVellumLinkClick = mock((_href: string, _text: string) => {});
    const { container } = renderMarkdown({
      content: "[Open](/workspace/archives/bundle.zip)",
      onVellumLinkClick,
      assistantId: "asst-1",
    });

    fireEvent.click(container.querySelector("a")!);

    expect(onVellumLinkClick).not.toHaveBeenCalled();
    expect(useViewerStore.getState().openedDocumentState).toEqual({
      source: "workspace-file-preview",
      workspacePath: "archives/bundle.zip",
      documentName: "bundle.zip",
      previewKind: "unsupported",
    });
  });

  test("a host link keeps the modal: the drawer has no route to its bytes", () => {
    const onVellumLinkClick = mock((_href: string, _text: string) => {});
    const { container } = renderMarkdown({
      content: "[Open](vellum://host/Users/me/report.pdf)",
      onVellumLinkClick,
      assistantId: "asst-1",
    });

    fireEvent.click(container.querySelector("a")!);

    expect(onVellumLinkClick.mock.calls[0]).toEqual([
      "vellum://host/Users/me/report.pdf",
      "Open",
    ]);
    expect(useViewerStore.getState().openedDocumentState).toBeNull();
  });

  test("without an assistant a vellum:// link falls back to the modal", () => {
    const onVellumLinkClick = mock((_href: string, _text: string) => {});
    const { container } = renderMarkdown({
      content: "[Open](vellum://workspace/scratch/report.pdf)",
      onVellumLinkClick,
    });

    const anchor = container.querySelector("a")!;
    expect(anchor.getAttribute("href")).toBe(
      "vellum://workspace/scratch/report.pdf",
    );
    expect(anchor.getAttribute("target")).toBeNull();
    expect(anchor.querySelector("svg")).not.toBeNull();

    fireEvent.click(anchor);
    expect(onVellumLinkClick).toHaveBeenCalledTimes(1);
    expect(onVellumLinkClick.mock.calls[0]).toEqual([
      "vellum://workspace/scratch/report.pdf",
      "Open",
    ]);
  });

  test("a workspace path link falls back to the same modal as vellum://", () => {
    const onVellumLinkClick = mock((_href: string, _text: string) => {});
    const { container } = renderMarkdown({
      content: "[Open](/workspace/scratch/report.pdf)",
      onVellumLinkClick,
    });

    fireEvent.click(container.querySelector("a")!);
    expect(onVellumLinkClick.mock.calls[0]).toEqual([
      "vellum://workspace/scratch/report.pdf",
      "Open",
    ]);
  });

  test("without a handler a file link opens the workspace file viewer", () => {
    const { container } = renderMarkdown({
      content: "[report.pdf](vellum://workspace/scratch/report.pdf)",
    });

    const anchor = container.querySelector("a")!;
    expect(anchor.getAttribute("target")).toBeNull();

    fireEvent.click(anchor);
    expect(openWorkspaceFile).toHaveBeenCalledWith("scratch/report.pdf");
  });

  test("a percent-encoded path decodes to the workspace path it names", () => {
    const { container } = renderMarkdown({
      content:
        "[file with spaces](/workspace/scratch/shot%20with%20spaces.png)",
    });

    fireEvent.click(container.querySelector("a")!);
    expect(openWorkspaceFile).toHaveBeenCalledWith(
      "scratch/shot with spaces.png",
    );
  });

  test("file links inside a list keep the list structure", () => {
    const { container } = renderMarkdown({
      content: "- [a](/workspace/a.md)\n- [b](/workspace/b.md)",
      onVellumLinkClick: () => {},
    });

    const items = container.querySelectorAll("li");
    expect(items.length).toBe(2);
    expect(container.querySelectorAll("ul").length).toBe(1);
    expect(items[0]!.querySelector("a")).not.toBeNull();
    expect(items[1]!.querySelector("a")).not.toBeNull();
  });

  test("a backticked path opens the drawer, like an explicit link", () => {
    const onVellumLinkClick = mock((_href: string, _text: string) => {});
    // The span becomes a link only once a listing confirms the file, so the
    // listing is seeded rather than fetched.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(
      workspaceTreeQueryOptions({ assistantId: "asst-1", path: "scratch" })
        .queryKey,
      {
        path: "scratch",
        entries: [
          {
            name: "report.pdf",
            path: "scratch/report.pdf",
            type: "file",
            size: 128,
            mimeType: "application/pdf",
            modifiedAt: "2026-07-24T02:18:49Z",
          },
        ],
      },
    );
    render(
      <ChatMarkdownMessage
        content="See `/workspace/scratch/report.pdf`."
        assistantId="asst-1"
        workspacePathLinks
        onVellumLinkClick={onVellumLinkClick}
      />,
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={queryClient}>
            {children}
          </QueryClientProvider>
        ),
      },
    );

    const span = screen.getByRole("button", {
      name: "/workspace/scratch/report.pdf",
    });
    fireEvent.click(span);

    expect(onVellumLinkClick).not.toHaveBeenCalled();
    expect(useViewerStore.getState().openedDocumentState).toEqual({
      source: "workspace-file-preview",
      workspacePath: "scratch/report.pdf",
      documentName: "report.pdf",
      previewKind: "pdf",
    });

    // The same toggle an explicit link uses: a second click closes it.
    fireEvent.click(span);
    expect(useViewerStore.getState().openedDocumentState).toBeNull();
  });
});

describe("ChatMarkdownMessage (image dispatch)", () => {
  test("a matching image attachment renders its own blob with the zoom button", async () => {
    const { container } = renderMarkdown({
      content: "![alt](vellum://workspace/scratch/chart.png)",
      attachments: [
        makeAttachment({ filename: "chart.png", mimeType: "image/png" }),
      ],
      assistantId: "asst-1",
    });

    await waitFor(() => expect(container.querySelector("img")).not.toBeNull());
    expect(
      container.querySelector("img")!.getAttribute("src")?.startsWith("blob:"),
    ).toBe(true);
    expect(
      screen.getByRole("button", { name: "Expand image: alt" }),
    ).toBeTruthy();
    expect(attachmentsByIdContentGet).toHaveBeenCalledTimes(1);
    expect(workspaceFileContentGet).not.toHaveBeenCalled();
  });

  test("a vellum:// image with no matching attachment renders the workspace embed", async () => {
    serve = serveFile({
      bytes: new TextEncoder().encode("# Notes\n"),
      contentType: "text/markdown",
    });

    const { container } = renderMarkdown({
      content: "![alt](vellum://workspace/scratch/notes.md)",
      attachments: [],
      assistantId: "asst-1",
    });

    await waitFor(() => expect(screen.getByText("notes.md")).toBeTruthy());
    expect(workspaceFileContentGet.mock.calls[0]![0].query.path).toBe(
      "scratch/notes.md",
    );
    expect(container.querySelector("img")).toBeNull();
  });

  test("a matching non-image attachment renders the workspace embed", async () => {
    serve = serveFile({
      bytes: new TextEncoder().encode("%PDF-1.7\n%stub"),
      contentType: "application/pdf",
    });

    renderMarkdown({
      content: "![alt](vellum://workspace/report.pdf)",
      attachments: [
        makeAttachment({
          filename: "report.pdf",
          mimeType: "application/pdf",
        }),
      ],
      assistantId: "asst-1",
    });

    // A PDF framed inline reads as an attempt to be the document, so the embed
    // renders the file card and leaves opening it to the drawer.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Open report.pdf" }),
      ).toBeTruthy(),
    );
    expect(screen.queryByTestId("pdf-preview")).toBeNull();
    expect(workspaceFileContentGet.mock.calls[0]![0].query.path).toBe(
      "report.pdf",
    );
    expect(attachmentsByIdContentGet).not.toHaveBeenCalled();
  });

  test("an absolute workspace path renders the workspace embed", async () => {
    const { container } = renderMarkdown({
      content: "![alt](/workspace/scratch/chart.png)",
      assistantId: "asst-1",
    });

    await waitFor(() => expect(container.querySelector("img")).not.toBeNull());
    expect(
      container.querySelector("img")!.getAttribute("src")?.startsWith("blob:"),
    ).toBe(true);
    expect(workspaceFileContentGet.mock.calls[0]![0].query.path).toBe(
      "scratch/chart.png",
    );
  });

  test("a remote image renders inline from its own URL", async () => {
    const { container } = renderMarkdown({
      content: "![alt](https://example.com/x.png)",
      assistantId: "asst-1",
    });

    const img = container.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("https://example.com/x.png");
    expect(img.getAttribute("alt")).toBe("alt");
    expect(workspaceFileContentGet).not.toHaveBeenCalled();
  });

  test("a blanked scheme renders the fallback, never an image or link", () => {
    const { container } = renderMarkdown({
      content: "![alt](javascript:alert(1))",
      assistantId: "asst-1",
    });

    expect(screen.getByText("Image failed to load (alt)")).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
    expect(container.innerHTML).not.toContain("javascript:");
  });
});
