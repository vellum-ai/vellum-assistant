import { Check, Zap } from "lucide-react";
import type { ReactNode } from "react";

import { Button, cn } from "@vellumai/design-library";

import { useTranslation } from "@/i18n";

export interface AssistantInboxUpgradeBodyProps {
  /** Whose inbox this would be; the pitch wears their accent. */
  assistantId: string;
  /** Empty when the assistant has no name yet; the copy then says "your assistant". */
  assistantName: string;
  /**
   * The handle set at onboarding, so the example address is the real one.
   * Empty when it is not known, in which case the example is left out rather
   * than drawn with a hole in it.
   */
  handle: string;
  rootDomain: string;
  /**
   * Opens the handle modal. Present, it puts a fine-print "Change handle"
   * under the example address, for a reader who would want the address on a
   * different name before paying for it.
   */
  onEditHandle?: () => void;
  onUpgrade: () => void;
  onSeePlans?: () => void;
  /** Sits under the actions: the Channels page's "add it back" control. */
  footnote?: ReactNode;
  /**
   * Which axis the pieces sit on. Centred under a centred card title; at the
   * start under a section header that is itself set at the start.
   */
  align?: "center" | "start";
}

/**
 * The pitch for a plan with managed email, below whatever title introduces
 * it, as the design draws it: three perks as pill rows with a green check,
 * then a notice that says the plan has no email, with the way to the plans
 * and the upgrade. Title-less on purpose, so the inbox's upgrade page can
 * set it under its serif heading and the Channels page can set it under
 * the Email section's own header, and the two still say the same thing the
 * same way.
 */
export function AssistantInboxUpgradeBody({
  assistantId,
  assistantName,
  handle,
  rootDomain,
  onEditHandle,
  onUpgrade,
  onSeePlans,
  footnote,
  align = "center",
}: AssistantInboxUpgradeBodyProps) {
  const { t } = useTranslation("assistant-inbox");
  const centred = align === "center";

  const perks = [
    t("assistantInboxUpgradeState.perkAddress", { rootDomain }),
    assistantName
      ? t("assistantInboxUpgradeState.perkReads", { name: assistantName })
      : t("assistantInboxUpgradeState.perkReadsNoName"),
    t("assistantInboxUpgradeState.perkHistory"),
  ];

  return (
    <div
      data-assistant-id={assistantId}
      className={cn(
        "flex w-full max-w-[360px] flex-col gap-6",
        centred ? "items-center" : "items-start",
      )}
    >
      <ul className="flex w-full flex-col gap-1">
        {perks.map((perk) => (
          <li
            key={perk}
            className="flex items-center gap-2 rounded-full bg-[color-mix(in_srgb,var(--content-default)_6%,transparent)] py-[5px] pl-1 pr-3 text-label-medium-default text-[var(--content-secondary)]"
          >
            <Check
              className="size-4 shrink-0 text-[var(--system-positive-strong)]"
              strokeWidth={2.5}
              aria-hidden="true"
            />
            {perk}
          </li>
        ))}
      </ul>
      {handle && onEditHandle ? (
        <button
          type="button"
          onClick={onEditHandle}
          className={cn(
            "-mt-3 cursor-pointer rounded px-1 text-body-small-lighter text-[var(--content-tertiary)] underline decoration-[var(--border-element)] underline-offset-2",
            "transition-colors duration-150 hover:text-[var(--content-default)]",
            "outline-none keyboard-focus:ring-2 keyboard-focus:ring-[var(--ring)]",
          )}
        >
          {t("assistantInboxUpgradeState.changeHandle", {
            address: `${t("emailAddressFields.prefixPlaceholder")}@${handle}.${rootDomain}`,
          })}
        </button>
      ) : null}
      <div
        className={cn(
          "flex w-full flex-col gap-4 rounded-lg bg-[color-mix(in_srgb,var(--content-default)_4%,transparent)] p-3",
          centred ? "items-center text-center" : "items-start",
        )}
      >
        <p className="text-label-medium-default leading-[15px] text-[var(--content-secondary)]">
          {t("assistantInboxUpgradeState.planNotice")}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {onSeePlans ? (
            <Button variant="outlined" onClick={onSeePlans}>
              {t("assistantInboxUpgradeState.seePlans")}
            </Button>
          ) : null}
          <Button variant="primary" leftIcon={<Zap />} onClick={onUpgrade}>
            {t("assistantInboxUpgradeState.upgradeButton")}
          </Button>
        </div>
      </div>
      {footnote}
    </div>
  );
}
