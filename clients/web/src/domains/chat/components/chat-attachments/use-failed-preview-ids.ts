import { useCallback, useState } from "react";

interface UseFailedPreviewIdsResult {
  /** Keys whose preview the browser could not decode. */
  failedIds: ReadonlySet<string>;
  /** Records a key whose preview failed to decode. */
  markFailed: (key: string) => void;
}

/**
 * The identity one attachment entry is listed and remembered under.
 *
 * A message can hold two entries under one id (the history fallback rehydrates
 * every row it recovers as `rehydrated:0`), so position joins it. The list
 * renders under the same key, so the two cannot disagree.
 */
export function previewEntryKey(id: string, index: number): string {
  return `${index}:${id}`;
}

/**
 * The set of attachment keys whose image preview the browser could not decode
 * (a TIFF, or a HEIF whose conversion fell back), for the surfaces that swap a
 * dead picture for something that still names the file.
 *
 * Keys are never reused, and the set is bounded by the attachments one surface
 * shows, so nothing prunes it.
 */
export function useFailedPreviewIds(): UseFailedPreviewIdsResult {
  const [failedIds, setFailedIds] = useState<ReadonlySet<string>>(new Set());
  const markFailed = useCallback((key: string) => {
    setFailedIds((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
  }, []);

  return { failedIds, markFailed };
}
