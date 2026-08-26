import { ChevronLeft, ChevronRight } from "lucide-react";

import { useTranslation } from "@/i18n";

export interface TraitCycleRowProps {
  label: string;
  value: string;
  colorHex?: string;
  onPrev: () => void;
  onNext: () => void;
}

/**
 * Boxed row that steps one avatar trait back and forth, with the current value
 * (and, for colors, its swatch) centered between the two chevrons. The
 * chevrons are labelled from the `avatarManagementModal.previous` and `.next`
 * keys, which take the row's own label, lowercased, as their argument.
 */
export function TraitCycleRow({
  label,
  value,
  colorHex,
  onPrev,
  onNext,
}: TraitCycleRowProps) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-between rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-lift)] px-3 py-2">
      <span className="text-body-small-default uppercase tracking-wider text-[var(--content-quiet)]">
        {label}
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onPrev}
          aria-label={t("avatarManagementModal.previous", {
            label: label.toLowerCase(),
          })}
          className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-[var(--content-quiet)] transition-colors hover:bg-[var(--surface-active)]"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <div className="flex min-w-[80px] items-center justify-center gap-2">
          {colorHex && (
            <div
              className="h-4 w-4 rounded-full border border-[var(--border-element)]"
              style={{ backgroundColor: colorHex }}
            />
          )}
          <span className="text-body-medium-default capitalize text-[var(--content-strong)]">
            {value}
          </span>
        </div>
        <button
          type="button"
          onClick={onNext}
          aria-label={t("avatarManagementModal.next", {
            label: label.toLowerCase(),
          })}
          className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-[var(--content-quiet)] transition-colors hover:bg-[var(--surface-active)]"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
