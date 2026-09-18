import { Check, Sparkles } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";

import { Button, cn, panelItemWashStyle } from "@vellumai/design-library";

import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { useTranslation } from "@/i18n";

import type { HandleClaimIo } from "../types";
import { HandleClaim } from "./handle-claim";

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
   * The handle calls, which put "claim your handle" beside the example
   * address. Left out, the address is an example and nothing more.
   */
  claim?: HandleClaimIo | null;
  onUpgrade: () => void;
  onSeePlans?: () => void;
  /** Sits under the actions: the Channels page's "add it back" control. */
  footnote?: ReactNode;
  /**
   * Which axis the pieces sit on. Centred under a centred card title; at the
   * start under a section header that is itself set at the start.
   */
  align?: "center" | "start";
  /**
   * Draw the perks as a plain list, without the accent-washed panel behind
   * them. For a surface that is already a card: a tinted panel inside it is
   * one container too many, and the accent still shows on the checks.
   */
  plainPerks?: boolean;
}

/**
 * The pitch for a plan with managed email, below whatever title introduces
 * it: the address the upgrade would create drawn as the assistant, three
 * perks, and the way to the plan. Title-less on purpose, so the inbox's
 * upgrade card can set it under its serif heading and the Channels page can
 * set it under the Email section's own header, and the two still say the
 * same thing the same way.
 *
 * The perks sit on a panel washed in the assistant's accent, the same wash
 * the New Chat pill wears, with the checks in the accent itself rather than
 * a system green, so the panel reads as one colour. Without a character
 * avatar the panel falls back to the plain sunken surface.
 */
export function AssistantInboxUpgradeBody({
  assistantId,
  assistantName,
  handle,
  rootDomain,
  claim,
  onUpgrade,
  onSeePlans,
  footnote,
  align = "center",
  plainPerks = false,
}: AssistantInboxUpgradeBodyProps) {
  const { t } = useTranslation("assistant-inbox");
  const { accentHex } = useAssistantAvatar(assistantId);
  const centred = align === "center";

  const wash = accentHex ? panelItemWashStyle(accentHex) : null;
  const panelStyle: CSSProperties = wash
    ? { backgroundColor: String(wash["--panel-item-bg"]) }
    : {};
  const checkStyle: CSSProperties = accentHex
    ? { color: accentHex }
    : { color: "var(--content-secondary)" };
  /* A firmer step than the panel's hover mix, which is a shade the eye
     cannot pick out of the wash it sits on. */
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
          the pitch shows the thing itself rather than describing it, with
          the way to claim the handle it is built on. */}
      {handle || claim ? (
        <HandleClaim
          assistantId={assistantId}
          handle={handle}
          rootDomain={rootDomain}
          claim={claim}
          align={align}
        />
      ) : null}
      {/* Shrink-wrapped, so the panel sits on the same axis as the rest
          rather than spanning the width with its rows hanging off one edge. */}
      <ul
        className={cn(
          "flex w-fit max-w-full flex-col gap-3",
          !plainPerks && "rounded-2xl bg-[var(--surface-sunken)] px-6 py-5",
        )}
        style={plainPerks ? undefined : panelStyle}
      >
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
