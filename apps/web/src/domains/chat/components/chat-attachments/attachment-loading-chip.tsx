
import { Loader2, X } from "lucide-react";
import type { FC } from "react";

import { Button } from "@vellumai/design-library";

import { formatAttachmentSize, middleTruncate } from "@/domains/chat/components/chat-attachments/utils";

interface AttachmentLoadingChipProps {
  localId: string;
  filename: string;
  sizeBytes: number;
  onCancel: (localId: string) => void;
}

export const AttachmentLoadingChip: FC<AttachmentLoadingChipProps> = ({
  localId,
  filename,
  sizeBytes,
  onCancel,
}) => {
  const displayName = middleTruncate(filename);
  const displaySize = formatAttachmentSize(sizeBytes);

  return (
    <div
      className="flex shrink-0 items-center gap-3 rounded-lg bg-[var(--surface-base)] py-1 pl-1 pr-2"
      title={`Uploading ${filename}`}
    >
      <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-[var(--surface-lift)] text-[var(--content-tertiary)]">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
      <div className="flex min-w-0 max-w-[156px] flex-col gap-1">
        <span className="truncate text-body-small-default text-[var(--content-secondary)]">
          {displayName}
        </span>
        <span className="truncate text-label-small-default text-[var(--content-tertiary)]">
          {displaySize}
        </span>
      </div>
      <div className="h-8 w-px shrink-0 bg-[var(--border-disabled)]" />
      <Button
        variant="ghost"
        size="compact"
        expandOnMobile={false}
        iconOnly={<X />}
        onClick={() => onCancel(localId)}
        aria-label={`Cancel upload of ${filename}`}
      />
    </div>
  );
};
