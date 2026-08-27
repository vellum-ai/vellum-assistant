import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
// `?url` emits the package's prebuilt worker as a hashed asset and yields its
// URL, so the worker is served from our own origin and its version is the
// `pdfjs-dist` this bundle imports. Not `?worker&url`: the file is already a
// built worker bundle and needs emitting as-is, not recompiling as a worker
// entry. A bare `new URL(..., import.meta.url)` does not work here either,
// since Vite resolves that form for relative paths, not package specifiers.
// https://vite.dev/guide/assets#explicit-url-imports
import PDF_WORKER_URL from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

import { PdfPageSkeleton } from "@/domains/chat/components/chat-attachments/pdf-page-skeleton";
import { dataUriToUint8Array } from "@/domains/chat/components/chat-attachments/utils";
import { PreviewTruncationNotice } from "@/domains/chat/components/local-file/preview/preview-truncation-notice";
import { useTranslation } from "@/i18n";

/**
 * Inline PDF preview rendered via pdfjs-dist canvas. Bypasses Safari/WebKit
 * iframe sandbox restrictions that block PDF plugin rendering (WHATWG HTML
 * spec removed "secured plugins" — sandboxed iframes never display PDFs on
 * WebKit). Works identically on all platforms including WKWebView/Capacitor.
 *
 * @see https://github.com/nicedoc/nicedoc/pull/6946 — WHATWG spec change
 * @see https://bugs.webkit.org/show_bug.cgi?id=118859 — WebKit sandbox+PDF
 */

/**
 * Backing-store scale used when the canvas has not been laid out yet (no
 * measurable width, as in a headless DOM). Otherwise the scale is derived from
 * the size the canvas actually renders at (see {@link renderPage}), so a page
 * is neither upscaled into blur where the canvas is capped narrow (the chat
 * column, the drawer) nor rendered short of the device's pixels.
 */
const FALLBACK_SCALE = 1.5;

/**
 * Ceiling on the derived scale. Every rendered page keeps its canvas mounted,
 * so the backing store is paid for the life of the preview and a 3x display on
 * a wide viewport would spend hundreds of megabytes to sharpen text that is
 * already past what the eye resolves.
 */
const MAX_SCALE = 2;

const MAX_PAGES = 20;

let pdfJsConfigured = false;

async function loadPdfJs() {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  if (!pdfJsConfigured) {
    pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER_URL;
    pdfJsConfigured = true;
  }
  return pdfjs;
}

interface PdfPreviewProps {
  url: string;
  className?: string;
  /**
   * Shown when the document cannot be read. The surfaces this renders on
   * present failure differently (a card over the modal's dark backdrop, a
   * compact row in the drawer) and each already owns a component that does
   * it, so the choice, and the wording, belong to the caller.
   */
  errorFallback: ReactNode;
}

export function PdfPreview({ url, className, errorFallback }: PdfPreviewProps) {
  const { t } = useTranslation("chat");
  // Spans with block/flex classes rather than divs: the preview also renders
  // inline in chat markdown, where a div inside <p> is invalid HTML.
  const containerRef = useRef<HTMLSpanElement>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  // Width/height of page 1, stamped onto each canvas as it mounts so the box
  // holds a page's shape before anything is drawn into it: a canvas has no
  // intrinsic size until `renderPage` runs, so the row would otherwise
  // collapse to the 2:1 default and reflow again as each page arrives. Held
  // in a ref, not state, because only the imperative mount/render pair reads
  // it: React never owns `aspectRatio`, so it cannot re-apply the placeholder
  // over the real dimensions `renderPage` sets.
  const placeholderAspectRatio = useRef<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const canvasRefs = useRef<Map<number, HTMLCanvasElement>>(new Map());
  const renderedPages = useRef<Set<number>>(new Set());

  // Load the PDF document
  useEffect(() => {
    let cancelled = false;

    async function load() {
      setIsLoading(true);
      setFailed(false);
      setPdf(null);
      setNumPages(0);
      placeholderAspectRatio.current = null;
      renderedPages.current.clear();

      try {
        const pdfjs = await loadPdfJs();

        let source: string | { data: Uint8Array };
        if (url.startsWith("data:")) {
          const bytes = dataUriToUint8Array(url);
          source = bytes ? { data: bytes } : url;
        } else {
          source = url;
        }

        const doc = await pdfjs.getDocument(source).promise;
        if (cancelled) {
          void doc.destroy();
          return;
        }
        // The proxy stays this function's to release until it is handed to
        // state: the cleanup effect only destroys what it sees replaced or
        // unmounted, so a document abandoned here would hold its worker for
        // as long as the error state is on screen.
        let firstPage;
        try {
          firstPage = await doc.getPage(1);
        } catch (pageError) {
          void doc.destroy();
          throw pageError;
        }
        if (cancelled) {
          void doc.destroy();
          return;
        }

        const { width, height } = firstPage.getViewport({ scale: 1 });
        placeholderAspectRatio.current = height > 0 ? width / height : null;
        setPdf(doc);
        setNumPages(Math.min(doc.numPages, MAX_PAGES));
      } catch {
        if (!cancelled) {
          setFailed(true);
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [url]);

  // Clean up PDF document on unmount or url change
  useEffect(() => {
    return () => {
      if (pdf) {
        void pdf.destroy();
      }
    };
  }, [pdf]);

  const renderPage = useCallback(
    async (pageNum: number) => {
      if (!pdf || renderedPages.current.has(pageNum)) {
        return;
      }

      const canvas = canvasRefs.current.get(pageNum);
      if (!canvas) {
        return;
      }

      renderedPages.current.add(pageNum);

      try {
        const page = await pdf.getPage(pageNum);
        // Match the backing store to the size the canvas is actually rendered
        // at: callers cap its CSS width (the chat column, the drawer) and a
        // fixed scale would either blur on a retina display or waste memory.
        const cssWidth = canvas.clientWidth;
        const reportedDpr =
          typeof window === "undefined" ? 1 : window.devicePixelRatio;
        const dpr = reportedDpr > 0 ? reportedDpr : 1;
        const scale =
          cssWidth > 0
            ? Math.min(
                (cssWidth * dpr) / page.getViewport({ scale: 1 }).width,
                MAX_SCALE,
              )
            : FALLBACK_SCALE;
        const viewport = page.getViewport({ scale });

        canvas.width = viewport.width;
        canvas.height = viewport.height;
        // The placeholder ratio is page 1's, a stand-in for a box with
        // nothing in it yet. This page now carries its own dimensions, so
        // drop the override and let them drive the height: a document mixing
        // portrait and landscape pages would otherwise stretch every page
        // after the first into page 1's shape.
        canvas.style.aspectRatio = "";

        await page.render({ canvas, viewport }).promise;
      } catch {
        renderedPages.current.delete(pageNum);
      }
    },
    [pdf],
  );

  // Use IntersectionObserver for lazy page rendering instead of scroll events.
  // Avoids layout thrashing from getBoundingClientRect on every scroll tick.
  // @see https://developer.mozilla.org/en-US/docs/Web/API/Intersection_Observer_API
  useEffect(() => {
    if (!pdf || numPages === 0) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) {
            continue;
          }
          const pageNum = Number((entry.target as HTMLElement).dataset.page);
          if (pageNum) {
            void renderPage(pageNum);
          }
        }
      },
      { root: containerRef.current, rootMargin: "200px" },
    );

    canvasRefs.current.forEach((canvas) => observer.observe(canvas));
    return () => observer.disconnect();
  }, [pdf, numPages, renderPage]);

  const setCanvasRef = useCallback(
    (pageNum: number) => (el: HTMLCanvasElement | null) => {
      if (el) {
        canvasRefs.current.set(pageNum, el);
        // Only ever a stand-in for an empty box. This callback's identity
        // changes every render, so React detaches and reattaches the ref on
        // a canvas that has already been drawn into, and re-stamping the
        // placeholder there would stretch it back to page 1's shape with no
        // second `renderPage` coming to clear it.
        if (
          placeholderAspectRatio.current !== null &&
          !renderedPages.current.has(pageNum)
        ) {
          el.style.aspectRatio = String(placeholderAspectRatio.current);
        }
      } else {
        canvasRefs.current.delete(pageNum);
      }
    },
    [],
  );

  if (isLoading) {
    return (
      <span className="flex justify-center">
        {/* Matches the canvases' own width cap, so the placeholder occupies
            the box the pages will. Callers that size pages differently (the
            drawer) override it the same way they override the canvases. */}
        <PdfPageSkeleton className="w-[90vw] max-w-[800px]" />
      </span>
    );
  }

  if (failed) {
    return errorFallback;
  }

  return (
    <span
      ref={containerRef}
      className={`flex max-h-[80vh] flex-col items-center gap-2 overflow-y-auto rounded ${className ?? ""}`}
    >
      {Array.from({ length: numPages }, (_, i) => (
        <canvas
          key={i + 1}
          ref={setCanvasRef(i + 1)}
          data-page={i + 1}
          className="w-[90vw] max-w-[800px]"
          style={{ height: "auto" }}
        />
      ))}
      {/* `numPages` is what MAX_PAGES allows; the proxy knows what the
          document actually holds, and the gap is what is not being shown. */}
      {pdf !== null && pdf.numPages > numPages && (
        <PreviewTruncationNotice as="span">
          {t("pdfPreview.pageCapNotice", { count: numPages })}
        </PreviewTruncationNotice>
      )}
    </span>
  );
}
