import { useState } from "react";

import { Button, Notice } from "@vellumai/design-library";

import { useTranslation } from "@/i18n";

import { AssistantInboxShell } from "./assistant-inbox-shell";
import { EmailAddressFields } from "./email-address-fields";
import { InboxCard } from "./inbox-card";
import { InboxCreatures } from "./inbox-creatures";

export interface AssistantInboxSetupCardProps {
  /** The assistant's handle, prefilled as the subdomain. */
  handle: string;
  rootDomain: string;
  onNext: (draft: { prefix: string; handle: string }) => void;
  onSkip: () => void;
  /** The registration is in flight; both actions hold. */
  busy?: boolean;
}

/**
 * The inbox on an entitled plan with no address yet: the email onboarding
 * card, drawn inline in the inbox's frame instead of over the billing page.
 * Same fields, same immutability warning, same Skip and Next, so a user who
 * skipped it at checkout meets the same card here.
 */
export function AssistantInboxSetupCard({
  handle: initialHandle,
  rootDomain,
  onNext,
  onSkip,
  busy = false,
}: AssistantInboxSetupCardProps) {
  const { t } = useTranslation("assistant-inbox");
  const [prefix, setPrefix] = useState("hi");
  const [handle, setHandle] = useState(initialHandle);

  return (
    <AssistantInboxShell>
      <div className="flex flex-1 items-center justify-center overflow-y-auto p-6">
        <InboxCard
          title={t("assistantInboxSetupCard.title")}
          subtitle={t("assistantInboxSetupCard.subtitle")}
          decoration={<InboxCreatures variant="top" />}
          footer={
            <>
              <Button variant="outlined" disabled={busy} onClick={onSkip}>
                {t("assistantInboxSetupCard.skip")}
              </Button>
              <Button
                variant="primary"
                disabled={!handle || busy}
                onClick={() => onNext({ prefix, handle })}
              >
                {t("assistantInboxSetupCard.next")}
              </Button>
            </>
          }
        >
          <EmailAddressFields
            prefix={prefix}
            handle={handle}
            rootDomain={rootDomain}
            onPrefixChange={setPrefix}
            onHandleChange={setHandle}
            disabled={busy}
            autoFocusHandle
          />
          <Notice
            tone="info"
            className="border-transparent bg-[var(--surface-active)]"
          >
            <span className="font-medium text-[var(--content-tertiary)]">
              {t("assistantInboxSetupCard.immutableNotice")}
            </span>
          </Notice>
        </InboxCard>
      </div>
    </AssistantInboxShell>
  );
}
