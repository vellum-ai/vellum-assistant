import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { MessageAttachmentSquare } from "@/domains/chat/components/chat-attachments/message-attachment-square";
import type { ToolResultImage } from "@/domains/chat/components/chat-attachments/tool-result-images";
import { useAttachmentObjectUrl } from "@/domains/chat/components/chat-attachments/use-attachment-object-url";
import { useInView } from "@/hooks/use-in-view";

interface ActivityScreenshotTileProps {
  assistantId?: string | null;
  image: ToolResultImage;
  title: string;
  ariaLabel: string;
  onPreview: (trigger: HTMLElement | null) => void;
}

/** Captionless phase footer that lazily hydrates one computer screenshot. */
export function ActivityScreenshotTile({
  assistantId,
  image,
  title,
  ariaLabel,
  onPreview,
}: ActivityScreenshotTileProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const isOnScreen = useInView(containerRef);
  const isVisible = isOnScreen || typeof IntersectionObserver === "undefined";
  const { url, isError, isPending } = useAttachmentObjectUrl(
    assistantId,
    image,
    isVisible,
  );
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  useEffect(() => {
    setFailedUrl(null);
  }, [image.id, image.previewUrl]);

  const previewUrl = url === failedUrl ? null : url;
  const attachment = isPending
    ? null
    : { ...image, previewUrl: previewUrl ?? null };

  return (
    <div
      ref={containerRef}
      data-testid="activity-screenshot-tile"
      data-tool-call-id={image.toolCallId}
    >
      <MessageAttachmentSquare
        attachment={attachment}
        placeholder={
          !isError ? (
            <Loader2 className="h-6 w-6 animate-spin" aria-hidden="true" />
          ) : null
        }
        labels={{ title, ariaLabel, secondary: null }}
        hideCaptions
        onPreview={() =>
          onPreview(
            containerRef.current?.firstElementChild instanceof HTMLElement
              ? containerRef.current.firstElementChild
              : null,
          )
        }
        onPreviewError={() => setFailedUrl(url)}
      />
    </div>
  );
}
