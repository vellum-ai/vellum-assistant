import type { ReactNode } from "react";

import { FileWarning } from "lucide-react";
import { Typography } from "@vellumai/design-library";

import { useTranslation } from "@/i18n";

interface PreviewErrorProps {
  filename: string;
}

/**
 * Compact failure state for a document preview. Deliberately says nothing
 * about which part of the read failed: the reader can still open the file with
 * its real application from the surrounding drawer.
 */
export function PreviewError({ filename }: PreviewErrorProps): ReactNode {
  const { t } = useTranslation("chat");
  return (
    <div
      role="status"
      className="flex items-center gap-2.5 rounded-lg border border-[var(--border-element)] bg-[var(--surface-lift)] p-3"
    >
      <FileWarning
        aria-hidden="true"
        className="h-4 w-4 shrink-0 text-[var(--content-tertiary)]"
      />
      <span className="flex min-w-0 flex-col">
        <Typography
          as="span"
          variant="body-small-default"
          className="text-[var(--content-default)]"
        >
          {t("previewError.cannotPreview")}
        </Typography>
        <Typography
          as="span"
          variant="label-small-default"
          className="truncate text-[var(--content-tertiary)]"
        >
          {filename}
        </Typography>
      </span>
    </div>
  );
}
