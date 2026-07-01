import { useEffect, useMemo, useRef, useState } from "react";

export const STREAMING_THINKING_PREVIEW_UPDATE_INTERVAL_MS = 2_000;

export function firstSentenceOfLatestThinkingParagraph(
  text: string,
): string | null {
  const latestParagraph = text
    .split(/\n\s*\n/g)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .at(-1);
  if (!latestParagraph) return null;

  const normalized = latestParagraph.replace(/\s+/g, " ");
  const sentencePeriod = normalized.match(/\.(?=\s|$)/);
  const periodIndex = sentencePeriod?.index;
  if (periodIndex == null) return null;
  return normalized.slice(0, periodIndex + 1).trim() || null;
}

export function useStreamingThinkingPreview(
  content: string,
  isStreaming: boolean,
): string | null {
  const nextPreview = useMemo(
    () => firstSentenceOfLatestThinkingParagraph(content),
    [content],
  );
  const [displayedPreview, setDisplayedPreview] = useState(nextPreview);
  const updatedAtRef = useRef<number | null>(null);

  useEffect(() => {
    const now = Date.now();
    if (!isStreaming) {
      updatedAtRef.current = now;
      setDisplayedPreview(nextPreview);
      return;
    }

    updatedAtRef.current ??= now;

    if (!nextPreview) return;

    if (nextPreview === displayedPreview) return;

    if (!displayedPreview) {
      updatedAtRef.current = now;
      setDisplayedPreview(nextPreview);
      return;
    }

    const elapsedMs = now - updatedAtRef.current;
    if (elapsedMs >= STREAMING_THINKING_PREVIEW_UPDATE_INTERVAL_MS) {
      updatedAtRef.current = now;
      setDisplayedPreview(nextPreview);
      return;
    }

    const waitMs = Math.max(
      0,
      STREAMING_THINKING_PREVIEW_UPDATE_INTERVAL_MS - elapsedMs,
    );
    const timeoutId = setTimeout(() => {
      updatedAtRef.current = Date.now();
      setDisplayedPreview(nextPreview);
    }, waitMs);

    return () => clearTimeout(timeoutId);
  }, [displayedPreview, isStreaming, nextPreview]);

  return isStreaming ? displayedPreview : null;
}
