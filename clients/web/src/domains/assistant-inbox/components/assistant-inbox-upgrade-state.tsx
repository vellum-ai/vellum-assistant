import { Check, Sparkles } from "lucide-react";
import { useMemo, type CSSProperties } from "react";

import { Button, panelItemWashStyle } from "@vellumai/design-library";

import {
  PeekingEyes,
  type PeekingEyeArt,
} from "@/components/avatar/peeking-eyes";
import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { useElementSize } from "@/hooks/use-element-size";
import { useTranslation } from "@/i18n";
import { resolveEffectiveTraits } from "@/utils/avatar-render";
import { pathBBox, unionBBox } from "@/utils/eye-bbox";

import { AssistantInboxShell } from "./assistant-inbox-shell";
import { InboxCard } from "./inbox-card";

export interface AssistantInboxUpgradeStateProps {
  /** Whose inbox this would be; the pitch wears their accent and their eyes. */
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
 * the New Chat pill wears, with the assistant's eyes looking up over its
 * bottom edge: the plan is about giving this assistant an inbox, so the
 * assistant is in the picture. The checks are the accent itself rather than
 * a system green, so the panel reads as one colour, and the eyes hold still
 * rather than follow the cursor, since this is a form and not a stage.
 * Without a character avatar the panel falls back to the plain sunken
 * surface and no eyes.
 */
export function AssistantInboxUpgradeState({
  assistantId,
  assistantName,
  rootDomain,
  onUpgrade,
  onSeePlans,
}: AssistantInboxUpgradeStateProps) {
  const { t } = useTranslation("assistant-inbox");
  const { components, traits, accentHex } = useAssistantAvatar(assistantId);
  const { ref: panelRef, size: panelSize } = useElementSize();

  const eyeArt = useMemo<PeekingEyeArt | null>(() => {
    const effective = resolveEffectiveTraits(components, traits);
    const def = components?.eyeStyles.find(
      (eye) => eye.id === effective?.eyeStyle,
    );
    if (!def) {
      return null;
    }
    return {
      paths: def.paths,
      bbox: unionBBox(def.paths.map((p) => pathBBox(p.svgPath))),
    };
  }, [components, traits]);

  /* The same wash the New Chat pill and the inbox entry wear, so the panel
     reads as this assistant's surface and the ink stays the page's own. */
  const wash = accentHex ? panelItemWashStyle(accentHex) : null;
  const panelStyle: CSSProperties = wash
    ? { backgroundColor: String(wash["--panel-item-bg"]) }
    : {};
  /* The check in the accent itself, on the wash's raised step, so it reads
     as part of the panel rather than as a system-green stamp on it. */
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
          <div
            ref={panelRef}
            className={
              eyeArt
                ? "relative overflow-hidden rounded-xl bg-[var(--surface-sunken)] px-4 pt-4 pb-16"
                : "relative overflow-hidden rounded-xl bg-[var(--surface-sunken)] p-4"
            }
            style={panelStyle}
          >
            <ul className="relative flex flex-col gap-2">
              {perks.map((perk) => (
                <li
                  key={perk}
                  className="flex items-center gap-2.5 text-body-small-lighter"
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
            {eyeArt ? (
              <PeekingEyes
                art={eyeArt}
                stage={panelSize}
                followCursor={false}
              />
            ) : null}
          </div>
        </InboxCard>
      </div>
    </AssistantInboxShell>
  );
}
