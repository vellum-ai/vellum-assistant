import { useQuery } from "@tanstack/react-query";
import {
  type RefCallback,
  useCallback,
  useEffect,
  useState,
} from "react";

import { fetchAttachmentContentBlob } from "@/domains/chat/components/chat-attachments/download-attachment";

const PREVIEW_ROOT_MARGIN = "400px 0px";

interface UseLazyAttachmentDisplayPreviewParams {
  assistantId?: string | null;
  attachmentId: string;
  inlinePreviewUrl: string | null;
  enabled?: boolean;
}

interface LazyAttachmentDisplayPreview {
  elementRef: RefCallback<Element>;
  previewUrl: string | null;
  isLoading: boolean;
  isError: boolean;
}

/**
 * Loads an authenticated browser-displayable attachment representation once
 * its element nears the viewport. Inline legacy previews bypass the request.
 * Pending requests consume TanStack Query's AbortSignal, and fetched object
 * URLs are revoked whenever their blob changes or the consumer unmounts.
 */
export function useLazyAttachmentDisplayPreview({
  assistantId,
  attachmentId,
  inlinePreviewUrl,
  enabled = true,
}: UseLazyAttachmentDisplayPreviewParams): LazyAttachmentDisplayPreview {
  const [element, setElement] = useState<Element | null>(null);
  const [isNearViewport, setIsNearViewport] = useState(false);
  const elementRef = useCallback<RefCallback<Element>>((node) => {
    setElement(node);
  }, []);

  const canFetch =
    enabled &&
    inlinePreviewUrl == null &&
    !!assistantId &&
    !!attachmentId &&
    !attachmentId.startsWith("rehydrated:");

  useEffect(() => {
    if (!canFetch || !element || isNearViewport) {
      return;
    }
    if (typeof IntersectionObserver === "undefined") {
      setIsNearViewport(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setIsNearViewport(true);
          observer.disconnect();
        }
      },
      { rootMargin: PREVIEW_ROOT_MARGIN },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [canFetch, element, isNearViewport]);

  const query = useQuery({
    queryKey: ["attachmentContent", "display", assistantId, attachmentId],
    queryFn: async ({ signal }) => {
      const blob = await fetchAttachmentContentBlob(assistantId!, attachmentId, {
        representation: "display",
        signal,
      });
      if (!blob) {
        throw new Error("Failed to load image preview");
      }
      return blob;
    },
    enabled: canFetch && isNearViewport,
    staleTime: Infinity,
    gcTime: 5 * 60 * 1000,
    retry: false,
  });

  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!query.data) {
      setObjectUrl(null);
      return;
    }
    const url = URL.createObjectURL(query.data);
    setObjectUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [query.data]);

  return {
    elementRef,
    previewUrl: inlinePreviewUrl ?? objectUrl,
    isLoading: canFetch && isNearViewport && !objectUrl && !query.isError,
    isError: inlinePreviewUrl == null && (!canFetch || query.isError),
  };
}
