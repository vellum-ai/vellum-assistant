import { Skeleton } from "@vellumai/design-library/components/skeleton";

import { useTranslation } from "@/i18n";

/**
 * Stands in for an inline visual while the `ui_show` call that authors it is
 * still streaming.
 *
 * A visual replaces prose rather than annotating it, and its `ui_show` chip is
 * suppressed because the widget renders in the chip's place, so without this
 * the transcript shows nothing at all through the longest tool input the model
 * writes. The shimmer occupies roughly the space the widget will claim, so the
 * transcript settles instead of jumping when the surface arrives.
 */
export function VisualPlaceholder() {
  const { t } = useTranslation("chat");
  return (
    <Skeleton
      className="flex h-[120px] w-full items-center justify-center rounded-lg"
      role="status"
    >
      <span className="text-body-small-default text-[var(--content-quiet)]">
        {t("visualPlaceholder.sketching")}
      </span>
    </Skeleton>
  );
}
