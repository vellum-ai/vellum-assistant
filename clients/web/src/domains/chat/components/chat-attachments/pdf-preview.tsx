import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";

import { dataUriToUint8Array } from "@/domains/chat/components/chat-attachments/utils";

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
    pdfjs.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjs.version}/legacy/build/pdf.worker.min.mjs`;
    pdfJsConfigured = true;
  }
  return pdfjs;
}

interface PdfPreviewProps {
  url: string;
  className?: string;
}

export function PdfPreview({ url, className }: PdfPreviewProps) {
  // Spans with block/flex classes rather than divs: the preview also renders
  // inline in chat markdown, where a div inside <p> is invalid HTML.
  const containerRef = useRef<HTMLSpanElement>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const canvasRefs = useRef<Map<number, HTMLCanvasElement>>(new Map());
  const renderedPages = useRef<Set<number>>(new Set());

  // Load the PDF document
  useEffect(() => {
    let cancelled = false;

    async function load() {
      setIsLoading(true);
      setError(null);
      setPdf(null);
      setNumPages(0);
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
        setPdf(doc);
        setNumPages(Math.min(doc.numPages, MAX_PAGES));
      } catch {
        if (!cancelled) {
          setError("Failed to load PDF.");
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
      } else {
        canvasRefs.current.delete(pageNum);
      }
    },
    [],
  );

  if (isLoading) {
    return (
      <span className="flex items-center justify-center py-24">
        <Loader2 className="h-8 w-8 animate-spin text-white/70" />
      </span>
    );
  }

  if (error) {
    return (
      <span className="block w-full max-w-sm rounded-lg border border-white/15 bg-white/[0.08] p-8 text-center">
        <span className="text-body-medium-lighter block text-white/80">
          {error}
        </span>
      </span>
    );
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
    </span>
  );
}
