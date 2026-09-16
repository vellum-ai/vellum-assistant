import { useState } from "react";

import { Button } from "@vellumai/design-library";

import { useTranslation } from "@/i18n";

import { AssistantInboxShell } from "./assistant-inbox-shell";
import { EmailAddressFields } from "./email-address-fields";
import { InboxCard } from "./inbox-card";

export interface AssistantInboxSetupCardProps {
  /** The assistant's handle, set during onboarding; shown, not edited. */
  handle: string;
  rootDomain: string;
  onNext: (draft: { prefix: string }) => void;
  onSkip: () => void;
  /** The registration is in flight; both actions hold. */
  busy?: boolean;
}

/**
 * The inbox on an entitled plan with no address yet. One decision is left,
 * the local part of the address, because onboarding already fixed the
 * handle, so that is the one field here: the handle and domain read as
 * text after the `@`. No creatures; the card is a form, and it should be
 * as quiet as one.
 */
export function AssistantInboxSetupCard({
  handle,
  rootDomain,
  onNext,
  onSkip,
  busy = false,
}: AssistantInboxSetupCardProps) {
  const { t } = useTranslation("assistant-inbox");
  const [prefix, setPrefix] = useState("hi");

  return (
    <AssistantInboxShell>
      <div className="flex flex-1 items-center justify-center overflow-y-auto p-6">
        <InboxCard
          title={t("assistantInboxSetupCard.title")}
          subtitle={t("assistantInboxSetupCard.subtitle")}
          footer={
            <>
              <Button variant="outlined" disabled={busy} onClick={onSkip}>
                {t("assistantInboxSetupCard.skip")}
              </Button>
              <Button
                variant="primary"
                disabled={!prefix || busy}
                onClick={() => onNext({ prefix })}
              >
                {t("assistantInboxSetupCard.next")}
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-2">
            <EmailAddressFields
              prefix={prefix}
              handle={handle}
              rootDomain={rootDomain}
              onPrefixChange={setPrefix}
              disabled={busy}
              autoFocus
            />
            <p className="text-body-small-lighter text-[var(--content-tertiary)]">
              {t("assistantInboxSetupCard.addressPreview", {
                address: `${prefix || "hi"}@${handle}.${rootDomain}`,
              })}
            </p>
          </div>
        </InboxCard>
      </div>
    </AssistantInboxShell>
  );
}
