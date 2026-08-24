import type { ReactNode } from "react";

import { Skeleton } from "@vellumai/design-library/components/skeleton";
import { useTranslation } from "@/i18n";

/** Relative widths of the placeholder lines, so the block reads as prose. */
const LINE_WIDTHS = ["w-2/5", "w-full", "w-11/12", "w-4/5", "w-3/4"];

/** Placeholder shown while a file is being fetched and parsed for preview. */
export function PreviewSkeleton(): ReactNode {
  const { t } = useTranslation("chat");
  return (
    <div
      role="status"
      aria-label={t("previewSkeleton.loadingPreview")}
      className="flex flex-col gap-3 p-1"
    >
      {LINE_WIDTHS.map((width) => (
        <Skeleton as="span" key={width} className={`h-4 ${width}`} />
      ))}
    </div>
  );
}
