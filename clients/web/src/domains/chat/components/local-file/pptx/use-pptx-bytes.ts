/**
 * Decode a cached workspace file into the `Uint8Array` `PowerPointViewer` takes.
 *
 * The transcript's file reads are cached as `Blob`s under the key the inline
 * embeds already use, so both the drawer preview and the full-screen editor get
 * their bytes from the same cache entry and neither refetches what the other
 * has already pulled. This hook owns only the decode, so the two surfaces also
 * share one definition of "still decoding" and one of "that didn't work".
 *
 * The decode is memoised on blob identity rather than done in the query's
 * `select`: React Query re-runs `select` on every subscriber render, and a
 * multi-megabyte `arrayBuffer()` is not something to repeat for a re-render.
 */

import { useEffect, useState } from "react";

export type PptxBytesState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; bytes: Uint8Array };

/** Decode `blob` to PowerPoint bytes. `undefined` parks the hook in `loading`. */
export function usePptxBytes(blob: Blob | undefined): PptxBytesState {
  const [decoded, setDecoded] = useState<{
    blob: Blob;
    bytes: Uint8Array;
  } | null>(null);
  const [decodeFailed, setDecodeFailed] = useState(false);

  useEffect(() => {
    if (blob === undefined) {
      return;
    }
    let cancelled = false;
    setDecodeFailed(false);
    void blob
      .arrayBuffer()
      .then((buffer) => {
        if (!cancelled) {
          setDecoded({ blob, bytes: new Uint8Array(buffer) });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDecodeFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [blob]);

  if (decodeFailed) {
    return { status: "error" };
  }
  // Guard on blob identity: switching to a different presentation must not show
  // the previous one's slides while the new bytes are still decoding.
  if (blob === undefined || decoded === null || decoded.blob !== blob) {
    return { status: "loading" };
  }
  return { status: "ready", bytes: decoded.bytes };
}
