import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import { FileMarkdown, isMarkdown } from "@/components/file-markdown";
import { PreviewMessageCard } from "@/domains/chat/components/chat-attachments/preview-message-card";
import { dataUriToUint8Array } from "@/domains/chat/components/chat-attachments/utils";
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

/**
 * Read an attachment's text. By the time the preview renders, `url` is always a
 * *local* handle, so this never touches the network: inline attachments arrive
 * as a base64 `data:` URI (the bytes are already in memory, so decode them
 * directly), and daemon-backed attachments arrive as a `blob:` object URL the
 * modal already fetched.
 */
async function loadText(
  url: string,
  sizeBytes: number,
  signal: AbortSignal,
): Promise<string> {
  // The attachment's size is already known, so gate on it directly rather than
  // measuring the content — this also skips the read entirely for a file we
  // already know is too big to preview inline.
  if (sizeBytes > MAX_TEXT_PREVIEW_BYTES) {
    throw new TextTooLargeError();
  }

  if (url.startsWith("data:")) {
    const bytes = dataUriToUint8Array(url);
    if (!bytes) throw new Error("Malformed data URI");
    return new TextDecoder().decode(bytes);
  }

  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`Failed to load file: ${response.status}`);
  }
  const blob = await response.blob();
  // `sizeBytes` is optional upstream for file-backed attachments, so re-check
  // the fetched blob's exact size as the authoritative backstop.
  if (blob.size > MAX_TEXT_PREVIEW_BYTES) {
    throw new TextTooLargeError();
  }
  return blob.text();
}

interface TextPreviewProps {
  url: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; tooLarge: boolean }
  | { status: "ready"; text: string };

/**
 * Inline preview for a text attachment inside the full-screen preview modal.
 * Markdown renders as formatted document content; every other text type
 * renders as monospace source. Content sits on a themed surface so it stays
 * legible on the modal's dark backdrop across light, dark, and velvet themes.
 */
export function TextPreview({
  url,
  filename,
  mimeType,
  sizeBytes,
}: TextPreviewProps) {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  // Read the local URL straight into component state. This is deliberately not
  // a React Query fetch: the bytes are already in the browser (an inline
  // `data:` URI, or a `blob:` URL the modal already fetched), so there is no
  // server state to cache/revalidate — caching it only forced a content-derived
  // query key that can't be both short and collision-free.
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });

    loadText(url, sizeBytes, controller.signal)
      .then((text) => {
        if (!controller.signal.aborted) setState({ status: "ready", text });
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        const tooLarge = err instanceof TextTooLargeError;
        if (!tooLarge) {
          captureError(err, {
            context: "attachment-text-preview",
            bestEffort: true,
          });
        }
        setState({ status: "error", tooLarge });
      });

    return () => controller.abort();
  }, [url, sizeBytes]);

  const handleDownload = async () => {
    const { saveFile } = await import("@/runtime/native-file");
    await saveFile(url, filename);
  };

  if (state.status === "loading") {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-8 w-8 animate-spin text-white/70" />
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <PreviewMessageCard
        message={
          state.tooLarge
            ? "File too large to preview inline."
            : "Failed to load preview."
        }
        filename={filename}
        onDownload={handleDownload}
      />
    );
  }

  return (
    <div
      className="max-h-[80vh] w-[min(90vw,800px)] overflow-auto rounded-lg p-6"
      style={{
        backgroundColor: "var(--surface-overlay)",
        color: "var(--content-default)",
      }}
    >
      <TextPreviewBody text={state.text} filename={filename} mimeType={mimeType} />
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
