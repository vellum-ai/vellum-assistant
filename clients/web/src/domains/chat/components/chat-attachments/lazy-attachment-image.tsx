import { FileImage, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import { useLazyAttachmentDisplayPreview } from "@/domains/chat/components/chat-attachments/use-lazy-attachment-display-preview";

interface LazyAttachmentImageProps {
  assistantId?: string | null;
  attachmentId: string;
  filename: string;
  inlinePreviewUrl: string | null;
  size: "inline" | "square";
  testId?: string;
  onError?: () => void;
}

const SIZE_CLASS = {
  inline: "h-64 w-64 sm:w-96",
  square: "h-16 w-16",
} as const;

/**
 * Stable-geometry image slot backed by a viewport-lazy display representation.
 * The slot dimensions are identical before and after image resolution, which
 * prevents transcript scroll jumps as previews finish loading.
 */
export function LazyAttachmentImage(props: LazyAttachmentImageProps) {
  if (props.inlinePreviewUrl) {
    return (
      <AttachmentImageSlot
        {...props}
        elementRef={undefined}
        previewUrl={props.inlinePreviewUrl}
        isLoading={false}
        isError={false}
      />
    );
  }
  if (
    !props.assistantId ||
    !props.attachmentId ||
    props.attachmentId.startsWith("rehydrated:")
  ) {
    return (
      <AttachmentImageSlot
        {...props}
        elementRef={undefined}
        previewUrl={null}
        isLoading={false}
        isError
      />
    );
  }
  return <RemoteAttachmentImage {...props} />;
}

function RemoteAttachmentImage(props: LazyAttachmentImageProps) {
  const { assistantId, attachmentId, onError } = props;
  const {
    elementRef,
    previewUrl,
    isLoading,
    isError,
  } = useLazyAttachmentDisplayPreview({
    assistantId,
    attachmentId,
    inlinePreviewUrl: null,
  });

  useEffect(() => {
    if (isError) {
      onError?.();
    }
  }, [isError, onError]);

  return (
    <AttachmentImageSlot
      {...props}
      elementRef={elementRef}
      previewUrl={previewUrl}
      isLoading={isLoading}
      isError={isError}
    />
  );
}

interface AttachmentImageSlotProps extends LazyAttachmentImageProps {
  elementRef: ((node: Element | null) => void) | undefined;
  previewUrl: string | null;
  isLoading: boolean;
  isError: boolean;
}

function AttachmentImageSlot({
  filename,
  size,
  testId = "lazy-attachment-image",
  onError,
  elementRef,
  previewUrl,
  isLoading,
  isError,
}: AttachmentImageSlotProps) {
  const [decodeFailedUrl, setDecodeFailedUrl] = useState<string | null>(null);
  const usablePreviewUrl = previewUrl === decodeFailedUrl ? null : previewUrl;

  return (
    <div
      ref={elementRef}
      data-testid={`${testId}-slot`}
      data-preview-state={
        usablePreviewUrl
          ? "ready"
          : isLoading
          ? "loading"
          : isError
          ? "error"
          : "idle"
      }
      className={`flex shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[var(--surface-lift)] text-[var(--content-secondary)] ${SIZE_CLASS[size]}`}
    >
      {usablePreviewUrl ? (
        <img
          data-testid={testId}
          src={usablePreviewUrl}
          alt={filename}
          onError={() => {
            setDecodeFailedUrl(usablePreviewUrl);
            onError?.();
          }}
          className={`h-full w-full ${
            size === "square" ? "object-cover" : "object-contain"
          }`}
        />
      ) : isLoading ? (
        <Loader2
          data-testid={`${testId}-placeholder`}
          className="h-6 w-6 animate-spin text-[var(--content-tertiary)]"
        />
      ) : (
        <FileImage data-testid={`${testId}-placeholder`} className="h-6 w-6" />
      )}
    </div>
  );
}
