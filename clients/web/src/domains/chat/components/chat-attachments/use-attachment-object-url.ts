/**
 * A displayable URL for one attachment's bytes.
 *
 * An attachment that already carries its content inline resolves to that URL
 * with no daemon round trip. A metadata-only attachment (a real id and a null
 * `previewUrl`) fetches its bytes once and holds them as an object URL, revoked
 * when the blob changes or the caller unmounts.
 *
 * The cache key is the one `AttachmentPreviewModal` reads, so a thumbnail that
 * has already loaded hands the modal a cache hit instead of a second request.
 */

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { fetchAttachmentContentBlob } from "@/domains/chat/components/chat-attachments/download-attachment";
import type { DisplayAttachment } from "@/types/attachment-types";

export interface AttachmentObjectUrl {
  /** The inline preview URL, the fetched object URL, or null until one exists. */
  url: string | null;
  isError: boolean;
}

export function useAttachmentObjectUrl(
  assistantId: string | null | undefined,
  attachment: Pick<DisplayAttachment, "id" | "previewUrl">,
  /** Fetch only while true (the tile is on screen). */
  enabled: boolean,
): AttachmentObjectUrl {
  const { id, previewUrl } = attachment;
  // Synthetic `rehydrated:` ids from the text-parsing history fallback can
  // never resolve against the content endpoint, so they are never fetched.
  const shouldFetch =
    enabled &&
    !previewUrl &&
    !!assistantId &&
    !!id &&
    !id.startsWith("rehydrated:");

  const { data: blob, isError } = useQuery({
    queryKey: ["attachmentContent", assistantId, id],
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

  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) {
      setObjectUrl(null);
      return;
    }
    const url = URL.createObjectURL(blob);
    setObjectUrl(url);
    return () => {
      URL.revokeObjectURL(url);
      setObjectUrl(null);
    };
  }, [blob]);

  return { url: previewUrl ?? objectUrl, isError };
}
