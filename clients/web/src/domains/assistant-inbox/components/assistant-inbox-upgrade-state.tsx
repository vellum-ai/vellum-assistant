import { Check, Sparkles } from "lucide-react";

import { Button } from "@vellumai/design-library";

import { useTranslation } from "@/i18n";

import { AssistantInboxShell } from "./assistant-inbox-shell";
import { InboxCard } from "./inbox-card";

export interface AssistantInboxUpgradeStateProps {
  assistantName: string;
  rootDomain: string;
  onUpgrade: () => void;
  onSeePlans?: () => void;
}

/**
 * The inbox on a plan without managed email: the pitch and the way to the
 * plan that includes it, nothing else. The handle was fixed at onboarding
 * and the prefix is asked for after the upgrade, so no field belongs here.
 */
export function AssistantInboxUpgradeState({
  assistantName,
  rootDomain,
  onUpgrade,
  onSeePlans,
}: AssistantInboxUpgradeStateProps) {
  const { t } = useTranslation("assistant-inbox");

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
          footerAlign="center"
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
                onClick={onUpgrade}
              >
                {t("assistantInboxUpgradeState.upgradeButton")}
              </Button>
            </>
          }
        >
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
