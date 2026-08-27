import type { ReactNode } from "react";

import { Skeleton } from "@vellumai/design-library/components/skeleton";

import { useTranslation } from "@/i18n";

/**
 * Width/height of a US Letter page, used until the document reports its own.
 * A placeholder is drawn before `getDocument` resolves, which is the only
 * point the real page dimensions become available, so some ratio has to be
 * assumed: the two common paper sizes (Letter 0.77, A4 0.71) are close enough
 * that either reserves nearly the right space for the other.
 */
const DEFAULT_PAGE_ASPECT_RATIO = 8.5 / 11;

interface PdfPageSkeletonProps {
  /**
   * Width/height of the document's first page when known. The placeholder
   * holds the shape the rendered page will occupy, so the transition to
   * canvases moves nothing.
   */
  aspectRatio?: number;
  /**
   * Width constraint, which the caller owns because the same placeholder
   * stands in for pages at very different sizes: the chat column and the
   * fullscreen modal cap a viewport-relative width, while the document
   * drawer is a few hundred pixels wide and its pages fill it.
   */
  className?: string;
}

/** Page-shaped placeholder for a PDF that is being fetched and parsed. */
export function PdfPageSkeleton({
  aspectRatio,
  className,
}: PdfPageSkeletonProps): ReactNode {
  const { t } = useTranslation("chat");
  return (
    <Skeleton
      as="span"
      role="status"
      aria-label={t("pdfPageSkeleton.loadingPdf")}
      className={`block rounded ${className ?? "w-full"}`}
      style={{ aspectRatio: aspectRatio ?? DEFAULT_PAGE_ASPECT_RATIO }}
    />
  );
}
