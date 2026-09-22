/**
 * A displayable URL for one attachment's bytes.
 *
 * An attachment that already carries its content inline resolves to that URL
 * with no daemon round trip. A metadata-only attachment (a real id and a null
 * `previewUrl`) fetches its bytes once and holds them as an object URL, revoked
 * when the blob changes or the caller unmounts. A null attachment resolves to
 * nothing at all, so a caller with an optional attachment still calls this
 * unconditionally.
 *
 * Every reader fetches under {@link attachmentContentQueryKey}, so a thumbnail,
 * the full-screen preview, and an inline markdown image of the same attachment
 * share one request and one cached blob.
 */

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { fetchAttachmentContentBlob } from "@/domains/chat/components/chat-attachments/download-attachment";
import type { DisplayAttachment } from "@/types/attachment-types";

/** Cache entry for one attachment's fetched bytes, shared by every reader. */
export function attachmentContentQueryKey(
  assistantId: string | null | undefined,
  attachmentId: string,
) {
  return ["attachmentContent", assistantId, attachmentId] as const;
}

interface AttachmentObjectUrl {
  /** The inline preview URL, the fetched object URL, or null until one exists. */
  url: string | null;
  /** The bytes failed to load, or can never be fetched (no assistant, no resolvable id). */
  isError: boolean;
  /** The bytes can never be fetched at all, as against a fetch that failed. */
  unavailable: boolean;
  /** The id is a synthetic `rehydrated:` one, so no bytes were ever stored. */
  legacyId: boolean;
  /** The bytes are still on their way, so nothing is settled yet. */
  isPending: boolean;
}

export function useAttachmentObjectUrl(
  assistantId: string | null | undefined,
  attachment: Pick<DisplayAttachment, "id" | "previewUrl"> | null,
  /** Fetch only while true (the tile is on screen). */
  enabled: boolean,
): AttachmentObjectUrl {
  const id = attachment?.id ?? "";
  const previewUrl = attachment?.previewUrl ?? null;
  // Synthetic `rehydrated:` ids from the text-parsing history fallback can
  // never resolve against the content endpoint, so they are never fetched.
  const isRehydratedId = id.startsWith("rehydrated:");
  const canFetch = !!assistantId && !!id && !isRehydratedId;
  const shouldFetch = enabled && !previewUrl && canFetch;
  // No inline bytes and no way to fetch them is a settled answer, not a
  // pending one, so callers can fall back instead of waiting.
  const unavailable = !!attachment && !previewUrl && !canFetch;
  // Narrower than `unavailable`: the bytes were never stored, rather than
  // merely being out of this caller's reach.
  const legacyId = !previewUrl && isRehydratedId;

  const { data: blob, isError } = useQuery({
    queryKey: attachmentContentQueryKey(assistantId, id),
    queryFn: async () => {
      const data = await fetchAttachmentContentBlob(assistantId!, id);
      if (!data) {
        throw new Error("Failed to load attachment content");
      }
      return data;
    },
    enabled: shouldFetch,
    staleTime: Infinity,
    retry: false,
  });

  // The cache answers whoever asks, so a blob another reader already fetched
  // arrives even here; hold it only while this caller would draw it, or the
  // object URL is minted for a picture nothing renders.
  const shownBlob = !previewUrl && enabled ? (blob ?? null) : null;

  // The URL is held with the blob it was minted from, so a caller that switches
  // attachments is never handed the previous one's picture for a frame.
  const [held, setHeld] = useState<{ blob: Blob; url: string } | null>(null);
  useEffect(() => {
    if (!shownBlob) {
      setHeld(null);
      return;
    }
    const url = URL.createObjectURL(shownBlob);
    setHeld({ blob: shownBlob, url });
    return () => {
      URL.revokeObjectURL(url);
      setHeld(null);
    };
  }, [shownBlob]);
  const objectUrl = held?.blob === shownBlob ? held.url : null;

  return {
    url: previewUrl ?? objectUrl,
    isError: isError || unavailable,
    unavailable,
    legacyId,
    isPending: shouldFetch && !objectUrl && !isError,
  };
}
