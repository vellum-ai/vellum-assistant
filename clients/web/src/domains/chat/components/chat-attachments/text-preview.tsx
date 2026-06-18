import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useMemo } from "react";

import { FileMarkdown, isMarkdown } from "@/components/file-markdown";
import { PreviewMessageCard } from "@/domains/chat/components/chat-attachments/preview-message-card";
import { captureError } from "@/lib/sentry/capture-error";

/**
 * Largest text payload rendered inline. Larger files fall back to a download
 * affordance so a multi-megabyte file can't block the main thread while it
 * parses.
 */
export const MAX_TEXT_PREVIEW_BYTES = 200 * 1024;

/** Signals that a file is past {@link MAX_TEXT_PREVIEW_BYTES} — an expected
 *  outcome shown to the user, not a fault worth reporting to telemetry. */
class TextTooLargeError extends Error {}

async function loadText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load file: ${response.status}`);
  }
  const blob = await response.blob();
  if (blob.size > MAX_TEXT_PREVIEW_BYTES) {
    throw new TextTooLargeError();
  }
  return blob.text();
}

/** Small djb2 string hash → non-negative int. Derives a short, stable cache
 *  key from a preview URL that may be a multi-megabyte base64 `data:` URI. */
function hashString(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 33) ^ str.charCodeAt(i);
  }
  return Math.abs(hash);
}

interface TextPreviewProps {
  url: string;
  filename: string;
  mimeType: string;
}

/**
 * Inline preview for a text attachment inside the full-screen preview modal.
 * Markdown renders as formatted document content; every other text type
 * renders as monospace source. Content sits on a themed surface so it stays
 * legible on the modal's dark backdrop across light, dark, and velvet themes.
 */
export function TextPreview({ url, filename, mimeType }: TextPreviewProps) {
  // Content-derived cache key. The URL uniquely identifies the bytes (an inline
  // attachment's URL is the file itself, as a base64 `data:` URI), so hashing it
  // avoids two distinct files colliding — the attachment id falls back to
  // `filename` for inline drafts (display-attachments.ts) and isn't unique. We
  // hash once (memoized) rather than key by the raw URL, so React Query never
  // re-serializes a multi-megabyte data URI on every render.
  const contentKey = useMemo(() => hashString(url), [url]);

  const { data, isLoading, error } = useQuery({
    queryKey: ["attachment-text-preview", contentKey],
    queryFn: async () => {
      try {
        return await loadText(url);
      } catch (err) {
        if (!(err instanceof TextTooLargeError)) {
          captureError(err, {
            context: "attachment-text-preview",
            bestEffort: true,
          });
        }
        throw err;
      }
    },
    // A successful read never needs revalidating (immutable bytes).
    staleTime: Infinity,
    retry: false,
  });

  const handleDownload = async () => {
    const { saveFile } = await import("@/runtime/native-file");
    await saveFile(url, filename);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-8 w-8 animate-spin text-white/70" />
      </div>
    );
  }

  if (error) {
    return (
      <PreviewMessageCard
        message={
          error instanceof TextTooLargeError
            ? "File too large to preview inline."
            : "Failed to load preview."
        }
        filename={filename}
        onDownload={handleDownload}
      />
    );
  }

  if (data == null) {
    return null;
  }

  return (
    <div
      className="max-h-[80vh] w-[min(90vw,800px)] overflow-auto rounded-lg p-6"
      style={{
        backgroundColor: "var(--surface-overlay)",
        color: "var(--content-default)",
      }}
    >
      <TextPreviewBody text={data} filename={filename} mimeType={mimeType} />
    </div>
  );
}

interface TextPreviewBodyProps {
  text: string;
  filename: string;
  mimeType: string;
}

/**
 * Resolved-content renderer: formatted markdown for markdown files, monospace
 * source for everything else. Pure and exported so the markdown-vs-source
 * decision can be unit-tested without the surrounding data fetch.
 */
export function TextPreviewBody({
  text,
  filename,
  mimeType,
}: TextPreviewBodyProps) {
  if (isMarkdown(filename, mimeType)) {
    return <FileMarkdown content={text} />;
  }
  return (
    <pre className="whitespace-pre-wrap break-words font-mono text-body-small-default">
      {text}
    </pre>
  );
}
