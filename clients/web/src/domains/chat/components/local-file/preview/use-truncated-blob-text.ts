/**
 * Decode at most `capBytes` of a blob as UTF-8 text, for previews that show
 * the head of a file rather than all of it.
 *
 * The cap is applied to the blob before decoding, so a file larger than the
 * display ceiling is never fully decoded just to be cut afterwards. A byte cap
 * can split a multi-byte UTF-8 sequence at the boundary; the replacement
 * character that decoding produces there is stripped so a truncated file never
 * ends in mojibake.
 */

import { useEffect, useMemo, useState } from "react";

export interface TruncatedBlobText {
  /** Decoded head of the file, or `null` while decoding. */
  text: string | null;
  /** Whether the file is larger than the cap and was cut. */
  truncated: boolean;
  /** Whether decoding failed outright. */
  decodeFailed: boolean;
}

/**
 * The slice of `blob` the preview decodes, and whether anything was left off.
 * Pure and exported so the boundary can be tested without a DOM.
 */
export function truncateBlobForDisplay(
  blob: Blob,
  capBytes: number,
): { blob: Blob; truncated: boolean } {
  if (blob.size <= capBytes) {
    return { blob, truncated: false };
  }
  return { blob: blob.slice(0, capBytes), truncated: true };
}

export function useTruncatedBlobText(
  blob: Blob,
  capBytes: number,
): TruncatedBlobText {
  const [text, setText] = useState<string | null>(null);
  const [decodeFailed, setDecodeFailed] = useState(false);

  const shown = useMemo(
    () => truncateBlobForDisplay(blob, capBytes),
    [blob, capBytes],
  );

  useEffect(() => {
    let cancelled = false;
    setText(null);
    setDecodeFailed(false);
    // `Blob.text()` decodes as UTF-8, which is what the daemon writes and what
    // every other text surface in the app assumes.
    shown.blob.text().then(
      (decoded) => {
        if (!cancelled) {
          setText(shown.truncated ? decoded.replace(/�$/, "") : decoded);
        }
      },
      () => {
        if (!cancelled) {
          setDecodeFailed(true);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [shown]);

  return { text, truncated: shown.truncated, decodeFailed };
}
