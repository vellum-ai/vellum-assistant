
import type { Highlighter } from "shiki";

import { Download, Loader2 } from "lucide-react";
import type { FC, ReactNode } from "react";
import { useEffect, useState } from "react";

import { Button } from "@vellumai/design-library";

/**
 * Hard cap on the number of text bytes we render inline. Anything beyond this
 * triggers the "too large" fallback — Shiki tokenizing megabytes of text on
 * the main thread will lock the UI.
 */
export const MAX_TEXT_PREVIEW_BYTES = 200 * 1024;

const BUNDLED_LANGUAGES = [
  "typescript",
  "javascript",
  "python",
  "json",
  "markdown",
  "bash",
  "html",
  "css",
  "yaml",
] as const;

const FALLBACK_LANGUAGE = "text";

const EXTENSION_TO_LANGUAGE: Record<string, (typeof BUNDLED_LANGUAGES)[number]> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  py: "python",
  json: "json",
  md: "markdown",
  sh: "bash",
  bash: "bash",
  html: "html",
  css: "css",
  yaml: "yaml",
  yml: "yaml",
};

const inferLanguage = (filename: string): string => {
  const dot = filename.lastIndexOf(".");
  if (dot === -1 || dot === filename.length - 1) return FALLBACK_LANGUAGE;
  const ext = filename.slice(dot + 1).toLowerCase();
  return EXTENSION_TO_LANGUAGE[ext] ?? FALLBACK_LANGUAGE;
};

// Singleton highlighter — Shiki ships ~100KB+ of WASM/grammar payload, and
// `createHighlighter` reparses it on every call. One per page-load is plenty.
let highlighterPromise: Promise<Highlighter> | null = null;

const getHighlighter = async (): Promise<Highlighter> => {
  if (!highlighterPromise) {
    highlighterPromise = import("shiki").then(({ createHighlighter }) =>
      createHighlighter({
        langs: [...BUNDLED_LANGUAGES],
        themes: ["github-dark", "github-light"],
      }),
    );
  }
  return highlighterPromise;
};

interface TextPreviewProps {
  url: string;
  filename: string;
  mimeType: string;
}

/**
 * Inline preview for text/code attachments. Fetches the file, picks a Shiki
 * language identifier from the file extension, and renders the highlighted
 * HTML inside a scrollable monospace container.
 *
 * Reads `prefers-color-scheme` once on mount to choose between the
 * `github-dark` and `github-light` Shiki themes.
 *
 * Files larger than `MAX_TEXT_PREVIEW_BYTES` short-circuit to a download
 * fallback to keep the UI thread responsive.
 */
export const TextPreview: FC<TextPreviewProps> = ({ url, filename, mimeType: _mimeType }) => {
  const [html, setHtml] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tooLarge, setTooLarge] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setIsLoading(true);
      setError(null);
      setHtml(null);
      setTooLarge(false);

      try {
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`Failed to load file: ${response.statusText}`);
        }

        const blob = await response.blob();
        if (cancelled) return;

        if (blob.size > MAX_TEXT_PREVIEW_BYTES) {
          setTooLarge(true);
          setIsLoading(false);
          return;
        }

        const text = await blob.text();
        if (cancelled) return;

        const prefersDark =
          typeof window !== "undefined" &&
          typeof window.matchMedia === "function" &&
          window.matchMedia("(prefers-color-scheme: dark)").matches;
        const theme = prefersDark ? "github-dark" : "github-light";

        const highlighter = await getHighlighter();
        if (cancelled) return;

        const lang = inferLanguage(filename);
        const highlighted = highlighter.codeToHtml(text, { lang, theme });
        if (cancelled) return;

        setHtml(highlighted);
      } catch {
        if (!cancelled) {
          setError("Failed to load preview.");
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [url, filename]);

  const handleDownload = async () => {
    const { saveFile } = await import("@/runtime/native-file");
    await saveFile(url, filename);
  };

  const renderFallbackCard = (message: string): ReactNode => (
    <div
      className="w-full max-w-sm rounded-lg border p-8 text-center"
      style={{
        borderColor: "var(--border-base)",
        backgroundColor: "var(--surface-lift)",
      }}
    >
      <p className="text-body-medium-lighter text-white/80">{message}</p>
      <Button
        variant="ghost"
        leftIcon={<Download />}
        onClick={handleDownload}
        aria-label={`Download ${filename}`}
        className="mt-4 text-white/70 hover:bg-white/10 hover:text-white"
        tintColor="currentColor"
      >
        Download
      </Button>
    </div>
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-8 w-8 animate-spin text-white/70" />
      </div>
    );
  }

  if (tooLarge) return renderFallbackCard("File too large to preview inline.");
  if (error) return renderFallbackCard(error);

  return (
    <div
      // typography: off-scale — verbatim source code rendering
       
      className="max-h-[80vh] max-w-[90vw] overflow-auto rounded bg-[var(--surface-base)] p-4 font-mono text-xs"
      dangerouslySetInnerHTML={html ? { __html: html } : undefined}
    />
  );
};
