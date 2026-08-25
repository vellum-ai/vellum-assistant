import type { ReactNode } from "react";

import { Download, ExternalLink } from "lucide-react";
import { Button, Typography } from "@vellumai/design-library";

import { formatAttachmentSize } from "@/domains/chat/components/chat-attachments/utils";
import {
  LocalFileIcon,
  localFileKindFromFilename,
} from "@/domains/chat/components/local-file/local-file-icon";
import { useTranslation } from "@/i18n";

/** Shown for a file no reader covers, whatever its format. */
const PREVIEW_UNSUPPORTED_MESSAGE = "No preview for this file type";

interface PreviewUnsupportedProps {
  filename: string;
  sizeBytes: number | null;
  onOpenInWorkspace: () => void;
  onDownload: () => void;
}

/**
 * Drawer state for a format with no reader. The drawer still opens: naming the
 * file and offering the two ways on from it keeps the reader in the
 * conversation, where being sent to the workspace browser for an archive would
 * have cost them their place.
 */
export function PreviewUnsupported({
  filename,
  sizeBytes,
  onOpenInWorkspace,
  onDownload,
}: PreviewUnsupportedProps): ReactNode {
  const { t } = useTranslation("chat");
  return (
    <div
      role="status"
      className="flex flex-col items-start gap-3 rounded-lg border border-[var(--border-element)] bg-[var(--surface-lift)] p-3"
    >
      <span className="flex min-w-0 max-w-full items-center gap-2.5">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[var(--surface-sunken)] text-[var(--content-secondary)]">
          <LocalFileIcon
            kind={localFileKindFromFilename(filename)}
            filename={filename}
            className="h-4 w-4"
          />
        </span>
        <span className="flex min-w-0 flex-col">
          <Typography
            as="span"
            variant="body-small-default"
            className="truncate text-[var(--content-default)]"
          >
            {filename}
          </Typography>
          {sizeBytes !== null && (
            <Typography
              as="span"
              variant="label-small-default"
              className="text-[var(--content-tertiary)]"
            >
              {formatAttachmentSize(sizeBytes)}
            </Typography>
          )}
        </span>
      </span>
      <Typography
        as="span"
        variant="body-small-default"
        className="text-[var(--content-tertiary)]"
      >
        {PREVIEW_UNSUPPORTED_MESSAGE}
      </Typography>
      <span className="flex flex-wrap items-center gap-2">
        <Button
          variant="outlined"
          size="compact"
          leftIcon={<ExternalLink />}
          onClick={onOpenInWorkspace}
        >
          {t("previewUnsupported.goToFile")}
        </Button>
        <Button
          variant="outlined"
          size="compact"
          leftIcon={<Download />}
          onClick={onDownload}
        >
          {t("previewUnsupported.downloadFile")}
        </Button>
      </span>
    </div>
  );
}
