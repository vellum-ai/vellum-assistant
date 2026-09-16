import { Check, Sparkles } from "lucide-react";
import type { CSSProperties } from "react";

import { Button, panelItemWashStyle } from "@vellumai/design-library";

import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { useTranslation } from "@/i18n";

import { AssistantInboxShell } from "./assistant-inbox-shell";
import { InboxCard } from "./inbox-card";

export interface AssistantInboxUpgradeStateProps {
  /** Whose inbox this would be; the pitch wears their accent. */
  assistantId: string;
  assistantName: string;
  rootDomain: string;
  onUpgrade: () => void;
  onSeePlans?: () => void;
}

/**
 * The inbox on a plan without managed email: the pitch and the way to the
 * plan that includes it, nothing else. The handle was fixed at onboarding
 * and the prefix is asked for after the upgrade, so no field belongs here.
 *
 * The perks sit on a panel washed in the assistant's accent, the same wash
 * the New Chat pill wears, with the checks in the accent itself rather than
 * a system green, so the panel reads as one colour. Without a character
 * avatar the panel falls back to the plain sunken surface.
 */
export function AssistantInboxUpgradeState({
  assistantId,
  assistantName,
  rootDomain,
  onUpgrade,
  onSeePlans,
}: AssistantInboxUpgradeStateProps) {
  const { t } = useTranslation("assistant-inbox");
  const { accentHex } = useAssistantAvatar(assistantId);

  const wash = accentHex ? panelItemWashStyle(accentHex) : null;
  const panelStyle: CSSProperties = wash
    ? { backgroundColor: String(wash["--panel-item-bg"]) }
    : {};
  const checkStyle: CSSProperties = accentHex
    ? { color: accentHex }
    : { color: "var(--content-secondary)" };
  const checkDiscStyle: CSSProperties = wash
    ? { backgroundColor: String(wash["--panel-item-hover"]) }
    : { backgroundColor: "var(--surface-active)" };

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
          <ul
            className="flex flex-col gap-2 rounded-xl bg-[var(--surface-sunken)] p-4"
            style={panelStyle}
          >
            {perks.map((perk) => (
              <li
                key={perk}
                className="flex items-center gap-2.5 text-body-small-lighter text-[var(--content-default)]"
              >
                <span
                  className="flex size-5 shrink-0 items-center justify-center rounded-full"
                  style={checkDiscStyle}
                >
                  <Check
                    className="size-3"
                    style={checkStyle}
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
