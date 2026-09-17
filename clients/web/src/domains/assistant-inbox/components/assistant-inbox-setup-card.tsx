import { useState } from "react";

import { Button } from "@vellumai/design-library";

import { useTranslation } from "@/i18n";

import { AddressPill } from "./address-pill";
import { AssistantInboxShell } from "./assistant-inbox-shell";
import { EmailAddressFields } from "./email-address-fields";
import { InboxCard } from "./inbox-card";

export interface AssistantInboxSetupCardProps {
  /** Whose address this creates; the preview pill shows their avatar. */
  assistantId: string;
  /** The assistant's handle, set during onboarding; shown, not edited. */
  handle: string;
  rootDomain: string;
  onConfirm: (draft: { prefix: string }) => void;
  /** The registration is in flight; the action holds. */
  busy?: boolean;
}

/**
 * The inbox on an entitled plan with no address yet. One decision is left,
 * the local part of the address, because onboarding already fixed the
 * handle, so that is the one field: the handle and domain read as text
 * after the `@`. Beneath it the address the field will produce is drawn as
 * the identity pill, so the preview reads as the assistant, not as a
 * caption. There is one way out, forward: skipping would leave the inbox
 * with nothing to show.
 */
export function AssistantInboxSetupCard({
  assistantId,
  handle,
  rootDomain,
  onConfirm,
  busy = false,
}: AssistantInboxSetupCardProps) {
  const { t } = useTranslation("assistant-inbox");
  const [prefix, setPrefix] = useState("hi");
  const previewPrefix = prefix || t("emailAddressFields.prefixPlaceholder");

  return (
    <AssistantInboxShell>
      <div className="flex flex-1 items-center justify-center overflow-y-auto p-6">
        <InboxCard
          title={t("assistantInboxSetupCard.title")}
          subtitle={t("assistantInboxSetupCard.subtitle")}
          footerAlign="center"
          footer={
            <Button
              variant="primary"
              disabled={!prefix || busy}
              onClick={() => onConfirm({ prefix })}
            >
              {t("assistantInboxSetupCard.getStarted")}
            </Button>
          }
        >
          <div className="flex flex-col items-center gap-4">
            <EmailAddressFields
              prefix={prefix}
              handle={handle}
              rootDomain={rootDomain}
              onPrefixChange={setPrefix}
              disabled={busy}
              autoFocus
            />
            <AddressPill
              assistantId={assistantId}
              address={`${previewPrefix}@${handle}.${rootDomain}`}
            />
          </div>
        </InboxCard>
      </div>
    </AssistantInboxShell>
  );
}
