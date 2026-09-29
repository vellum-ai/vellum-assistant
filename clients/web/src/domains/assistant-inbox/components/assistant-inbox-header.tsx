import { ArrowLeft, Settings } from "lucide-react";

import { Button, cn } from "@vellumai/design-library";

import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { useTranslation } from "@/i18n";

import { AddressPill } from "./address-pill";

export interface AssistantInboxHeaderProps {
  assistantId: string;
  address: string;
  /** Opens the email settings. Without it no settings control is drawn. */
  onOpenSettings?: () => void;
  /** Leaves the page. Without it no back control is drawn. */
  onBack?: () => void;
  className?: string;
}

/**
 * The inbox masthead: the way back and the page's name on the leading
 * edge, as the other inbox pages' frame draws them, and on the trailing
 * edge the address as the identity pill with the settings control beside
 * it. The pill is the copy control, so the address is one click to
 * take anywhere. Below `md` the pill takes a line of its own under the
 * title, so the name is never squeezed to an ellipsis to make room for
 * it, while the settings control keeps the title row's trailing corner.
 */
export function AssistantInboxHeader({
  assistantId,
  address,
  onOpenSettings,
  onBack,
  className,
}: AssistantInboxHeaderProps) {
  const { t } = useTranslation("assistant-inbox");
  const { copied, copy } = useCopyToClipboard({
    errorMessage: t("addressPill.copyFailed"),
  });

  return (
    <header
      data-testid="assistant-inbox-header"
      className={cn(
        "flex flex-wrap items-center gap-x-4 gap-y-3 px-2 pb-4 pt-2",
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {onBack ? (
          <Button
            variant="outlined"
            iconOnly={<ArrowLeft />}
            onClick={onBack}
            aria-label={t("assistantInboxHeader.back")}
            title={t("assistantInboxHeader.back")}
          />
        ) : null}
        <h1 className="min-w-0 truncate text-title-large text-[var(--content-emphasised)]">
          {t("assistantInboxHeader.title")}
        </h1>
      </div>

      {/* Below `md` the pill's wrapper spans the row and sorts last, which
          drops the pill under the title at its natural width; from `md` up
          it sits on the trailing edge beside the settings control. */}
      <div className="flex min-w-0 max-md:order-last max-md:basis-full">
        <AddressPill
          assistantId={assistantId}
          address={address}
          copy={{ copied, onCopy: () => copy(address) }}
        />
      </div>
      {onOpenSettings ? (
        <Button
          variant="outlined"
          iconOnly={<Settings />}
          onClick={onOpenSettings}
          aria-label={t("assistantInboxHeader.settingsAria")}
          title={t("assistantInboxHeader.settingsAria")}
          className="shrink-0"
        />
      ) : null}
    </header>
  );
}
