/**
 * Tests for `AttachmentPreviewModal`.
 *
 * Coverage:
 *   1. Image with `previewUrl` set: renders an <img>, no fetch happens.
 *   2. Non-image with `assistantId` and no `previewUrl`: fetches the
 *      `/v1/assistants/{id}/attachments/{att_id}/content` endpoint, converts
 *      the response to a blob URL, renders the fallback card, and enables
 *      the download button once load completes.
 *   3. Escape key calls `onClose`.
 *
 * Uses `@testing-library/react` (which mounts into the happy-dom global
 * provided by `web/src/test-setup-dom.cjs`).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

// Mock shiki so the text-preview test path doesn't have to load the real
// highlighter (which pulls in WASM/grammar bundles). The stub returns the
// input wrapped in a <pre> so the rendered DOM still contains the text.
mock.module("shiki", () => ({
  createHighlighter: async () => ({
    codeToHtml: (code: string) => `<pre>${code}</pre>`,
  }),
}));

// Mock pdfjs-dist so the PdfPreview component doesn't try to load the
// real PDF.js worker or parse actual PDF binaries in the test environment.
const mockRenderPromise = { promise: Promise.resolve() };
const mockPage = {
  getViewport: () => ({ width: 612, height: 792 }),
  render: () => mockRenderPromise,
};
const mockPdf = {
  numPages: 1,
  getPage: async () => mockPage,
  destroy: async () => {},
};
mock.module("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  version: "5.4.296",
  getDocument: () => ({ promise: Promise.resolve(mockPdf) }),
}));

import { AppRootProvider } from "@/components/app/core/AppRootContext.js";
import { setActiveOrganizationIdForRequests } from "@/lib/organization/state.js";

import { AttachmentPreviewModal } from "@/components/app/assistant/ChatAttachments/_AttachmentPreviewModal.js";

// ---------------------------------------------------------------------------
// Test harness — wrap each render in `<AppRootProvider>` so the modal's
// `useAppRootContainer()` lookup resolves to the host `.app-root` element
// the provider mounts. Plus URL.createObjectURL / revokeObjectURL stubs that
// the blob conversion path relies on.
// ---------------------------------------------------------------------------

let originalFetch: typeof globalThis.fetch;
let originalCreateObjectURL: typeof URL.createObjectURL;
let originalRevokeObjectURL: typeof URL.revokeObjectURL;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalCreateObjectURL = URL.createObjectURL;
  originalRevokeObjectURL = URL.revokeObjectURL;

  // Stub object URL helpers — happy-dom doesn't always implement them.
  URL.createObjectURL = mock(() => "blob:mock-url");
  URL.revokeObjectURL = mock(() => {});
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  setActiveOrganizationIdForRequests(null);
});

// ---------------------------------------------------------------------------

describe("AttachmentPreviewModal", () => {
  test("image with previewUrl set: renders <img>, does not fetch", () => {
    const fetchMock = mock(async () => new Response(""));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const { container } = render(
      <AppRootProvider>
        <AttachmentPreviewModal
          open
          onClose={() => {}}
          attachment={{
            id: "att_1",
            filename: "kitten.png",
            mimeType: "image/png",
            sizeBytes: 1024,
            previewUrl: "https://example.test/kitten.png",
          }}
          assistantId="asst_1"
        />
      </AppRootProvider>,
    );

    // Portal renders into the provider's `.app-root` host — search the whole
    // document rather than the RTL-managed container.
    void container;
    const img = document.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe("https://example.test/kitten.png");
    expect(img!.getAttribute("alt")).toBe("kitten.png");
    // No fetch should have happened — previewUrl was supplied directly.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("non-image with assistantId and no previewUrl: fetches blob, enables download", async () => {
    const blob = new Blob(["hello"], { type: "application/zip" });
    const fetchMock = mock(async (_url: string): Promise<Response> => {
      // Construct a minimal Response-like object that satisfies the modal's
      // ok / blob() / statusText surface. Using a real Response is also fine,
      // but happy-dom's Response.blob() can be flaky across versions.
      return {
        ok: true,
        statusText: "OK",
        blob: async () => blob,
      } as unknown as Response;
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    render(
      <AppRootProvider>
        <AttachmentPreviewModal
          open
          onClose={() => {}}
          attachment={{
            id: "att_42",
            filename: "archive.zip",
            mimeType: "application/zip",
            sizeBytes: 2048,
            previewUrl: null,
          }}
          assistantId="asst_99"
        />
      </AppRootProvider>,
    );

    // Fetch is called with the documented URL.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledWith = fetchMock.mock.calls[0]?.[0];
    expect(calledWith).toBe(
      "/v1/assistants/asst_99/attachments/att_42/content",
    );

    // Wait for the async load to complete and the fallback card to show the
    // filename + an enabled download button. The fallback card renders the
    // original filename in a <p>, and the bottom info bar shows it again in
    // the Typography filename slot.
    await waitFor(() => {
      // Filename shows up at least once in the rendered tree.
      expect(document.body.textContent).toContain("archive.zip");
    });

    // After load, all download buttons should be enabled (not disabled).
    await waitFor(() => {
      const downloadButtons = Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          'button[aria-label="Download archive.zip"]',
        ),
      );
      expect(downloadButtons.length).toBeGreaterThan(0);
      for (const btn of downloadButtons) {
        expect(btn.disabled).toBe(false);
      }
    });

    // createObjectURL was called with the fetched blob.
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });

  test("fetch includes Vellum-Organization-Id header when org is active", async () => {
    setActiveOrganizationIdForRequests("org-test-123");

    const blob = new Blob(["data"], { type: "application/zip" });
    const fetchMock = mock(async (_url: string, _init?: RequestInit): Promise<Response> => {
      return {
        ok: true,
        statusText: "OK",
        blob: async () => blob,
      } as unknown as Response;
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    render(
      <AppRootProvider>
        <AttachmentPreviewModal
          open
          onClose={() => {}}
          attachment={{
            id: "att_org",
            filename: "doc.pdf",
            mimeType: "application/zip",
            sizeBytes: 512,
            previewUrl: null,
          }}
          assistantId="asst_1"
        />
      </AppRootProvider>,
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    const calledInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const headers = calledInit?.headers as Record<string, string> | undefined;
    expect(headers?.["Vellum-Organization-Id"]).toBe("org-test-123");
  });

  test("PDF attachment: renders canvas-based preview via pdfjs-dist", async () => {
    const blob = new Blob(["%PDF-1.4..."], { type: "application/pdf" });
    const fetchMock = mock(async (_url: string): Promise<Response> => {
      return {
        ok: true,
        statusText: "OK",
        blob: async () => blob,
      } as unknown as Response;
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    render(
      <AppRootProvider>
        <AttachmentPreviewModal
          open
          onClose={() => {}}
          attachment={{
            id: "att_pdf",
            filename: "report.pdf",
            mimeType: "application/pdf",
            sizeBytes: 4096,
            previewUrl: null,
          }}
          assistantId="asst_99"
        />
      </AppRootProvider>,
    );

    // Wait until the blob fetch resolves and pdfjs-dist renders a canvas.
    await waitFor(() => {
      const canvas = document.querySelector("canvas");
      expect(canvas).not.toBeNull();
    });

    // Fetch hit the documented attachment-content endpoint exactly once.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/v1/assistants/asst_99/attachments/att_pdf/content",
    );
  });

  test("text/plain attachment: renders highlighted text content", async () => {
    // Two fetches happen on this path: the modal pulls the blob to mint a
    // local URL, then `_TextPreview` re-fetches that blob URL to extract its
    // textual contents. Return the same payload for both calls.
    const blob = new Blob(["hello world"], { type: "text/plain" });
    const fetchMock = mock(async (_url: string): Promise<Response> => {
      return {
        ok: true,
        statusText: "OK",
        blob: async () => blob,
      } as unknown as Response;
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    render(
      <AppRootProvider>
        <AttachmentPreviewModal
          open
          onClose={() => {}}
          attachment={{
            id: "att_txt",
            filename: "notes.txt",
            mimeType: "text/plain",
            sizeBytes: 11,
            previewUrl: null,
          }}
          assistantId="asst_99"
        />
      </AppRootProvider>,
    );

    // The mocked Shiki highlighter wraps the file body in <pre>, so the
    // rendered DOM should contain the original text once the async chain
    // resolves.
    await waitFor(() => {
      expect(document.body.textContent).toContain("hello world");
    });
  });

  test("rehydrated attachment ID: shows unavailable message, does not fetch", async () => {
    const fetchMock = mock(async () => new Response(""));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    render(
      <AppRootProvider>
        <AttachmentPreviewModal
          open
          onClose={() => {}}
          attachment={{
            id: "rehydrated:0",
            filename: "document.pdf",
            mimeType: "application/pdf",
            sizeBytes: 4096,
            previewUrl: null,
          }}
          assistantId="asst_1"
        />
      </AppRootProvider>,
    );

    await waitFor(() => {
      expect(document.body.textContent).toContain("Preview unavailable");
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("Escape key invokes onClose", () => {
    const onClose = mock(() => {});

    render(
      <AppRootProvider>
        <AttachmentPreviewModal
          open
          onClose={onClose}
          attachment={{
            id: "att_1",
            filename: "kitten.png",
            mimeType: "image/png",
            sizeBytes: 1024,
            previewUrl: "https://example.test/kitten.png",
          }}
          assistantId="asst_1"
        />
      </AppRootProvider>,
    );

    // The modal listens for Escape via a React onKeyDown on the dialog div.
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();

    act(() => {
      fireEvent.keyDown(dialog as Element, { key: "Escape" });
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
