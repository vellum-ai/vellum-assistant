import { Check, Sparkles } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";

import { Button, cn } from "@vellumai/design-library";

import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { useTranslation } from "@/i18n";

import { AddressPill } from "./address-pill";

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
 * it: the address the upgrade would create drawn as the assistant, three
 * perks, and the way to the plan. Title-less on purpose, so the inbox's
 * upgrade card can set it under its serif heading and the Channels page can
 * set it under the Email section's own header, and the two still say the
 * same thing the same way.
 *
 * The perks are a plain list on the surface they are given: the card and
 * the Channels section are containers already, and a tinted panel inside
 * either is one too many. The assistant's accent shows on the checks
 * instead, in place of a system green. Without a character avatar they fall
 * back to the neutral ink.
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
  const { accentHex } = useAssistantAvatar(assistantId);
  const centred = align === "center";

  const checkStyle: CSSProperties = accentHex
    ? { color: accentHex }
    : { color: "var(--content-secondary)" };
  const checkDiscStyle: CSSProperties = accentHex
    ? { backgroundColor: `color-mix(in oklab, ${accentHex} 22%, transparent)` }
    : { backgroundColor: "var(--surface-active)" };

  const perks = [
    t("assistantInboxUpgradeState.perkAddress", { rootDomain }),
    assistantName
      ? t("assistantInboxUpgradeState.perkReads", { name: assistantName })
      : t("assistantInboxUpgradeState.perkReadsNoName"),
    t("assistantInboxUpgradeState.perkHistory"),
  ];

  return (
    <div
      className={cn(
        "flex flex-col gap-6",
        centred ? "items-center" : "items-start",
      )}
    >
      {/* The address the upgrade would create, drawn as the assistant so
          the pitch shows the thing itself rather than describing it. */}
      {handle ? (
        <div
          className={cn(
            "flex max-w-full flex-col gap-1.5",
            centred ? "items-center" : "items-start",
          )}
        >
          <AddressPill
            assistantId={assistantId}
            address={`${t("emailAddressFields.prefixPlaceholder")}@${handle}.${rootDomain}`}
          />
          {onEditHandle ? (
            <button
              type="button"
              onClick={onEditHandle}
              className={cn(
                "cursor-pointer rounded px-1 text-body-small-lighter text-[var(--content-tertiary)] underline decoration-[var(--border-element)] underline-offset-2",
                "transition-colors duration-150 hover:text-[var(--content-default)]",
                "outline-none keyboard-focus:ring-2 keyboard-focus:ring-[var(--ring)]",
              )}
            >
              {t("assistantInboxUpgradeState.changeHandle")}
            </button>
          ) : null}
        </div>
      ) : null}
      <ul className="flex max-w-full flex-col gap-3">
        {perks.map((perk) => (
          <li
            key={perk}
            className="flex items-center gap-3 text-body-medium-lighter text-[var(--content-default)]"
          >
            <span
              className="flex size-6 shrink-0 items-center justify-center rounded-full"
              style={checkDiscStyle}
            >
              <Check
                className="size-3.5"
                strokeWidth={2.5}
                style={checkStyle}
                aria-hidden="true"
              />
            </span>
            {perk}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        {onSeePlans ? (
          <Button variant="outlined" onClick={onSeePlans}>
            {t("assistantInboxUpgradeState.seePlans")}
          </Button>
        ) : null}
        <Button variant="primary" leftIcon={<Sparkles />} onClick={onUpgrade}>
          {t("assistantInboxUpgradeState.upgradeButton")}
        </Button>
      </div>
      {footnote}
    </div>
  );
}
