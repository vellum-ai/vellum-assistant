import { Check, Sparkles } from "lucide-react";
import { useState } from "react";

import { Button } from "@vellumai/design-library";

import { useTranslation } from "@/i18n";

import { AssistantInboxShell } from "./assistant-inbox-shell";
import { EmailAddressFields } from "./email-address-fields";
import { InboxCard } from "./inbox-card";
import { InboxCreatures } from "./inbox-creatures";

export interface AssistantInboxUpgradeStateProps {
  assistantName: string;
  /** The handle the user already chose; prefilled and still editable here. */
  handle: string;
  rootDomain: string;
  onUpgrade: (draft: { prefix: string; handle: string }) => void;
  onSeePlans?: () => void;
}

/**
 * The inbox on a plan without managed email. The card sells the inbox in
 * three lines, but the address builder is live: the handle is prefilled with
 * what the user already set and stays editable, so upgrading lands on an
 * address they have already looked at rather than a form to fill in.
 */
export function AssistantInboxUpgradeState({
  assistantName,
  handle: initialHandle,
  rootDomain,
  onUpgrade,
  onSeePlans,
}: AssistantInboxUpgradeStateProps) {
  const { t } = useTranslation("assistant-inbox");
  const [prefix, setPrefix] = useState("hi");
  const [handle, setHandle] = useState(initialHandle);

  const perks = [
    t("assistantInboxUpgradeState.perkAddress", { rootDomain }),
    t("assistantInboxUpgradeState.perkReads", { name: assistantName }),
    t("assistantInboxUpgradeState.perkHistory"),
  ];

  return (
    <AssistantInboxShell>
      <div className="flex flex-1 items-center justify-center overflow-y-auto p-6">
        <InboxCard
          title={t("assistantInboxUpgradeState.title", {
            name: assistantName,
          })}
          subtitle={t("assistantInboxUpgradeState.subtitle")}
          decoration={<InboxCreatures variant="around" />}
          footer={
            <>
              {onSeePlans ? (
                <Button variant="outlined" onClick={onSeePlans}>
                  {t("assistantInboxUpgradeState.seePlans")}
                </Button>
              ) : null}
              <Button
                variant="primary"
                leftIcon={<Sparkles />}
                disabled={!handle}
                onClick={() => onUpgrade({ prefix, handle })}
              >
                {t("assistantInboxUpgradeState.upgradeButton")}
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
              onHandleChange={setHandle}
            />
            <p className="text-body-small-lighter text-[var(--content-tertiary)]">
              {t("assistantInboxUpgradeState.handleHint", {
                name: assistantName,
              })}
            </p>
          </div>

          <ul className="flex flex-col gap-2 rounded-xl bg-[var(--surface-sunken)] p-4">
            {perks.map((perk) => (
              <li
                key={perk}
                className="flex items-center gap-2.5 text-body-small-lighter text-[var(--content-default)]"
              >
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--system-positive-weak)]">
                  <Check
                    className="size-3 text-[var(--system-positive-strong)]"
                    aria-hidden="true"
                  />
                </span>
                {perk}
              </li>
            ))}
          </ul>
        </InboxCard>
      </div>
    </AssistantInboxShell>
  );
}
