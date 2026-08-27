import { useCallback, useState } from "react";

interface UseFailedPreviewIdsResult {
  /** Ids whose preview the browser could not decode. */
  failedIds: ReadonlySet<string>;
  /** Records an id whose preview failed to decode. */
  markFailed: (id: string) => void;
}

/**
 * The set of attachment ids whose image preview the browser could not decode (a
 * TIFF, or a HEIF whose conversion fell back), for the surfaces that swap a
 * dead picture for something that still names the file.
 *
 * Ids are never reused, and the set is bounded by the attachments one surface
 * shows, so nothing prunes it.
 */
export function useFailedPreviewIds(): UseFailedPreviewIdsResult {
  const [failedIds, setFailedIds] = useState<ReadonlySet<string>>(new Set());
  const markFailed = useCallback((id: string) => {
    setFailedIds((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  }, []);

  return { failedIds, markFailed };
}
