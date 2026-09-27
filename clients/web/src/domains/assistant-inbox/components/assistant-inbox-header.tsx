import { Settings } from "lucide-react";

import { Button } from "@vellumai/design-library";

import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { useTranslation } from "@/i18n";

import { AddressPill } from "./address-pill";

export interface AssistantInboxHeaderProps {
  assistantId: string;
  address: string;
  /** Opens the email settings. Without it no settings control is drawn. */
  onOpenSettings?: () => void;
}

/**
 * The inbox masthead: the page's name on the leading edge, and on the
 * trailing edge the address as the identity pill with the settings control
 * beside it. The pill is the copy control, so the address is one click to
 * take anywhere.
 */
export function AssistantInboxHeader({
  assistantId,
  address,
  onOpenSettings,
}: AssistantInboxHeaderProps) {
  const { t } = useTranslation("assistant-inbox");
  const { copied, copy } = useCopyToClipboard({
    errorMessage: t("addressPill.copyFailed"),
  });

  return (
    <header
      data-testid="assistant-inbox-header"
      className="flex flex-wrap items-start gap-4 px-2 pb-4 pt-2"
    >
      <h1 className="min-w-0 flex-1 truncate text-title-large text-[var(--content-emphasised)]">
        {t("assistantInboxHeader.title")}
      </h1>

      {/* The address and the day's counts stack on the trailing edge, so the
          title keeps the leading edge to itself and the masthead stays two
          lines tall. */}
      <div className="flex shrink-0 items-center gap-2">
        <AddressPill
          assistantId={assistantId}
          address={address}
          copy={{ copied, onCopy: () => copy(address) }}
        />
        {onOpenSettings ? (
          <Button
            variant="outlined"
            iconOnly={<Settings />}
            onClick={onOpenSettings}
            aria-label={t("assistantInboxHeader.settingsAria")}
            title={t("assistantInboxHeader.settingsAria")}
          />
        ) : null}
      </div>
    </header>
  );
}
