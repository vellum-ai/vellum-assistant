import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { useTranslation } from "@/i18n";

import type { InboxUsage } from "../types";
import { AddressPill } from "./address-pill";

export interface AssistantInboxHeaderProps {
  assistantId: string;
  assistantName: string;
  address: string;
  usage?: InboxUsage;
}

/**
 * The inbox masthead: whose inbox this is, with the line that says
 * what it holds on the leading edge, and on the trailing edge the address as
 * the identity pill over the day's counts. The pill is the copy control, so
 * the address is one click to take anywhere, and the counts keep the daily
 * send limit from being a surprise.
 */
export function AssistantInboxHeader({
  assistantId,
  assistantName,
  address,
  usage,
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
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <h1 className="min-w-0 truncate text-title-large text-[var(--content-emphasised)]">
          {t("assistantInboxHeader.title", { name: assistantName })}
        </h1>
        <p className="text-body-medium-lighter text-[var(--content-secondary)]">
          {t("assistantInboxHeader.subtitle")}
        </p>
      </div>

      {/* The address and the day's counts stack on the trailing edge, so the
          title keeps the leading edge to itself and the masthead stays two
          lines tall. */}
      <div className="flex shrink-0 flex-col items-end gap-2">
        <AddressPill
          assistantId={assistantId}
          address={address}
          copy={{ copied, onCopy: () => copy(address) }}
        />
        {usage ? (
          <p className="text-body-small-lighter text-[var(--content-tertiary)]">
            {t("assistantInboxHeader.usage", {
              sent: usage.sentToday,
              received: usage.receivedToday,
            })}
          </p>
        ) : null}
      </div>
    </header>
  );
}
