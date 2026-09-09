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
 * The fetch runs under {@link attachmentContentQueryKey}, which
 * `AttachmentPreviewModal` fetches under too: the modal keeps its own query so
 * it can tell a legacy row apart from a failed fetch, but a thumbnail that has
 * already loaded hands it a cache hit instead of a second request.
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

export interface AttachmentObjectUrl {
  /** The inline preview URL, the fetched object URL, or null until one exists. */
  url: string | null;
  /** The bytes failed to load, or can never be fetched (no assistant, no resolvable id). */
  isError: boolean;
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
  const canFetch = !!assistantId && !!id && !id.startsWith("rehydrated:");
  const shouldFetch = enabled && !previewUrl && canFetch;
  // No inline bytes and no way to fetch them is a settled answer, not a
  // pending one, so callers can fall back instead of waiting.
  const unavailable = !!attachment && !previewUrl && !canFetch;

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

  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!shownBlob) {
      setObjectUrl(null);
      return;
    }
    const url = URL.createObjectURL(shownBlob);
    setObjectUrl(url);
    return () => {
      URL.revokeObjectURL(url);
      setObjectUrl(null);
    };
  }, [shownBlob]);

  return { url: previewUrl ?? objectUrl, isError: isError || unavailable };
}
